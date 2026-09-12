import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedConfig } from './config.js';
import type { TypeDb } from './db/type-db.js';

/**
 * `pg` is the only reason `main` needs a server, and an injected `TypeDb` is
 * meant to remove that reason entirely. A Pool that throws on construction
 * turns "no pool is built" into an assertion rather than a claim: if the
 * injected path ever reaches `new pg.Pool`, every test below fails loudly
 * instead of quietly opening a connection nobody asked for.
 */
const poolConstructed = vi.fn(function Pool() {
  throw new Error('main built a pg.Pool for an injected TypeDb');
});
vi.mock('pg', () => ({ default: { Pool: poolConstructed } }));

/**
 * The pre-flight is skipped, not merely satisfied: there is no pool to verify,
 * and a describe failure against an in-process database surfaces per query.
 */
const verifyConnection = vi.fn(async () => undefined);
vi.mock('./db/type-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/type-db.js')>()),
  verifyConnection,
}));

const { main } = await import('./index.js');

/**
 * One `int4` column of one table, answered without a server. The catalog
 * queries are dispatched on by the table they name rather than parsed: this is
 * a stub for the injection seam, not a Postgres. `db/pglite.test.ts` is where
 * a real one answers.
 */
function stubDb(): TypeDb {
  return {
    describe: async () => ({
      params: [],
      fields: [
        {
          name: 'one',
          tableOID: 1,
          columnAttrNumber: 1,
          typeOID: 23,
          typeSize: 4,
          typeModifier: -1,
          formatCode: 0,
        },
      ],
    }),
    rows: async (sql) => {
      if (sql.includes('pg_attribute')) {
        return [
          { attid: '1:1', attname: 'one', attnotnull: true, atttypid: 23 },
        ];
      }
      if (sql.includes('pg_description')) {
        return [];
      }
      return [
        {
          oid: 23,
          typname: 'int4',
          typtype: 'b',
          enumlabel: null,
          typelem: 0,
          typcategory: 'N',
          typbasetype: 0,
        },
      ];
    },
    explain: async () => undefined,
  };
}

/**
 * `stubDb`, answering the role lookup as `role` and recording every catalog
 * query it is sent, so a test can prove which round trips a run made.
 */
function roleDb(role: { rolname: string; rolsuper: boolean }) {
  const base = stubDb();
  const catalogQueries: string[] = [];
  const db: TypeDb = {
    ...base,
    rows: async (sql) => {
      catalogQueries.push(sql);
      return sql.includes('pg_roles') ? [role] : base.rows(sql);
    },
  };
  const roleLookups = () =>
    catalogQueries.filter((sql) => sql.includes('pg_roles'));
  return { db, roleLookups };
}

/** A config pointing at a port nothing is listening on, which is the point. */
function project(): { config: ParsedConfig; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pgtyped-inject-'));
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir);
  writeFileSync(
    join(srcDir, 'q.sql'),
    '/* @name GetOne */\nSELECT 1 AS one;\n',
  );
  return {
    dir,
    config: {
      db: {
        host: '127.0.0.1',
        port: 1,
        user: 'nobody',
        password: undefined,
        dbName: 'nothing',
      },
      failOnError: false,
      camelCaseColumnNames: false,
      hungarianNotation: false,
      nonEmptyArrayParams: false,
      optionalNullParams: false,
      preparedStatements: false,
      checkPrivileges: false,
      sharedTypesFile: false,
      srcDir,
      transforms: [
        {
          mode: 'sql',
          include: '**/*.sql',
          emitTemplate: '{{dir}}/{{name}}.queries.ts',
        },
      ],
      typesOverrides: {},
    },
  };
}

beforeEach(() => {
  poolConstructed.mockClear();
  verifyConnection.mockClear();
});

describe('main with an injected TypeDb', () => {
  test('builds no pool and verifies no connection', async () => {
    const { config, dir } = project();

    const code = await main(config, false, undefined, stubDb());

    expect(code).toBe(0);
    expect(poolConstructed).not.toHaveBeenCalled();
    expect(verifyConnection).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'src', 'q.queries.ts'), 'utf-8')).toContain(
      'one: number',
    );
  });

  test('generates from the injected database, not from the config', async () => {
    const { config, dir } = project();
    const db = stubDb();
    const describe = vi.spyOn(db, 'describe');

    await main(config, false, undefined, db);

    expect(describe).toHaveBeenCalledWith('SELECT 1 AS one');
    expect(readFileSync(join(dir, 'src', 'q.queries.ts'), 'utf-8')).toContain(
      'GetOneResult',
    );
  });

  test('returns undefined in watch mode with nothing to close', async () => {
    const { config } = project();

    await expect(main(config, true, undefined, stubDb())).resolves.toBe(
      undefined,
    );
    expect(poolConstructed).not.toHaveBeenCalled();
  });
});

