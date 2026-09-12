import { PGlite, protocol } from '@electric-sql/pglite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedConfig } from '../config.js';
import { main } from '../index.js';
import { pgliteTypeDb, type PGliteDb } from './pglite.js';
import { currentRole } from './type-db.js';

/**
 * Every test here runs against a real in-process Postgres: no Docker, no
 * server, no listener. That is the whole claim being made, so nothing is
 * faked except where a gotcha is being reproduced.
 */
const SCHEMA = `
  CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
  CREATE DOMAIN email_address AS text;
  CREATE TABLE authors (
    id serial PRIMARY KEY,
    name text NOT NULL,
    email email_address,
    current_mood mood,
    aliases text[]
  );
  COMMENT ON COLUMN authors.name IS 'The name on the cover.';
`;

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('pgliteTypeDb().describe', () => {
  test('carries the tableID and columnID the nullability join needs', async () => {
    const { params, fields } = await pgliteTypeDb(db).describe(
      'SELECT id, name, current_mood FROM authors WHERE id = $1',
    );

    expect(params).toStrictEqual([{ oid: 23 }]);
    expect(fields.map((f) => f.name)).toStrictEqual([
      'id',
      'name',
      'current_mood',
    ]);
    // Without these two, `getTypes` has nothing to join pg_attribute on and
    // every column comes out nullable. `db.describeQuery()` returns neither,
    // which is why this adapter drives the protocol itself.
    for (const field of fields) {
      expect(field.tableOID).toBeGreaterThan(0);
      expect(field.columnAttrNumber).toBeGreaterThan(0);
    }
  });

  /**
   * PGlite reports `format` as the wire's numeric 0/1, where pg hands its
   * consumers the decoded `'text'`/`'binary'`. `DescribeStatement` therefore
   * compares against a string and this adapter must not.
   */
  test('reports formatCode as a number, not pg’s string', async () => {
    const { fields } = await pgliteTypeDb(db).describe(
      'SELECT id FROM authors',
    );

    expect(fields[0].formatCode).toBe(0);
    expect(typeof fields[0].formatCode).toBe('number');
  });

  /**
   * A Describe always reports format 0, so no live query can tell a passed
   * through `1` from a `'binary'` comparison that silently yields `0`. The
   * message is synthesised instead: the adapter must carry the wire's value,
   * not re-derive it from a string PGlite never sends.
   */
  test('carries a binary format code through rather than re-deriving it', async () => {
    const binaryField = {
      name: 'id',
      tableID: 1,
      columnID: 1,
      dataTypeID: 23,
      dataTypeSize: 4,
      dataTypeModifier: -1,
      format: 1,
    };
    const fake = {
      runExclusive: <T>(fn: () => Promise<T>) => fn(),
      execProtocol: async () => ({
        data: new Uint8Array(),
        messages: [
          { name: 'parameterDescription', length: 0, dataTypeIDs: [] },
          { name: 'rowDescription', length: 0, fields: [binaryField] },
        ],
      }),
    } as unknown as PGliteDb;

    const { fields } = await pgliteTypeDb(fake).describe('SELECT id');

    expect(fields[0].formatCode).toBe(1);
  });

  test('rejects with a pg-shaped error', async () => {
    await expect(
      pgliteTypeDb(db).describe('SELECT nope FROM authors'),
    ).rejects.toMatchObject({ code: '42703', position: '8' });
  });

  test('describes again after one has failed', async () => {
    const typeDb = pgliteTypeDb(db);
    await expect(typeDb.describe('SELECT nope FROM authors')).rejects.toThrow();

    const { fields } = await typeDb.describe('SELECT id FROM authors');

    expect(fields.map((f) => f.name)).toStrictEqual(['id']);
  });
});

/**
 * `execProtocol` is not covered by PGlite's query lock, and the failure is
 * silent: unlocked, one caller in a same-tick burst receives every backend
 * message and the rest receive none, producing an empty `Described` that
 * codegen renders as `never` with no error at all.
 *
 * The end-to-end run below does *not* reproduce this — there are only two
 * query files and the transforms do not overlap enough describes to collide —
 * so the serialization is tested directly rather than left to a pipeline that
 * happens not to race today.
 */
