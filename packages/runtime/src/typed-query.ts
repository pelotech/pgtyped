import type {
  DatabaseConnection,
  QueryConfig,
  QueryResult,
  RunOptions,
} from './connection.js';
import type { QueryIR } from './ir.js';
import { render, type QueryParameters } from './render.js';

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

const RUN_OPTION_KEYS = new Set(
  Object.keys({ prepared: true, name: true } satisfies Record<
    keyof RunOptions,
    true
  >),
);

/**
 * Guards the `hasParams: false` path. Misrouting here would hand a params
 * object to `compile()` as options, and its `name` property would become the
 * server-side statement name — node-postgres keys its statement cache by name,
 * so a user-supplied value there means unbounded namespace growth and, on a
 * collision, the server running previously parsed SQL.
 *
 * Not airtight: a params object whose keys are all within {prepared, name} is
 * indistinguishable from options and still passes. Only reachable when the
 * generated params type and the generated IR disagree about whether the query
 * takes parameters.
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
        `This usually means the generated params type and the generated IR ` +
        `disagree; re-run pgtyped codegen.`,
    );
  }
}

/**
 * A typed query, however it was written. Codegen emits one per `@name` block
 * in a .sql file, and the `sql` tag builds one at runtime from an inline
 * template; both carry the same IR, which is why there is one class rather
 * than a base and two subclasses.
 *
 * Owns argument handling, statement-name resolution and result shaping. Only
 * queries from .sql files can carry a canonical statement name, and only when
 * prepared statements are enabled and the query renders a fixed SQL text.
 */
export class TypedQuery<TParams, TResult> {
  /** Canonical prepared statement name, when codegen assigned one. */
  readonly name: string | undefined;

  /**
   * Whether the query declares any parameters. Mirrors the rule codegen uses
   * to emit `Params = void`, and decides how the rest arguments are read.
   */
  private readonly hasParams: boolean;

  constructor(private readonly ir: QueryIR) {
    this.name = ir.name;
    // Same rule codegen applies when deciding whether to emit `Params = void`:
    // only params that are actually referenced in the statement count, and the
    // IR carries only those.
    this.hasParams = ir.params.length > 0;
  }

  /**
   * The exact QueryConfig `run`/`execute` would send, without sending it.
   * Useful for logging, drivers this package does not know about, and tests.
   */
  compile(...rest: QueryArgs<TParams>): QueryConfig {
    const [params, options] = this.split(rest);
    const { text, values } = this.interpolate(params);
    // `options.name` may only override a name codegen already granted. Codegen
    // withholds one from any query whose SQL varies per call, because
    // node-postgres caches by name: naming a spread query would let a second
    // call with a longer array bind against the statement parsed for the
    // first, and Postgres rejects it with "bind message supplies N parameters,
    // but prepared statement requires M". A caller cannot tell which queries
    // are variable, so the guard lives here rather than in their heads.
    const name =
      options?.prepared === false || this.name === undefined
        ? undefined
        : (options?.name ?? this.name);
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
      rows: result.rows as TResult[],
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

  /** Renders the SQL text and positional values for a set of params. */
  private interpolate(params: TParams): { text: string; values: unknown[] } {
    // TParams is unconstrained on purpose: constraining it to QueryParameters
    // would reject generated params types, whose values include booleans,
    // Dates and JSON that QueryParameters' Scalar (string | number | null)
    // does not name. Assert to the callee's own type so a change to its
    // signature still surfaces here. Includes undefined: on the no-params path
    // `split` passes undefined through, which render accepts as "no bindings".
    const { query: text, bindings: values } = render(
      this.ir,
      params as QueryParameters | undefined,
    );
    return { text, values };
  }

  private split(rest: unknown[]): [TParams, RunOptions | undefined] {
    if (this.hasParams) {
      if (rest[0] === undefined) {
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
