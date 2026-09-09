// packages/runtime/src/ir.ts

/**
 * A key inside a pick transform: `(name!, age)` declares `name` required.
 */
export interface Key {
  name: string;
  required: boolean;
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
   * transform, and by `sql.named` under the same variable-arity rule. Never
   * set for a plain `sql` tag.
   */
  name?: string;
}

export interface Diagnostic {
  message: string;
  /** Offset into the source text the diagnostic refers to. */
  offset: number;
}
