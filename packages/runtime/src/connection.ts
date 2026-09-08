/**
 * What a query sends to the database. node-postgres accepts this object
 * directly, and only issues a server-side Parse when `name` is set.
 */
export interface QueryConfig {
  /** Server-side prepared statement name. Omit to send the query unnamed. */
  name?: string;
  text: string;
  values: unknown[];
}

export interface QueryResult<T> {
  rows: T[];
  /** node-postgres reports null for commands that carry no row count. */
  rowCount: number | null;
}

/**
 * Anything that can execute a QueryConfig. pg's Client and Pool satisfy this
 * as-is; a custom adapter implements the one method.
 */
export interface DatabaseConnection {
  query(config: QueryConfig): Promise<QueryResult<unknown>>;
}

export interface RunOptions {
  /**
   * Set to false to send the query unnamed regardless of its canonical name.
   * Required under PgBouncer in transaction-pooling mode. Takes precedence over
   * `name` below. Setting it to true is a no-op: it never invents a name for a
   * query that has none, and it cannot defeat a connection wrapped in
   * `unprepared()`, which strips names after all options are applied.
   */
  prepared?: boolean;
  /** Overrides the query's canonical statement name for this call. */
  name?: string;
}

/**
 * Wraps a connection so every query goes out unnamed. Required under PgBouncer
 * in transaction-pooling mode, where server-side prepared statements are unsafe.
 *
 * Wrap every connection handed to pgTyped, including a client checked out of a
 * pool: the wrapper exposes only `query`, so `pool.connect()` must be called on
 * the underlying pool and its client wrapped in turn. Stripping at this level
 * means no per-call option can re-introduce a name.
 */
export function unprepared(connection: DatabaseConnection): DatabaseConnection {
  return {
    query: ({ name: _name, ...config }) => connection.query(config),
  };
}
