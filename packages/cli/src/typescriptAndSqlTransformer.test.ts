import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { TransformConfig } from './config.js';
import type { TypeDb } from './db/type-db.js';
import { ParsedConfig } from './config.js';
import { SharedTypeRegistry } from './sharedTypes.js';
import {
  findQueryFiles,
  isUnderNodeModules,
  matchFileOverride,
  TypescriptAndSqlTransformer,
} from './typescriptAndSqlTransformer.js';

const sqlTransform = {
  mode: 'sql',
  include: '**/*.sql',
  emitTemplate: '{{dir}}/{{name}}.queries.ts',
} as TransformConfig;

/** A source tree with an installed dependency inside it, as #534 describes. */
function srcTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgtyped-discovery-'));
  const src = join(dir, 'src');
  mkdirSync(join(src, 'nested'), { recursive: true });
  writeFileSync(join(src, 'a.sql'), '/* @name A */\nSELECT 1;\n');
  writeFileSync(join(src, 'nested', 'b.sql'), '/* @name B */\nSELECT 1;\n');

  const dep = join(src, 'node_modules', 'somepkg');
  mkdirSync(join(dep, 'deep'), { recursive: true });
  writeFileSync(join(dep, 'c.sql'), '/* @name C */\nSELECT 1;\n');
  writeFileSync(join(dep, 'deep', 'd.sql'), '/* @name D */\nSELECT 1;\n');
  return src;
}

/**
 * `globSync` walked straight into an installed tree, so a dependency shipping
 * its own `.sql` files had every one of them described against this project's
 * schema. Upstream #534.
 */
describe('query file discovery', () => {
  test('files under node_modules are not query files', () => {
    const src = srcTree();

    const found = findQueryFiles(src, sqlTransform)
      .map((f) => relative(src, f).split(sep).join('/'))
      .sort();

    expect(found).toStrictEqual(['a.sql', 'nested/b.sql']);
  });

  test('an emitFileName is still excluded alongside node_modules', () => {
    const src = srcTree();
    writeFileSync(join(src, 'all.sql'), '/* @name All */\nSELECT 1;\n');

    const found = findQueryFiles(src, {
      ...sqlTransform,
      emitFileName: '/all.sql',
    } as TransformConfig)
      .map((f) => relative(src, f).split(sep).join('/'))
      .sort();

    expect(found).toStrictEqual(['a.sql', 'nested/b.sql']);
  });

  /**
   * The watcher had no exclusion either, so watch mode both descended into an
   * installed tree and held watch descriptors on it.
   */
  describe('the watcher ignores the same paths', () => {
    test.each([
      'src/node_modules',
      'src/node_modules/somepkg/c.sql',
      'src/node_modules/somepkg/deep/d.sql',
      'src\\node_modules\\somepkg\\c.sql',
    ])('%s is ignored', (fileName) => {
      expect(isUnderNodeModules(fileName)).toBe(true);
    });

    test.each([
      'src/a.sql',
      'src/nested/b.sql',
      // A directory merely *named* like one is not one.
      'src/node_modules_helpers/e.sql',
      'src/my_node_modules.sql',
    ])('%s is not ignored', (fileName) => {
      expect(isUnderNodeModules(fileName)).toBe(false);
    });
  });
});

/**
 * `--file` was matched with `fileList.includes(fileOverride)` — raw string
 * equality against glob output — so exactly one spelling of the path worked
 * and every other one printed "file was not found in provided transforms" and
 * generated nothing. Upstream #579.
 */
describe('--file matching', () => {
  const fileList = ['multi/a/one.sql', 'multi/b/two.sql'];

  test('the spelling glob happens to produce still matches', () => {
    expect(matchFileOverride(fileList, 'multi/a/one.sql')).toBe(
      'multi/a/one.sql',
    );
  });

  test.each([
    ['a leading ./', './multi/a/one.sql'],
    ['an absolute path', join(process.cwd(), 'multi', 'a', 'one.sql')],
    ['a redundant segment', 'multi/b/../a/one.sql'],
  ])('%s matches too', (_label, spelling) => {
    expect(matchFileOverride(fileList, spelling)).toBe('multi/a/one.sql');
  });

  test('the glob spelling is what is returned, not the one typed', () => {
    // So the `Processing …` lines do not depend on how the flag was written.
    expect(matchFileOverride(fileList, './multi/b/two.sql')).toBe(
      'multi/b/two.sql',
    );
  });

  test('a file the transform does not cover still matches nothing', () => {
    expect(matchFileOverride(fileList, 'multi/c/three.sql')).toBeUndefined();
  });
});

/**
 * `srcDir` is resolved against the working directory, not against the config
 * file, so running the CLI from elsewhere with an absolute `-c` path matched
 * nothing — and said nothing, and exited 0. Upstream #572.
 */
describe('a transform that matches no files says so', () => {
  /** Never reached: with no files there is nothing to describe. */
  const unusedDb = {} as TypeDb;

  const start = async (srcDir: string) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await new TypescriptAndSqlTransformer(
        unusedDb,
        { srcDir } as ParsedConfig,
        sqlTransform,
      ).start(false);
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }
  };

  test('an empty match is warned about, and names the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgtyped-empty-'));

    const warnings = await start(dir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`No files matched "${dir}/**/**/*.sql"`);
    expect(warnings[0]).toContain(process.cwd());
  });

  test('a match is not warned about', async () => {
    expect(await start(srcTree())).toStrictEqual([]);
  });
});

