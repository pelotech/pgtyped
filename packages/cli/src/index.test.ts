import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
