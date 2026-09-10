import type { Pool } from 'pg';
import { describe, type Described } from './describe.js';

/**
 * What type discovery needs from the database. Implemented once over a pg Pool;
 * trivially faked in tests.
 */
export interface TypeDb {
  describe(text: string): Promise<Described>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
}

export function typeDb(pool: Pool): TypeDb {
  return {
    describe: (text) => describe(pool, text),
    rows: async (sql) => (await pool.query(sql)).rows,
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
