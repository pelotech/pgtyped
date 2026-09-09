import {
  preparedStatementName,
  type QueryIR,
} from '@pelotech/pgtyped-runtime/internal';
import { ParsedConfig } from './config.js';

/**
 * Attaches the canonical prepared statement name to a query IR, so that the
 * name travels with the query instead of being supplied at each call site.
 *
 * The naming rule itself lives in the runtime, which applies it to `sql.named`
 * tags too: one implementation so both front-ends cannot drift. All that is
 * left here is the config gate.
 *
 * Returns the IR untouched when prepared statements are disabled or when the
 * query cannot safely carry a name, in which case the runtime sends it unnamed
 * exactly as before.
 */
export function attachPreparedStatementName(
  ir: QueryIR,
  config: ParsedConfig,
): QueryIR {
  if (!config.preparedStatements) {
    return ir;
  }
  const name = preparedStatementName(ir);
  return name === undefined ? ir : { ...ir, name };
}
