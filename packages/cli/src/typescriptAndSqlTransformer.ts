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
    types.use(
      { name: 'PreparedQuery', from: RUNTIME_MODULE },
      TypeScope.Return,
    );
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
  private readonly includePattern: string;
  private fileOverrideUsed = false;

  constructor(
    private readonly db: TypeDb,
    private readonly config: ParsedConfig,
    private readonly transform: TransformConfig,
  ) {
    this.includePattern = `${this.config.srcDir}/**/${transform.include}`;
  }

  private async watch() {
    const cb = async (fileName: string) => {
      return this.processFile(fileName);
    };

    chokidar
      .watch(this.config.srcDir, {
        persistent: true,
        ignored: (fileName, stats) =>
          !!stats?.isFile() && !minimatch(fileName, this.transform.include),
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
    let fileList = globSync(this.includePattern, {
      ...(this.transform.emitFileName && {
        ignore: [`${this.config.srcDir}${this.transform.emitFileName}`],
      }),
    });
    if (fileOverride) {
      fileList = fileList.includes(fileOverride) ? [fileOverride] : [];
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
