import { parseTagged } from './parse-tagged.js';
import { preparedStatementName } from './statement-name.js';
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
 * The shape a `.sql` file's `@name` annotation allows. `sql.named` accepts
 * exactly the same, so the two front-ends cannot produce statement names the
 * other could not.
 */
const VALID_QUERY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds a query from an inline template. The result is an ordinary
 * `TypedQuery` with no canonical statement name, so it is never prepared. Use
 * `sql.named` to opt into one.
 */
export function sql<T extends TypePair>(strings: TemplateStringsArray) {
  return new TypedQuery<T['params'], T['result']>(parseTagged(strings[0]));
}

/**
 * Builds a query from an inline template that carries a canonical prepared
 * statement name, so Postgres can reuse its parse and plan across calls.
 *
 * The name is only ever the prefix: the statement is sent as
 * `<name>_<8 hex of sha256(statement)>`. Editing the SQL therefore renames the
 * query, which is what keeps a long-lived pooled connection from executing the
 * statement it already prepared under the old name.
 *
 * A query whose parameters include an array spread renders a different number
 * of placeholders per call, so one name would map to many statement texts.
 * Those stay unnamed even here, exactly as codegen leaves them unnamed in
 * `.sql` files.
 */
sql.named = <T extends TypePair>(name: string) => {
  // A bad name is a programming error, so it surfaces at module evaluation
  // rather than becoming a strange statement name nobody looks at.
  if (!VALID_QUERY_NAME.test(name)) {
    throw new TypeError(
      `Invalid query name ${JSON.stringify(name)}: a name must match ` +
        `${VALID_QUERY_NAME.source}, as an @name annotation in a .sql file does.`,
    );
  }
  return (strings: TemplateStringsArray) => {
    const ir = parseTagged(strings[0], name);
    const statementName = preparedStatementName(ir);
    return new TypedQuery<T['params'], T['result']>(
      statementName === undefined ? ir : { ...ir, name: statementName },
    );
  };
};
