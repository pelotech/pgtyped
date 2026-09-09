// The runtime otherwise imports no Node builtins. It gives that up here on
// purpose: the canonical statement name must be computed identically by codegen
// (for .sql files) and by the `sql` tag (at runtime), and one shared
// implementation backed by the platform's SHA-256 is worth more than keeping
// the dependency list empty by hand-rolling a hash.
import { createHash } from 'node:crypto';
import type { QueryIR } from './ir.js';

/** Postgres truncates identifiers at NAMEDATALEN - 1 = 63 bytes. */
const MAX_STATEMENT_NAME_BYTES = 63;
const HASH_LENGTH = 8;

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

  // Hash the exact statement text, never a normalized form: two queries whose
  // texts differ must never converge on one name.
  const suffix = `_${createHash('sha256')
    .update(ir.statement)
    .digest('hex')
    .slice(0, HASH_LENGTH)}`;

  // Query names come from the `@name` annotation, or from the name given to
  // `sql.named`; both are restricted to ASCII, so slicing by character is
  // equivalent to slicing by byte here. Truncation stays collision-safe
  // because the hash suffix is preserved.
  const prefix = ir.queryName.slice(
    0,
    MAX_STATEMENT_NAME_BYTES - suffix.length,
  );

  return `${prefix}${suffix}`;
}
