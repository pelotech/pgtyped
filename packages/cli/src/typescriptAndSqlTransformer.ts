import chokidar from 'chokidar';
import fs from 'fs-extra';
import { globSync } from 'glob';
import { minimatch } from 'minimatch';
import nun from 'nunjucks';
import path from 'path';
import { ParsedConfig, TransformConfig } from './config.js';
import type { TypeDb } from './db/type-db.js';
import {
  generateDeclarationFile,
  generateTypedecsFromFile,
} from './generator.js';
import { RUNTIME_MODULE } from './runtimeModule.js';
import { TypeAllocator, TypeMapping, TypeScope } from './types.js';
import { debug, mapConcurrent, MAX_CONCURRENCY } from './util.js';

// tslint:disable:no-console

// disable autoescape as it breaks windows paths
// see https://github.com/adelsz/pgtyped/issues/519 for details
nun.configure({ autoescape: false });

interface ExtendedParsedPath extends path.ParsedPath {
  dir_base: string;
}

/**
 * Anything under a `node_modules` directory, whatever the depth and whichever
 * separator the platform uses.
 *
 * A dependency that ships its own `.sql` files — or a `.bin` shim that happens
 * to match a recursive `.ts` include — is not this project's query source, and
 * parsing it is at best wasted describes and at worst a codegen error against
 * a schema it was never written for. `srcDir` pointing at a directory that
 * contains an installed tree is ordinary, so this is excluded unconditionally
 * rather than left to each project's include pattern (#534).
 */
export const NODE_MODULES_GLOB = '**/node_modules/**';

/** Whether `fileName` is inside a `node_modules` directory. */
export function isUnderNodeModules(fileName: string): boolean {
  return fileName.split(/[\\/]/).includes('node_modules');
}

/** The query files a transform applies to. */
export function findQueryFiles(
  srcDir: string,
  transform: TransformConfig,
): string[] {
  return globSync(`${srcDir}/**/${transform.include}`, {
    ignore: [
      NODE_MODULES_GLOB,
      ...(transform.emitFileName ? [`${srcDir}${transform.emitFileName}`] : []),
    ],
  });
}

/**
 * The entry of `fileList` naming the same file as `--file`, if any.
 *
 * This used to be `fileList.includes(fileOverride)` — raw string equality
 * against glob output — so exactly one spelling of the path worked. `./x.sql`,
 * an absolute path, and the Windows reporter's `multi\a\one.sql` all missed
 * and the run did nothing (#579). Resolving both sides against the working
 * directory compares files rather than strings, and lets the platform decide
 * what a separator is.
 *
 * The glob's own spelling is what is returned, so the paths that end up in the
 * log do not depend on how the flag was typed.
 */
export function matchFileOverride(
  fileList: string[],
  fileOverride: string,
): string | undefined {
  const target = path.resolve(fileOverride);
  return fileList.find((fileName) => path.resolve(fileName) === target);
}

export type ProcessFileResult =
  | {
      skipped: boolean;
      typeDecsLength: number;
      relativePath: string;
    }
  | {
      error: any;
      relativePath: string;
    };

async function getFileContents(fileName: string) {
  // last part fixes https://github.com/adelsz/pgtyped/issues/390
  const contents = await fs.readFile(fileName, { encoding: 'utf-8' });
  return contents.replace(/\r\n/g, '\n');
}

export async function getTypeDecs(
  db: TypeDb,
  config: ParsedConfig,
  transform: TransformConfig,
  fileName: string,
) {
  const contents = await getFileContents(fileName);
  const types = new TypeAllocator(TypeMapping(config.typesOverrides));

  if (transform.mode === 'sql') {
    // Second parameter has no effect here, we could have used any value
    types.use({ name: 'TypedQuery', from: RUNTIME_MODULE }, TypeScope.Return);
  }
  return await generateTypedecsFromFile(
    contents,
    fileName,
    db,
    transform,
    types,
    config,
  );
}