describe('describe is serialized with runExclusive', () => {
  const describeMessage = (text: string) => {
    const parts = [
      protocol.serialize.parse({ text }),
      protocol.serialize.describe({ type: 'S' as const }),
      protocol.serialize.sync(),
    ];
    const message = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      message.set(part, offset);
      offset += part.length;
    }
    return message;
  };

  const QUERY = 'SELECT id, name FROM authors WHERE id = $1';
  const BURST = 9;

  test('nine concurrent describes all come back complete', async () => {
    const typeDb = pgliteTypeDb(db);

    const results = await Promise.all(
      Array.from({ length: BURST }, () => typeDb.describe(QUERY)),
    );

    expect(results.map((r) => r.fields.length)).toStrictEqual(
      Array<number>(BURST).fill(2),
    );
    expect(results.map((r) => r.params.length)).toStrictEqual(
      Array<number>(BURST).fill(1),
    );
  }, 30_000);

  /**
   * The same burst through the same protocol messages with the lock removed,
   * so the passing test above is known to be load-bearing rather than lucky.
   */
  test('and would not without the lock', async () => {
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        db.execProtocol(describeMessage(QUERY)),
      ),
    );

    const described = results.filter((r) =>
      r.messages.some((m) => m.name === 'rowDescription'),
    );
    expect(described.length).toBeLessThan(BURST);
  }, 30_000);

  test('a describe that fails still releases the lock', async () => {
    const typeDb = pgliteTypeDb(db);

    await Promise.allSettled([
      typeDb.describe('SELECT nope FROM authors'),
      typeDb.describe('SELECT nope FROM authors'),
    ]);

    await expect(
      typeDb.describe('SELECT id FROM authors'),
    ).resolves.toMatchObject({ params: [] });
  }, 30_000);
});

/**
 * `query()` always sends a Bind, so a parameterised statement under
 * `GENERIC_PLAN` — which binds nothing — fails `08P01 bind message supplies 0
 * parameters`. `exec()` uses the simple query protocol and does not.
 */
describe('pgliteTypeDb().explain', () => {
  const PARAMETERISED = 'SELECT id FROM authors WHERE id = $1';

  test('plans a parameterised statement', async () => {
    await expect(
      pgliteTypeDb(db).explain(PARAMETERISED, 1),
    ).resolves.toBeUndefined();
  });

  test('which db.query() cannot do, hence exec()', async () => {
    await expect(
      db.query(`EXPLAIN (GENERIC_PLAN) ${PARAMETERISED}`),
    ).rejects.toMatchObject({ code: '08P01' });
  });

  test('asks the server its version once, however many queries are checked', async () => {
    const queries: string[] = [];
    const recording: PGliteDb = {
      query: ((sql: string, ...rest: unknown[]) => {
        queries.push(sql);
        return (db.query as (...a: unknown[]) => unknown)(sql, ...rest);
      }) as PGliteDb['query'],
      exec: (sql, options) => db.exec(sql, options),
      execProtocol: (message, options) => db.execProtocol(message, options),
      runExclusive: (fn) => db.runExclusive(fn),
    };
    const typeDb = pgliteTypeDb(recording);

    await Promise.all([
      typeDb.explain(PARAMETERISED, 1),
      typeDb.explain(PARAMETERISED, 1),
    ]);
    await typeDb.explain(PARAMETERISED, 1);

    expect(queries.filter((q) => q === 'SHOW server_version_num')).toHaveLength(
      1,
    );
  }, 30_000);

  test('reports a privilege failure as the server’s 42501', async () => {
    const scoped = await PGlite.create();
    try {
      await scoped.exec(SCHEMA);
      await scoped.exec(
        'CREATE ROLE reader; GRANT USAGE ON SCHEMA public TO reader; SET ROLE reader;',
      );

      await expect(
        pgliteTypeDb(scoped).explain('SELECT id FROM authors', 0),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await scoped.close();
    }
  }, 60_000);
});

describe('pgliteTypeDb().rows', () => {
  test('parses oids to numbers and attnotnull to a boolean, as pg does', async () => {
    const rows = (await pgliteTypeDb(db).rows(
      `SELECT attnotnull, atttypid FROM pg_attribute
       WHERE attrelid = 'authors'::regclass AND attname = 'name';`,
    )) as { attnotnull: unknown; atttypid: unknown }[];

    // `nullable: !attnotnull` would make every column nullable against the
    // wire client's 't', and the type map is keyed by numeric oid.
    expect(rows[0].attnotnull).toBe(true);
    expect(rows[0].atttypid).toBe(25);
  });
});

/**
 * The feature, end to end: a PGlite created and migrated in this process,
 * handed to `main`, generating real files. The config's `db` block points at a
 * port nothing is listening on, so anything that reached for a server would
 * fail rather than quietly succeed against an ambient one.
 */
describe('codegen against an injected PGlite', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pgtyped-pglite-'));
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'authors.sql'),
      [
        '/* @name FindAuthor */',
        'SELECT id, name, email, current_mood, aliases FROM authors WHERE id = :id!;',
        '',
        '/* @name InsertAuthor */',
        'INSERT INTO authors (name, current_mood) VALUES (:name!, :mood) RETURNING id;',
        '',
      ].join('\n'),
    );

    const config: ParsedConfig = {
      db: {
        host: '127.0.0.1',
        port: 1,
        user: 'nobody',
        password: undefined,
        dbName: 'nothing',
      },
      failOnError: true,
      camelCaseColumnNames: false,
      hungarianNotation: false,
      nonEmptyArrayParams: false,
      optionalNullParams: false,
      preparedStatements: false,
      checkPrivileges: false,
      sharedTypesFile: 'pgtyped-shared.ts',
      srcDir,
      transforms: [
        {
          mode: 'sql',
          include: '**/*.sql',
          emitTemplate: '{{dir}}/{{name}}.queries.ts',
        },
      ],
      typesOverrides: {},
    };

    await expect(
      main(config, false, undefined, pgliteTypeDb(db)),
    ).resolves.toBe(0);
  }, 60_000);

  const generated = () =>
    readFileSync(join(dir, 'src', 'authors.queries.ts'), 'utf-8');
  const shared = () =>
    readFileSync(join(dir, 'src', 'pgtyped-shared.ts'), 'utf-8');

  /**
   * The result interface on its own. `InsertAuthorParams` also declares a
   * `name`, and matching that instead would let a run where every column came
   * back nullable pass anyway.
   */
  const findAuthorResult = () =>
    /export interface FindAuthorResult \{([^}]*)\}/.exec(generated())?.[1] ??
    '';

  test('types the columns from the injected schema', () => {
    expect(findAuthorResult()).toContain('id: number;');
    expect(findAuthorResult()).toContain('name: string;');
  });

  test('honours the pg_attribute nullability join', () => {
    // `name` is NOT NULL and `email` is not. Both answers come from the join
    // that needs describe's tableID/columnID, so a describe that lost them
    // shows up right here as a uniformly nullable result.
    expect(findAuthorResult()).toContain('name: string;');
    expect(findAuthorResult()).not.toContain('name: string | null;');
    expect(findAuthorResult()).toContain('email: string | null;');
  });

  test('resolves the enum and the array alias through the shared file', () => {
    expect(generated()).toContain(
      "import type { mood, nullableStringArray } from './pgtyped-shared.js';",
    );
    expect(shared()).toContain("export type mood = 'happy' | 'ok' | 'sad';");
    expect(shared()).toContain(
      'export type nullableStringArray = (string | null)[];',
    );
  });

  test('carries the column comment through', () => {
    expect(generated()).toContain('The name on the cover.');
  });

  test('generates nothing resembling a never type', () => {
    expect(generated()).not.toContain('never');
  });

  test('honours sharedTypesFile, which nothing else on this path proves', () => {
    expect(shared()).toContain('export type mood');
  });
});

