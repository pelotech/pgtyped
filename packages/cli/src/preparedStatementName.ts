import { SQLQueryIR, TransformType } from '@pelotech/pgtyped-parser';
import { createHash } from 'crypto';
import { ParsedConfig } from './config.js';

/** Postgres truncates identifiers at NAMEDATALEN - 1 = 63 bytes. */
const MAX_STATEMENT_NAME_BYTES = 63;
const HASH_LENGTH = 8;

/**
 * Transforms whose placeholder count depends on the values passed at runtime:
 * `IN :ids` renders `IN ($1,$2)` for two ids and `IN ($1,$2,$3)` for three. A
 * query using one of them produces a different SQL text per call, so it can
 * never carry a stable server-side name — node-postgres rejects the second,
 * differing text with "Prepared statements must be unique".
 */
const VARIABLE_ARITY_TRANSFORMS: TransformType[] = [
  TransformType.ArraySpread,
  TransformType.PickArraySpread,
];

function rendersFixedSQL(ir: SQLQueryIR): boolean {
  return (
    ir.params
      // A param that is declared but never referenced is not interpolated, so
      // it cannot vary the rendered text.
      .filter((param) => param.name in ir.usedParamSet)
      .every(
        (param) => !VARIABLE_ARITY_TRANSFORMS.includes(param.transform.type),
      )
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
  ir: SQLQueryIR,
  declaredName: string,
  config: ParsedConfig,
): SQLQueryIR {
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

  // Query names come from the `@name` tag, which the grammar restricts to
  // ASCII, so slicing by character is equivalent to slicing by byte here.
  // Truncation stays collision-safe because the hash suffix is preserved.
  const prefix = declaredName.slice(
    0,
    MAX_STATEMENT_NAME_BYTES - suffix.length,
  );

  return { ...ir, name: `${prefix}${suffix}` };
}
