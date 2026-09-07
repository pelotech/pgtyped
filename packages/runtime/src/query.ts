import type {
  DatabaseConnection,
  QueryConfig,
  QueryResult,
  RunOptions,
} from './connection.js';

export interface Interpolated {
  text: string;
  values: unknown[];
}

/**
 * The arguments after the connection. A query that declares parameters
 * requires them; one that declares none has no params slot at all, so
 * `run(connection)` and `run(connection, options)` are the only shapes.
 */
export type QueryArgs<TParams> = TParams extends void
  ? [options?: RunOptions]
  : [params: TParams, options?: RunOptions];

/**
 * Codegen leaves `!` / `?` nullability hints on column aliases (`total!`),
 * and the database echoes them back. Strip them so rows match the generated
 * result type.
 */
function stripColumnHints<T>(rows: unknown[]): T[] {
  for (const row of rows as Record<string, unknown>[]) {
    for (const column of Object.keys(row)) {
      const last = column[column.length - 1];
      if (last === '!' || last === '?') {
        row[column.slice(0, -1)] = row[column];
        delete row[column];
      }
    }
  }
  return rows as T[];
}

export abstract class Query<TParams, TResult> {
  /** Canonical prepared statement name, when codegen assigned one. */
  abstract readonly name: string | undefined;

  /**
   * Whether the query declares any parameters. Mirrors the rule codegen uses
   * to emit `Params = void`, and decides how the rest arguments are read.
   */
  protected abstract readonly hasParams: boolean;

  /** Renders the SQL text and positional values for a set of params. */
  protected abstract interpolate(params: TParams): Interpolated;

  /**
   * The exact QueryConfig `run`/`execute` would send, without sending it.
   * Useful for logging, drivers this package does not know about, and tests.
   */
  compile(...rest: QueryArgs<TParams>): QueryConfig {
    const [params, options] = this.split(rest);
    const { text, values } = this.interpolate(params);
    const name =
      options?.prepared === false ? undefined : (options?.name ?? this.name);
    // Truthiness on purpose: an empty name means unnamed, which is also how
    // node-postgres reads it.
    return name ? { name, text, values } : { text, values };
  }

  async execute(
    connection: DatabaseConnection,
    ...rest: QueryArgs<TParams>
  ): Promise<QueryResult<TResult>> {
    const result = await connection.query(this.compile(...rest));
    return {
      rows: stripColumnHints<TResult>(result.rows),
      rowCount: result.rowCount,
    };
  }

  async run(
    connection: DatabaseConnection,
    ...rest: QueryArgs<TParams>
  ): Promise<TResult[]> {
    const { rows } = await this.execute(connection, ...rest);
    return rows;
  }

  private split(rest: unknown[]): [TParams, RunOptions | undefined] {
    return this.hasParams
      ? [rest[0] as TParams, rest[1] as RunOptions | undefined]
      : [undefined as TParams, rest[0] as RunOptions | undefined];
  }
}
