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
   * Required under PgBouncer in transaction-pooling mode, where server-side
   * prepared statements are unsafe. Prefer wrapping the connection with
   * `unprepared()` over passing this at every call site.
   */
  prepared?: boolean;
  /** Overrides the query's canonical statement name for this call. */
  name?: string;
}

/**
 * Wraps a connection so every query goes out unnamed. Use this once where the
 * connection is created for a PgBouncer transaction-pooling deployment.
 */
export function unprepared(connection: DatabaseConnection): DatabaseConnection {
  return {
    query: ({ name: _name, ...config }) => connection.query(config),
  };
}