/**
 * Without one, `main` is exactly what it was: it builds the pool from the
 * config and refuses to write anything until the server has answered once.
 * The exit codes that behaviour earns are covered end to end in `cli.test.ts`;
 * this pins the two calls themselves.
 */
describe('main without an injected TypeDb', () => {
  test('still builds a pool and still verifies the connection', async () => {
    const { config } = project();
    poolConstructed.mockImplementationOnce(function Pool(this: {
      end: () => Promise<void>;
    }) {
      this.end = async () => undefined;
    } as never);

    await main(config, false);

    expect(poolConstructed).toHaveBeenCalledTimes(1);
    expect(poolConstructed).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 1, user: 'nobody' }),
    );
    expect(verifyConnection).toHaveBeenCalledTimes(1);
  });
});

/**
 * A superuser bypasses every privilege check, so `checkPrivileges` on a
 * superuser connection passes every query and reports nothing — a clean run
 * that tells the user nothing at all. The run says so, once, before any file
 * is processed. The stub answers the lookup, so this is what `main` does with
 * the answer; `db/pglite.test.ts` is where a real database gives one.
 */
describe('the superuser warning', () => {
  const postgres = { rolname: 'postgres', rolsuper: true };
  const app = { rolname: 'app', rolsuper: false };

  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  const warnings = () =>
    warn.mock.calls.map(([message]: unknown[]) => String(message));

  test('warns, naming the role, and still generates', async () => {
    const { config, dir } = project();
    const { db } = roleDb(postgres);

    const code = await main(
      { ...config, checkPrivileges: true },
      false,
      undefined,
      db,
    );

    expect(code).toBe(0);
    expect(warnings()).toStrictEqual([
      expect.stringContaining('running as "postgres", which is a superuser'),
    ]);
    expect(warnings()[0]).toContain('SET ROLE');
    // Advisory: the types are right, so they are written.
    expect(readFileSync(join(dir, 'src', 'q.queries.ts'), 'utf-8')).toContain(
      'one: number',
    );
  });

  test('says nothing as a role that is not a superuser', async () => {
    const { config } = project();
    const { db, roleLookups } = roleDb(app);

    const code = await main(
      { ...config, checkPrivileges: true },
      false,
      undefined,
      db,
    );

    expect(code).toBe(0);
    expect(roleLookups()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The lookup is a round trip, and a run with the check off — the default —
   * must not pay for one it never uses.
   */
  test('asks nothing of the database when the check is off', async () => {
    const { config } = project();
    const { db, roleLookups } = roleDb(postgres);

    await main({ ...config, checkPrivileges: false }, false, undefined, db);

    expect(roleLookups()).toStrictEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The answer is a property of the connection, not of a query, so it is
   * asked for once — before the first file, not once per file or per query
   * processed concurrently.
   */
  test('asks once per run, however many files and queries are checked', async () => {
    const { config, dir } = project();
    const { db, roleLookups } = roleDb(postgres);
    const files = Array.from({ length: 8 }, (_, i) => `many${i}.sql`);
    for (const file of files) {
      writeFileSync(
        join(dir, 'src', file),
        [
          `/* @name First${file.length} */`,
          'SELECT 1 AS one;',
          '',
          `/* @name Second${file.length} */`,
          'SELECT 2 AS one;',
          '',
        ].join('\n'),
      );
    }

    const code = await main(
      { ...config, checkPrivileges: true },
      false,
      undefined,
      db,
    );

    expect(code).toBe(0);
    expect(roleLookups()).toStrictEqual([
      'SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user',
    ]);
    expect(warnings()).toHaveLength(1);
  });

  /**
   * Fatal under failOnError, like every other diagnostic — and before the
   * first file rather than at the first query, so the strict reading writes
   * nothing at all.
   */
  test('failOnError fails the run before anything is written', async () => {
    const { config, dir } = project();
    const { db } = roleDb(postgres);

    const code = await main(
      { ...config, checkPrivileges: true, failOnError: true },
      false,
      undefined,
      db,
    );

    expect(code).toBe(1);
    expect(warnings()).toStrictEqual([
      expect.stringContaining('"postgres", which is a superuser'),
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('No files were written'),
    );
    expect(existsSync(join(dir, 'src', 'q.queries.ts'))).toBe(false);
  });

  test('failOnError changes nothing for a role that is not a superuser', async () => {
    const { config, dir } = project();
    const { db } = roleDb(app);

    const code = await main(
      { ...config, checkPrivileges: true, failOnError: true },
      false,
      undefined,
      db,
    );

    expect(code).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'src', 'q.queries.ts'))).toBe(true);
  });
});
