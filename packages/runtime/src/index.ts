export {
  unprepared,
  type DatabaseConnection,
  type QueryConfig,
  type QueryResult,
  type RunOptions,
} from './connection.js';
export { TypedQuery, type QueryArgs } from './typed-query.js';
export { sql, type TypePair } from './sql.js';
export type { QueryIR } from './ir.js';

/** @deprecated Renamed to TypedQuery. Removed once codegen emits the new name. */
export { TypedQuery as PreparedQuery } from './typed-query.js';

export { sql as default } from './sql.js';
