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
 *
 * Codegen emits `never` for an invalid query; `QueryArgs<never>` is `never`,
 * which makes such a query uncallable by construction.
 */
export type QueryArgs<TParams> = TParams extends void
  ? [options?: RunOptions]
  : [params: TParams, options?: RunOptions];

/**
 * Codegen leaves `!` / `?` nullability hints on column aliases (`total!`),
 * and the database echoes them back. Strip them so rows match the generated
 * result type.
 *
 * Mutates the row objects in place — safe for node-postgres, which allocates
 * fresh rows per result, but an adapter that caches or replays rows must copy
 * before handing them over. If a row somehow carries both `total` and `total!`,
 * the hinted value wins.
 */
function stripColumnHints<T>(rows: unknown[]): T[] {
  for (const row of rows as Record<string, unknown>[]) {
    for (const column of Object.keys(row)) {
      const last = column[column.length - 1];
      if (column.length > 1 && (last === '!' || last === '?')) {
        row[column.slice(0, -1)] = row[column];
        delete row[column];
      }
    }
  }
  return rows as T[];
}

const RUN_OPTION_KEYS = new Set(['prepared', 'name']);

/**
 * Guards the `hasParams: false` path. Misrouting here would hand a params
 * object to `compile()` as options, and its `name` property would become the
 * server-side statement name — node-postgres keys its statement cache by name,
 * so a user-supplied value there means unbounded namespace growth and, on a
 * collision, the server running previously parsed SQL.
 */
function assertRunOptions(value: unknown, queryName: string | undefined): void {
  if (value === undefined) return;
  const extra =
    typeof value === 'object' && value !== null
      ? Object.keys(value).filter((key) => !RUN_OPTION_KEYS.has(key))
      : ['(not an object)'];
  if (extra.length > 0) {
    throw new TypeError(
      `Query ${queryName ?? '(unnamed)'} declares no parameters, so its second ` +
        `argument must be RunOptions, but received: ${extra.join(', ')}. ` +
        `This usually means the generated query's hasParams is wrong.`,
    );
  }
}

/**
 * Base class for every generated query. Subclasses supply the SQL text and a
 * canonical statement name; this class owns argument handling, statement-name
 * resolution and result shaping.
 */
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

  /** Sends the query and returns the rows plus the driver's rowCount. */
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

  /** Sends the query and returns just the rows. */
  async run(
    connection: DatabaseConnection,
    ...rest: QueryArgs<TParams>
  ): Promise<TResult[]> {
    const { rows } = await this.execute(connection, ...rest);
    return rows;
  }

  private split(rest: unknown[]): [TParams, RunOptions | undefined] {
    if (this.hasParams) {
      if (rest.length === 0) {
        throw new TypeError(
          `Query ${this.name ?? '(unnamed)'} requires parameters.`,
        );
      }
      return [rest[0] as TParams, rest[1] as RunOptions | undefined];
    }
    assertRunOptions(rest[0], this.name);
    return [undefined as TParams, rest[0] as RunOptions | undefined];
  }
}
