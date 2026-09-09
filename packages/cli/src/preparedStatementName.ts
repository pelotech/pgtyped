import type { QueryIR } from '@pelotech/pgtyped-runtime/internal';
import { createHash } from 'crypto';
import { ParsedConfig } from './config.js';

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
 * Attaches the canonical prepared statement name to a query IR, so that the
 * name travels with the query instead of being supplied at each call site.
 *
 * Returns the IR untouched when prepared statements are disabled or when the
 * query cannot safely carry a name, in which case the runtime sends it unnamed
 * exactly as before.
 */
export function attachPreparedStatementName(
  ir: QueryIR,
  config: ParsedConfig,
): QueryIR {
  if (!config.preparedStatements || !rendersFixedSQL(ir)) {
    return ir;
  }

  // Hash the exact statement text, never a normalized form: two queries whose
  // texts differ must never converge on one name. The hash also means editing a
  // query renames it, so a redeploy cannot collide with the statement a
  // long-lived connection already prepared under the old name.
  const suffix = `_${createHash('sha256')
    .update(ir.statement)
    .digest('hex')
    .slice(0, HASH_LENGTH)}`;

  // Query names come from the `@name` annotation, which the scanner restricts
  // to ASCII, so slicing by character is equivalent to slicing by byte here.
  // Truncation stays collision-safe because the hash suffix is preserved.
  const prefix = ir.queryName.slice(
    0,
    MAX_STATEMENT_NAME_BYTES - suffix.length,
  );

  return { ...ir, name: `${prefix}${suffix}` };
}
