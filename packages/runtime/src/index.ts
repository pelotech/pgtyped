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

export { sql as default } from './sql.js';
