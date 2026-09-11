// packages/runtime/src/ir.ts

/**
 * A key inside a pick transform: `(name!, age)` declares `name` required.
 *
 * `type` is the Postgres type a key's placeholder is cast to — `(id::int4,
 * val::text)`. It exists because a `VALUES` list inside a sub-select resolves
 * its column types from its own rows alone, so every column of `FROM (VALUES
 * :rows) AS t(a, b)` falls back to `text` and the query fails downstream with
 * `42804` or `42883`. The renderer emits it as a cast; nothing infers or maps
 * it, because once the cast is in the SQL the server's `ParameterDescription`
 * reports the real OID and codegen picks it up unchanged.
 */
export interface Key {
  name: string;
  required: boolean;
  /** Absent unless the key was written with a cast, so an untyped key's IR is unchanged. */
  type?: string;
}

/**
 * How a parameter is rendered into the statement. The string tags match what
 * codegen has always emitted into generated files.
 */
export type Transform =
  | { type: 'scalar' }
  | { type: 'array_spread' }
  | { type: 'pick_tuple'; keys: Key[] }
  | { type: 'pick_array_spread'; keys: Key[] };

/** A half-open span [a, b) of `statement` that one reference to a param occupies. */
export interface Loc {
  a: number;
  b: number;
}

export interface ParamIR {
  name: string;
  transform: Transform;
  /** True when any reference to it carries `!`. */
  required: boolean;
  /** Every reference in the statement; a param used twice has two. */
  locs: Loc[];
}

/**
 * A nullability hint from `@column total!` (never null) or `@column maybe?`
 * (nullable). Overrides what codegen infers from the catalog. The name is the
 * Postgres result column name, before any camelCase conversion.
 */
export interface ColumnHint {
  name: string;
  nullable: boolean;
}

/**
 * The single intermediate representation for a query, whether it came from a
 * `.sql` file or a `sql` tag. Codegen serialises it into generated files as a
 * JSON literal; the runtime deserialises nothing — it receives the literal.
 */
export interface QueryIR {
  /** The `@name`, or for tags the name codegen derived from the variable. */
  queryName: string;
  /** The SQL with `:name` / `$name` references still in place. */
  statement: string;
  /** Only params that are referenced. A declared-but-unused param is a warning, not a param. */
  params: ParamIR[];
  columns: ColumnHint[];
  /**
   * Canonical server-side prepared statement name. Set by codegen when
   * prepared statements are enabled and no param has a variable-arity
   * transform, and by `sql.prepared` under the same variable-arity rule. Never
   * set for a plain `sql` tag.
   */
  name?: string;
}

export interface Diagnostic {
  message: string;
  /** Offset into the source text the diagnostic refers to. */
  offset: number;
}
