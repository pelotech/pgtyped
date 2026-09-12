import type { Pool } from 'pg';
import {
  describe,
  explain,
  serverVersionNum,
  supportsGenericPlan,
  type Described,
} from './describe.js';

/**
 * What type discovery needs from the database. Implemented once over a pg Pool;
 * trivially faked in tests.
 */
export interface TypeDb {
  describe(text: string): Promise<Described>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  /**
   * Plans `text` without running it, rejecting with the server's error if the
   * connected role may not. `paramCount` is how many `$n` the rendered query
   * uses, which only the pre-16 fallback needs; see `explain`.
   */
  explain(text: string, paramCount: number): Promise<void>;
}

export function typeDb(pool: Pool): TypeDb {
  // Asked for once per run, and only if something calls explain(): a codegen
  // run with the privilege check off must not pay for a round trip it never
  // uses. The promise is cached, not the value, so concurrent transforms
  // share the one query rather than racing to make their own.
  let genericPlan: Promise<boolean> | undefined;
  const canPlanGenerically = () =>
    (genericPlan ??= serverVersionNum(pool).then(supportsGenericPlan));

  return {
    describe: (text) => describe(pool, text),
    rows: async (sql) => (await pool.query(sql)).rows,
    explain: async (text, paramCount) =>
      explain(pool, text, paramCount, await canPlanGenerically()),
  };
}

/**
 * Proves the database is reachable and the credentials are accepted, by
 * checking a client out of the pool and releasing it again.
 *
 * pg.Pool connects lazily, so without this a bad host, a refused port or a
 * rejected password first surfaces as a per-query describe failure — which
 * codegen renders as a `never` type, overwriting previously correct output
 * while reporting a successful run. Callers do this once, before any file is
 * processed.
 */
export async function verifyConnection(
  pool: Pick<Pool, 'connect'>,
): Promise<void> {
  const client = await pool.connect();
  client.release();
}

/** The role codegen's queries run as, and whether it is a superuser. */
export interface CurrentRole {
  name: string;
  superuser: boolean;
}

/**
 * Asks the database which role it is answering as, and whether that role is a
 * superuser.
 *
 * Read from `pg_roles` at `current_user` rather than from the `is_superuser`
 * setting. Both follow `SET ROLE` — measured against a real 18.6 server and
 * against PGlite, where a session that starts as the superuser answers
 * `false` after `SET ROLE app` and `true` again after `RESET ROLE` — but the
 * catalog row is the documented meaning of "superuser", and it carries the
 * role's name in the same round trip, which the warning built on this needs.
 *
 * Goes through `rows`, so it answers identically over a pool and over an
 * injected PGlite; nothing else on the interface is needed.
 */
export async function currentRole(
  db: Pick<TypeDb, 'rows'>,
): Promise<CurrentRole> {
  const [row] = (await db.rows(
    'SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user',
  )) as { rolname: string; rolsuper: boolean }[];
  return { name: row.rolname, superuser: row.rolsuper === true };
}
