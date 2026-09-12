import { currentRole, typeDb, verifyConnection } from './type-db.js';

describe('verifyConnection', () => {
  test('releases the client it checked out', async () => {
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ release })) };

    await verifyConnection(pool as never);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rejects with the connection failure', async () => {
    const pool = {
      connect: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          code: 'ECONNREFUSED',
        });
      },
    };

    await expect(verifyConnection(pool as never)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

describe('typeDb().explain', () => {
  /** A pool that answers the version query and records the EXPLAINs it is sent. */
  function fakePool(serverVersionNum: string) {
    const explains: { text: string; values?: unknown[] }[] = [];
    const versionQueries: string[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        explains.push(values === undefined ? { text } : { text, values });
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: async (text: string) => {
        versionQueries.push(text);
        return { rows: [{ server_version_num: serverVersionNum }] };
      },
    };
    return { pool, explains, versionQueries };
  }

  test('plans generically against PostgreSQL 16 and up', async () => {
    const { pool, explains } = fakePool('180006');

    await typeDb(pool as never).explain('SELECT $1', 1);

    expect(explains).toStrictEqual([
      { text: 'EXPLAIN (GENERIC_PLAN) SELECT $1' },
    ]);
  });

  test('falls back to binding NULLs before 16', async () => {
    const { pool, explains } = fakePool('150019');

    await typeDb(pool as never).explain('SELECT $1', 1);

    expect(explains).toStrictEqual([
      { text: 'EXPLAIN SELECT $1', values: [null] },
    ]);
  });

  /**
   * One round trip for the whole run, shared by every transform: the promise
   * is cached, not its value, so concurrent callers do not each start their
   * own.
   */
  test('asks the server its version once, however many queries are checked', async () => {
    const { pool, versionQueries } = fakePool('180006');
    const db = typeDb(pool as never);

    await Promise.all([
      db.explain('SELECT 1', 0),
      db.explain('SELECT 2', 0),
      db.explain('SELECT 3', 0),
    ]);
    await db.explain('SELECT 4', 0);

    expect(versionQueries).toStrictEqual(['SHOW server_version_num']);
  });

  test('costs nothing at all when no query is checked', async () => {
    const { pool, versionQueries } = fakePool('180006');

    typeDb(pool as never);

    expect(versionQueries).toStrictEqual([]);
  });
});

/**
 * The one query the superuser warning rests on. It reads `pg_roles` at
 * `current_user` — which follows `SET ROLE`, measured against a real server
 * and against PGlite in `pglite.test.ts` — and goes through `rows`, so it is
 * the same lookup over a pool and over an injected database.
 */
describe('currentRole', () => {
  const answering = (row: Record<string, unknown>) => {
    const queries: string[] = [];
    const db = {
      rows: async (sql: string) => {
        queries.push(sql);
        return [row];
      },
    };
    return { db, queries };
  };

  test('reads rolsuper for current_user, not for the session user', async () => {
    const { db, queries } = answering({ rolname: 'postgres', rolsuper: true });

    await expect(currentRole(db)).resolves.toStrictEqual({
      name: 'postgres',
      superuser: true,
    });
    expect(queries).toStrictEqual([
      'SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user',
    ]);
  });

  test('names a role that is not a superuser', async () => {
    const { db } = answering({ rolname: 'app', rolsuper: false });

    await expect(currentRole(db)).resolves.toStrictEqual({
      name: 'app',
      superuser: false,
    });
  });
});
