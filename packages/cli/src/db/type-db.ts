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