export async function processFile(
  db: TypeDb,
  config: ParsedConfig,
  transform: TransformConfig,
  fileName: string,
): Promise<ProcessFileResult> {
  const ppath = path.parse(fileName) as ExtendedParsedPath;
  ppath.dir_base = path.basename(ppath.dir);
  let decsFileName;
  if ('emitTemplate' in transform && transform.emitTemplate) {
    decsFileName = nun.renderString(transform.emitTemplate, ppath);
  } else {
    const suffix = transform.mode === 'ts' ? 'types.ts' : 'ts';
    decsFileName = path.resolve(ppath.dir, `${ppath.name}.${suffix}`);
  }

  let typeDecSet;
  try {
    typeDecSet = await getTypeDecs(db, config, transform, fileName);
  } catch (e) {
    return {
      error: e,
      relativePath: path.relative(process.cwd(), fileName),
    };
  }
  const relativePath = path.relative(process.cwd(), decsFileName);

  if (typeDecSet.typedQueries.length > 0) {
    const declarationFileContents = await generateDeclarationFile(typeDecSet);
    const oldDeclarationFileContents = (await fs.pathExists(decsFileName))
      ? await fs.readFile(decsFileName, { encoding: 'utf-8' })
      : null;
    if (oldDeclarationFileContents !== declarationFileContents) {
      await fs.outputFile(decsFileName, declarationFileContents);
      return {
        skipped: false,
        typeDecsLength: typeDecSet.typedQueries.length,
        relativePath,
      };
    }
  }
  return {
    skipped: true,
    typeDecsLength: 0,
    relativePath,
  };
}

export class TypescriptAndSqlTransformer {
  private fileOverrideUsed = false;

  constructor(
    private readonly db: TypeDb,
    private readonly config: ParsedConfig,
    private readonly transform: TransformConfig,
  ) {}

  private async watch() {
    const cb = async (fileName: string) => {
      return this.processFile(fileName);
    };

    chokidar
      .watch(this.config.srcDir, {
        persistent: true,
        // Returning true for the directory itself stops chokidar descending
        // into it at all, so an installed tree under srcDir costs neither
        // watch descriptors nor describes (#534).
        ignored: (fileName, stats) =>
          isUnderNodeModules(fileName) ||
          (!!stats?.isFile() && !minimatch(fileName, this.transform.include)),
      })
      .on('add', cb)
      .on('change', cb);
  }

  public async start(watch: boolean, fileOverride?: string) {
    if (watch) {
      return this.watch();
    }

    /**
     * If the user didn't provide the -f paramter, we're using the list of files we got from glob.
     * If he did, we're using glob file list to detect if his provided file should be used with this transform.
     */
    let fileList = findQueryFiles(this.config.srcDir, this.transform);
    if (fileList.length === 0) {
      // Running the CLI from another directory with an absolute `-c` path
      // produced no output whatsoever and exited 0, because `srcDir` is
      // resolved against the working directory rather than against the config
      // file and the glob simply matched nothing (#572). Say so, rather than
      // leaving a silent success to be discovered downstream.
      console.warn(
        `No files matched "${this.config.srcDir}/**/${this.transform.include}". ` +
          `srcDir is resolved against the working directory (${process.cwd()}), not against the config file.`,
      );
    }
    if (fileOverride) {
      const match = matchFileOverride(fileList, fileOverride);
      fileList = match ? [match] : [];
      if (fileList.length > 0) {
        this.fileOverrideUsed = true;
      }
    }
    debug('found query files %o', fileList);

    await mapConcurrent(fileList, MAX_CONCURRENCY, (fileName) =>
      this.processFile(fileName),
    );
    return this.fileOverrideUsed;
  }

  /**
   * Processes one file and reports the outcome. Errors are logged and
   * swallowed so one bad file does not abandon the rest; with failOnError set
   * they are rethrown, and main() shuts the pool down and exits non-zero. That
   * applies to an invalid query too, which arrives as a returned error rather
   * than a throw.
   */
  private async processFile(fileName: string) {
    fileName = path.relative(process.cwd(), fileName);
    console.log(`Processing ${fileName}`);

    let result: ProcessFileResult;
    try {
      result = await processFile(
        this.db,
        this.config,
        this.transform,
        fileName,
      );
    } catch (err) {
      console.log(
        `Error processing file: ${
          err instanceof Error ? err.stack : JSON.stringify(err)
        }`,
      );
      if (this.config.failOnError) {
        throw err;
      }
      return;
    }

    if ('skipped' in result && result.skipped) {
      console.log(`Skipped ${fileName}: no changes or no queries detected`);
    } else if ('error' in result) {
      console.error(
        `Error processing ${fileName}: ${result.error.message}\n${result.error.stack}`,
      );
      // An invalid query is reported as a returned error rather than a
      // throw, so failOnError has to be honoured here too. Without this it
      // fired only for failures outside type generation — never for the bad
      // query it exists to catch.
      if (this.config.failOnError) {
        throw result.error;
      }
    } else {
      console.log(
        `Saved ${result.typeDecsLength} query types from ${fileName} to ${result.relativePath}`,
      );
    }
  }
}
