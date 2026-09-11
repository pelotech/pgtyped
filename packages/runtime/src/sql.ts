import { parseTagged } from './parse-tagged.js';
import {
  derivedStatementName,
  preparedStatementName,
} from './statement-name.js';
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
 * The shape a `.sql` file's `@name` annotation allows. `sql.prepared` accepts
 * exactly the same, so the two front-ends cannot produce statement names the
 * other could not.
 */
const VALID_QUERY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The one string a tag is allowed to be.
 *
 * A template hands its tag the *cooked* strings, and there are two shapes
 * where `strings[0]` is not the query the author wrote. An escape JavaScript
 * does not define — `E'\101'`, which is valid Postgres octal — leaves it
 * `undefined`; an interpolation leaves everything from the first `${…}` on in
 * later entries the tag never reads. Both are programming errors, so both are
 * reported here, at module evaluation, rather than as a `TypeError` on
 * `undefined` or as a query silently missing its second half.
 *
 * Codegen rejects the same two shapes with a message naming the file, so this
 * is the backstop for a tag it never saw: one outside `srcDir`, or in a
 * project that does not run the generator at all.
 */
function tagText(strings: TemplateStringsArray): string {
  if (strings.length > 1) {
    throw new TypeError(
      'A sql tag cannot interpolate: the tag reads the first string of the ' +
        `template and nothing else, so ${JSON.stringify(strings.raw[0])} is ` +
        'the whole of the query it would send. Pass the value as a $param.',
    );
  }
  const [text] = strings;
  if (text === undefined) {
    throw new TypeError(
      'A sql tag contains an escape JavaScript does not define, so it has no ' +
        `text: ${JSON.stringify(strings.raw[0])}. Postgres escapes are not ` +
        "JavaScript escapes: double the backslash, as in E'\\\\101'.",
    );
  }
  return text;
}

/**
 * Builds a query from an inline template. The result is an ordinary
 * `TypedQuery` with no canonical statement name, so it is never prepared. Use
 * `sql.prepared` to opt into one.
 */
export function sql<T extends TypePair>(strings: TemplateStringsArray) {
  return new TypedQuery<T['params'], T['result']>(
    parseTagged(tagText(strings)),
  );
}

/**
 * Builds a query from an inline template that carries a canonical prepared
 * statement name, so Postgres can reuse its parse and plan across calls.
 *
 * With a name, that name is only ever the prefix: the statement is sent as
 * `<name>_<8 hex of sha256 of the rendered SQL>`. Editing the SQL therefore
 * renames the query, which is what keeps a long-lived pooled connection from
 * executing the statement it already prepared under the old name.
 *
 * With no name, the statement is sent as `pgtyped_<16 hex of the same hash>`
 * — the same guarantee for free, at the cost of an identifier that says nothing
 * about the query when you meet it in `pg_stat_statements`. The hash is twice
 * as long here because it is now the whole identifier and has to separate every
 * query in the application, not just the versions of one query.
 *
 * A query whose parameters include an array spread renders a different number
 * of placeholders per call, so one name would map to many statement texts.
 * Those stay unnamed in both forms, exactly as codegen leaves them unnamed in
 * `.sql` files.
 */
sql.prepared = <T extends TypePair>(name?: string) => {
  // A bad name is a programming error, so it surfaces at module evaluation
  // rather than becoming a strange statement name nobody looks at.
  if (name !== undefined && !VALID_QUERY_NAME.test(name)) {
    throw new TypeError(
      `Invalid query name ${JSON.stringify(name)}: a name must match ` +
        `${VALID_QUERY_NAME.source}, as an @name annotation in a .sql file does.`,
    );
  }
  return (strings: TemplateStringsArray) => {
    const ir = parseTagged(tagText(strings), name);
    const statementName =
      name === undefined ? derivedStatementName(ir) : preparedStatementName(ir);
    return new TypedQuery<T['params'], T['result']>(
      statementName === undefined ? ir : { ...ir, name: statementName },
    );
  };
};