/**
 * The shared types file is the union over every generated file, so a watch
 * session has to maintain it across edits rather than derive it from the file
 * in front of it: an alias survives while any other file still needs it, and
 * has to be released when the last one stops — including when that file is
 * deleted, which the watcher did not react to at all before (#565).
 */
describe('shared types across a watch session', () => {
  /** The catalog OID a query's text asks for, by naming its table. */
  const oidFor = (text: string): number | undefined =>
    text.includes('texts') ? 1 : text.includes('numbers') ? 2 : undefined;

  const arrayTypeRow = (oid: number, typname: string) => ({
    oid,
    typname,
    typtype: 'b',
    enumlabel: null,
    typelem: 0,
    typcategory: 'A',
    typbasetype: 0,
  });

  /** A database that types the one column of a query from its text. */
  const db: TypeDb = {
    describe: async (text: string) => {
      const typeOID = oidFor(text);
      return {
        params: [],
        fields: typeOID
          ? [
              {
                name: 'col',
                tableOID: 0,
                columnAttrNumber: 0,
                typeOID,
                typeSize: -1,
                typeModifier: -1,
                formatCode: 0,
              },
            ]
          : [],
      };
    },
    rows: async (sql: string) =>
      sql.includes('pg_type')
        ? ([
            arrayTypeRow(1, '_text'),
            arrayTypeRow(2, '_int4'),
          ] as unknown as Record<string, unknown>[])
        : [],
    explain: async () => undefined,
  };

  const query = (name: string, table: string) =>
    `/* @name ${name} */\nSELECT c FROM ${table};\n`;

  const watchConfig = (srcDir: string) =>
    ({
      srcDir,
      sharedTypesFile: 'pgtyped-shared.ts',
      failOnError: false,
      camelCaseColumnNames: false,
      hungarianNotation: false,
      nonEmptyArrayParams: false,
      preparedStatements: true,
      checkPrivileges: false,
      typesOverrides: {},
    }) as ParsedConfig;

  async function waitFor(
    what: string,
    predicate: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  let transformer: TypescriptAndSqlTransformer | undefined;
  let logs: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(async () => {
    await transformer?.close();
    transformer = undefined;
    logs?.mockRestore();
    logs = undefined;
  });

  test('an alias appears, survives, and is released again', async () => {
    logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pgtyped-watch-')));
    const shared = join(dir, 'pgtyped-shared.ts');
    const read = () =>
      existsSync(shared) ? readFileSync(shared, 'utf-8') : '';
    writeFileSync(join(dir, 'a.sql'), query('A', 'texts'));

    const registry = new SharedTypeRegistry(watchConfig(dir));
    transformer = new TypescriptAndSqlTransformer(
      db,
      watchConfig(dir),
      sqlTransform,
      registry,
    );
    await transformer.start(true);

    // add: the first file to need it is what creates the shared file.
    await waitFor('the shared file to declare nullableStringArray', () =>
      read().includes('export type nullableStringArray'),
    );
    expect(readFileSync(join(dir, 'a.queries.ts'), 'utf-8')).toContain(
      "import type { nullableStringArray } from './pgtyped-shared.js';",
    );

    // add: a second file needing the same alias declares it no second time.
    writeFileSync(join(dir, 'b.sql'), query('B', 'texts'));
    await waitFor('b.queries.ts to be generated', () =>
      existsSync(join(dir, 'b.queries.ts')),
    );
    expect(read().match(/export type nullableStringArray/g)).toHaveLength(1);

    // change: a.sql stops using it, but b.sql still does.
    writeFileSync(join(dir, 'a.sql'), query('A', 'numbers'));
    await waitFor('the shared file to gain nullableNumberArray', () =>
      read().includes('export type nullableNumberArray'),
    );
    expect(read()).toContain('export type nullableStringArray');

    // unlink: the last file needing it is gone, so it goes too — and so does
    // the declaration file that was generated from it.
    rmSync(join(dir, 'b.sql'));
    await waitFor(
      'the shared file to drop nullableStringArray',
      () =>
        read().includes('export type nullableNumberArray') &&
        !read().includes('export type nullableStringArray'),
    );
    expect(existsSync(join(dir, 'b.queries.ts'))).toBe(false);
    expect(existsSync(join(dir, 'a.queries.ts'))).toBe(true);
  }, 30_000);

  test('the last alias going leaves no empty file behind', async () => {
    logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pgtyped-watch-')));
    const shared = join(dir, 'pgtyped-shared.ts');
    writeFileSync(join(dir, 'a.sql'), query('A', 'texts'));

    const registry = new SharedTypeRegistry(watchConfig(dir));
    transformer = new TypescriptAndSqlTransformer(
      db,
      watchConfig(dir),
      sqlTransform,
      registry,
    );
    await transformer.start(true);
    await waitFor('the shared file to be written', () => existsSync(shared));

    rmSync(join(dir, 'a.sql'));

    await waitFor('the shared file to be removed', () => !existsSync(shared));
  }, 30_000);

  test('the shared file is never itself a query file', () => {
    const registry = new SharedTypeRegistry(watchConfig('src'));

    expect(registry.isSharedFile('src/pgtyped-shared.ts')).toBe(true);
    expect(registry.isSharedFile('./src/nested/../pgtyped-shared.ts')).toBe(
      true,
    );
    expect(registry.isSharedFile('src/a.queries.ts')).toBe(false);
  });
});
