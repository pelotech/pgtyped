// The runtime otherwise imports no Node builtins. It gives that up here on
// purpose: the canonical statement name must be computed identically by codegen
// (for .sql files) and by the `sql` tag (at runtime), and one shared
// implementation backed by the platform's SHA-256 is worth more than keeping
// the dependency list empty by hand-rolling a hash.
import { createHash } from 'node:crypto';
import type { QueryIR } from './ir.js';

/** Postgres truncates identifiers at NAMEDATALEN - 1 = 63 bytes. */
const MAX_STATEMENT_NAME_BYTES = 63;

/**
 * How much of the SHA-256 each form keeps. The asymmetry is deliberate, and it
 * follows from what the hash has to separate in each case.
 *
 * With a name, the name itself already separates one query from another; the
 * hash only has to separate successive *edits of that one query*, so that a
 * redeploy cannot bind new text to the name a long-lived pooled connection
 * already prepared. A handful of versions of a single statement never
 * approaches 2^32, so 8 hex digits is ample.
 *
 * With no name, the hash is the entire identifier and must separate every
 * query in the application from every other. 32 bits is not enough for that:
 * by the birthday bound, 10,000 distinct queries collide with probability
 * ~1.2%, and a collision here means one query silently executing another's
 * SQL. 64 bits takes the same population to ~3e-12, which is comfortably below
 * the odds of anything else in the system going wrong.
 */
const NAMED_HASH_LENGTH = 8;
const DERIVED_HASH_LENGTH = 16;

/**
 * The prefix a derived name carries, so that a statement showing up in
 * `pg_prepared_statements` or `pg_stat_statements` is at least identifiable as
 * PgTyped's. It is not a namespace: the hash alone distinguishes the queries.
 */
const DERIVED_PREFIX = 'pgtyped';

/**
 * Whether the query renders the same SQL text on every call.
 *
 * `array_spread` and `pick_array_spread` render a placeholder per value passed
 * at runtime: `IN :ids` becomes `IN ($1,$2)` for two ids and `IN ($1,$2,$3)`
 * for three. One name would then map to many statement texts, which
 * node-postgres rejects with "Prepared statements must be unique".
 *
 * Only referenced params are in the IR, so a declared-but-unused spread param
 * cannot vary the rendered text and does not appear here at all.
 */
function rendersFixedSQL(ir: QueryIR): boolean {
  return ir.params.every(
    (p) =>
      p.transform.type !== 'array_spread' &&
      p.transform.type !== 'pick_array_spread',
  );
}

/**
 * Hash the exact statement text, never a normalized form: two queries whose
 * texts differ must never converge on one name.
 */
function statementHash(ir: QueryIR, length: number): string {
  return createHash('sha256')
    .update(ir.statement)
    .digest('hex')
    .slice(0, length);
}

/**
 * The canonical prepared statement name for an IR, or undefined if it must not
 * carry one.
 *
 * The name is always `<queryName>_<hash>`, never the query name alone. The
 * hash is what makes an edit rename the query, so a redeploy cannot collide
 * with the statement a long-lived pooled connection already prepared under the
 * old name.
 */
export function preparedStatementName(ir: QueryIR): string | undefined {
  if (!rendersFixedSQL(ir)) {
    return undefined;
  }

  const suffix = `_${statementHash(ir, NAMED_HASH_LENGTH)}`;

  // Query names come from the `@name` annotation, or from the name given to
  // `sql.prepared`; both are restricted to ASCII, so slicing by character is
  // equivalent to slicing by byte here. Truncation stays collision-safe
  // because the hash suffix is preserved.
  const prefix = ir.queryName.slice(
    0,
    MAX_STATEMENT_NAME_BYTES - suffix.length,
  );

  return `${prefix}${suffix}`;
}

/**
 * The statement name for a query nobody named: `pgtyped_<16 hex>`, derived from
 * the statement text alone. Used by `sql.prepared()` called without a name.
 *
 * Same variable-arity gate as the named form — a query whose text varies per
 * call still cannot carry a name, whoever chose it. Well under 63 bytes, so
 * there is nothing to truncate.
 */
export function derivedStatementName(ir: QueryIR): string | undefined {
  return rendersFixedSQL(ir)
    ? `${DERIVED_PREFIX}_${statementHash(ir, DERIVED_HASH_LENGTH)}`
    : undefined;
}