/**
 * A PGlite has no listener and nobody to authenticate as, so codegen runs as
 * the superuser that created it — and a superuser passes every privilege
 * check. `SET ROLE` is the documented remedy, and the lookup reads `pg_roles`
 * at `current_user` precisely because `current_user` follows it: the case that
 * has to come out right is superuser by default, and not after `SET ROLE`.
 */
describe('the superuser warning on an injected PGlite', () => {
  const ROLE_SETUP =
    'CREATE ROLE app; GRANT USAGE ON SCHEMA public TO app; ' +
    'GRANT SELECT ON authors TO app; SET ROLE app;';

  test('the role is the superuser by default, and the SET ROLE role after one', async () => {
    const scoped = await PGlite.create();
    try {
      await expect(currentRole(pgliteTypeDb(scoped))).resolves.toStrictEqual({
        name: 'postgres',
        superuser: true,
      });

      await scoped.exec(
        ROLE_SETUP.replace('GRANT SELECT ON authors TO app; ', ''),
      );

      await expect(currentRole(pgliteTypeDb(scoped))).resolves.toStrictEqual({
        name: 'app',
        superuser: false,
      });
    } finally {
      await scoped.close();
    }
  }, 60_000);

  /** Runs codegen with the check on against `scoped`, returning what it warned. */
  const checkedRun = async (scoped: PGlite) => {
    const dir = mkdtempSync(join(tmpdir(), 'pgtyped-pglite-super-'));
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'authors.sql'),
      '/* @name FindAuthor */\nSELECT id, name FROM authors WHERE id = :id!;\n',
    );
    const config: ParsedConfig = {
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
      checkPrivileges: true,
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
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const code = await main(config, false, undefined, pgliteTypeDb(scoped));
      return {
        code,
        warnings: warn.mock.calls.map(([message]) => String(message)),
        generated: readFileSync(join(srcDir, 'authors.queries.ts'), 'utf-8'),
      };
    } finally {
      warn.mockRestore();
    }
  };

  test('warns by default, because the check would pass everything', async () => {
    const scoped = await PGlite.create();
    try {
      await scoped.exec(SCHEMA);

      const { code, warnings, generated } = await checkedRun(scoped);

      expect(code).toBe(0);
      expect(warnings).toStrictEqual([
        expect.stringContaining('running as "postgres", which is a superuser'),
      ]);
      expect(generated).toContain('name: string');
    } finally {
      await scoped.close();
    }
  }, 60_000);

  test('does not warn after SET ROLE to a role that is not a superuser', async () => {
    const scoped = await PGlite.create();
    try {
      await scoped.exec(SCHEMA);
      await scoped.exec(ROLE_SETUP);

      const { code, warnings, generated } = await checkedRun(scoped);

      expect(code).toBe(0);
      // Nothing at all: the role is granted what the query needs, so the
      // check has nothing to report either.
      expect(warnings).toStrictEqual([]);
      expect(generated).toContain('name: string');
    } finally {
      await scoped.close();
    }
  }, 60_000);
});
