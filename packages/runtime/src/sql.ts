import { parseTagged } from './parse-tagged.js';
import { TypedQuery } from './typed-query.js';

/**
 * The generic parameter to `sql<...>`. Exported so a consumer compiling with
 * `declaration: true` can export a tagged query without TS4023.
 */
export interface TypePair {
  params: unknown;
  result: unknown;
}

/**
 * Builds a query from an inline template. The result is an ordinary
 * `TypedQuery` with no canonical statement name, so it is never prepared.
 */
export const sql = <T extends TypePair>(strings: TemplateStringsArray) =>
  new TypedQuery<T['params'], T['result']>(parseTagged(strings[0]));
