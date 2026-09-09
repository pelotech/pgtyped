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
