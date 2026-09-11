import { parseTagged, type QueryIR } from '@pelotech/pgtyped-runtime/internal';
import { camelCase, pascalCase } from 'change-case';
import ts from 'typescript';

interface INode {
  queryName: string;
  queryText: string;
}

/**
 * `errors` holds already-formatted messages, one per `sql` tag that could not
 * be parsed. They are fatal for the whole file: the queries that did parse are
 * still returned, but codegen must not emit from a file it only half read.
 *
 * `warnings` holds messages for tags that generate correctly but read badly,
 * such as a `sql.prepared` name that does not match the variable holding it,
 * or a type argument that names a different query's generated type.
 * They are printed and otherwise ignored, unless `failOnError` is set.
 */
export type TSParseResult = {
  queries: QueryIR[];
  errors: string[];
  warnings: string[];
};

/**
 * A `sql` tag codegen owns:
 *  - `plain` is `` sql`…` ``, named after the variable it is assigned to.
 *  - `prepared` is `` sql.prepared<T>('GetUsers')`…` ``, which carries its own
 *    name, or `` sql.prepared<T>()`…` ``, which derives one from the statement
 *    at runtime and is named after its variable here, like a plain tag.
 *  - `invalid` is a `sql.prepared` whose name codegen cannot read.
 */
type SqlTag =
  | { kind: 'plain' }
  | { kind: 'prepared'; name?: string }
  | { kind: 'invalid'; reason: string };

/**
 * Classifies the tag expression of a tagged template, on its AST shape rather
 * than its text: `sql.prepared<T>('X')` and `sql.prepared('X')` differ
 * textually, and so does any of them reformatted, but all are the same tag.
 */
function readSqlTag(tag: ts.Expression): SqlTag | undefined {
  if (ts.isIdentifier(tag) && tag.text === 'sql') {
    return { kind: 'plain' };
  }
  if (!ts.isCallExpression(tag)) {
    return undefined;
  }
  const callee = tag.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'sql' ||
    callee.name.text !== 'prepared'
  ) {
    return undefined;
  }
  const [nameArg] = tag.arguments;
  if (!nameArg) {
    // No name is not a mistake: the runtime derives one from the statement
    // hash. Codegen then names the generated types after the variable, as it
    // does for a plain tag.
    return { kind: 'prepared' };
  }
  // A no-substitution template is as readable here as a quoted string; a
  // variable, a concatenation or an interpolation is not.
  if (!ts.isStringLiteralLike(nameArg) || nameArg.text.trim() === '') {
    return {
      kind: 'invalid',
      reason: `\`sql.prepared\` needs a non-empty string literal name, got \`${nameArg.getText()}\`. Call it with no argument to derive one from the statement.`,
    };
  }
  return { kind: 'prepared', name: nameArg.text };
}

/**
 * The compiler's flag for a template token holding an escape JavaScript does
 * not define. It is internal, so it is read through a cast and named here: the
 * public `ts.TokenFlags` stops at the numeric-literal flags, and nothing else
 * in the API distinguishes a template whose cooked text exists from one whose
 * cooked text is `undefined` at run time.
 */
const CONTAINS_INVALID_ESCAPE = 1 << 11;

/**
 * A tag's source text, first line only and bounded, for quoting in a message.
 * The whole interior of a multi-line tag would bury the sentence explaining it.
 */
function excerpt(template: ts.TemplateLiteral) {
  const source = template.getText();
  const [first] = source.split('\n');
  const head = first.slice(0, 60);
  return head === source ? head : `${head}…`;
}

/**
 * The text of a tag as the JavaScript engine hands it to the runtime.
 *
 * `.text` is the *cooked* value, the one `strings[0]` holds — which is what
 * the runtime parses, hashes into a prepared statement name and sends. The
 * source spelling is a different string wherever the tag contains a backslash:
 * `like 'The\_%'` is written with an escaped underscore and reaches Postgres
 * as the wildcard `The_%`, and `~ '\d'` reaches it as the letter `d`. Codegen
 * has to describe the text that is sent, so it reads the cooked value and
 * never the raw one. `.text` also normalises CRLF to LF the way the engine
 * does, so a tag is typed the same on a Windows checkout as anywhere else.
 *
 * Two shapes have no usable cooked text, and in both the runtime gets
 * something other than the query codegen would describe, so both are fatal:
 *  - an invalid escape leaves `strings[0]` undefined and the tag throws as the
 *    module is imported. TypeScript falls back to the raw text here, so
 *    reading `.text` would quietly type a query that cannot be constructed.
 *  - an interpolation is cut short at the first `${…}`, because the runtime
 *    reads `strings[0]` and nothing else.
 */
function tagText(
  template: ts.TemplateLiteral,
): { text: string } | { reason: string } {
  if (!ts.isNoSubstitutionTemplateLiteral(template)) {
    return {
      reason:
        `A \`sql\` tag cannot interpolate, and ${excerpt(template)} does. ` +
        `The runtime reads the first string of the template and nothing else, ` +
        `so everything from the first \`\${…}\` on is dropped. Pass the value ` +
        `as a \`$param\` instead.`,
    };
  }
  const flags = (template as { templateFlags?: number }).templateFlags ?? 0;
  if (flags & CONTAINS_INVALID_ESCAPE) {
    return {
      reason:
        `A \`sql\` tag contains an escape JavaScript does not define, and ` +
        `${excerpt(template)} does. Such a tag has no text at all — ` +
        `\`strings[0]\` is undefined and the tag throws as the module is ` +
        `imported. Postgres escapes are not JavaScript escapes: double the ` +
        `backslash, as in \`E'\\\\101'\`.`,
    };
  }
  return { text: template.text.trim() };
}

/**
 * The name of the variable a tag is assigned to, if there is one. A tag used
 * inline as an argument, assigned to a property, or destructured has no plain
 * identifier to compare a statement name against, so it reports none.
 */
function variableNameOf(node: ts.TaggedTemplateExpression) {
  const { parent } = node;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}

/**
 * The tag's type argument, when it is a plain type reference codegen can
 * compare against the interface it generates.
 *
 * `sql<{ params: …; result: … }>` is a legitimate way to write the pair
 * inline, and a generic reference has no generated counterpart either, so
 * anything that is not a bare identifier is skipped rather than warned about.
 * The type argument sits on the call for `sql.prepared<T>(…)` and on the
 * tagged template itself for a plain `` sql<T>`…` ``.
 */
function typeArgumentNameOf(node: ts.TaggedTemplateExpression) {
  const typeArguments = ts.isCallExpression(node.tag)
    ? node.tag.typeArguments
    : node.typeArguments;
  const [arg] = typeArguments ?? [];
  if (
    !arg ||
    !ts.isTypeReferenceNode(arg) ||
    !ts.isIdentifier(arg.typeName) ||
    arg.typeArguments !== undefined
  ) {
    return undefined;
  }
  return arg.typeName.text;
}

/**
 * @param interfacePrefix the `hungarianNotation` prefix codegen puts on every
 * generated interface, so the type-argument lint expects the same name codegen
 * is about to write.
 */
export function parseFile(
  sourceFile: ts.SourceFile,
  interfacePrefix = '',
): TSParseResult {
  const foundNodes: INode[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  parseNode(sourceFile);

  /**
   * The generated `…Query` interface is the one type argument that makes
   * sense on a tag, and it is named after the query. A stale or copy-pasted
   * one still compiles — it is a valid `TypePair` — while typing the query as
   * some other query's row shape.
   */
  function lintTypeArgument(
    node: ts.TaggedTemplateExpression,
    queryName: string,
  ) {
    const given = typeArgumentNameOf(node);
    if (given === undefined) {
      return;
    }
    const expected = `${interfacePrefix}${pascalCase(queryName)}Query`;
    if (given !== expected) {
      warnings.push(
        `${sourceFile.fileName}: query \`${queryName}\` is typed as \`${given}\`, expected \`${expected}\`. ` +
          `Codegen generates \`${expected}\` for this query, so a different type argument either belongs to another query or is left over from a rename.`,
      );
    }
  }

  function parseNode(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = readSqlTag(node.tag);
      const text = tag && tagText(node.template);
      if (tag?.kind === 'invalid') {
        // Fatal: without the name codegen cannot tell what the generated
        // types should be called, and guessing would name them after a
        // variable the runtime never sees.
        errors.push(`${sourceFile.fileName}: ${tag.reason}`);
      } else if (text && 'reason' in text) {
        // Fatal for the same reason: the tag's text is not the text the
        // runtime will hold, so there is nothing honest to generate from.
        errors.push(`${sourceFile.fileName}: ${text.reason}`);
      } else if (text && tag?.kind === 'prepared' && tag.name !== undefined) {
        // The explicit name wins, exactly as `@name` does in a `.sql` file,
        // so the generated types follow the statement and not the variable.
        const variableName = variableNameOf(node);
        const expected = camelCase(tag.name);
        if (variableName !== undefined && variableName !== expected) {
          warnings.push(
            `${sourceFile.fileName}: statement \`${tag.name}\` is held by variable \`${variableName}\`, expected \`${expected}\`. ` +
              `A statement name that does not match its variable means finding the query in pg_stat_statements no longer leads back to the code, ` +
              `which is the point of naming it.`,
          );
        }
        lintTypeArgument(node, tag.name);
        foundNodes.push({ queryName: tag.name, queryText: text.text });
      } else if (text) {
        // A plain tag, or a `sql.prepared()` that derives its name: either way
        // the variable is the only name codegen has to work from.
        const queryName = node.parent.getChildren()[0].getText();
        lintTypeArgument(node, queryName);
        foundNodes.push({ queryName, queryText: text.text });
      }
    }

    ts.forEachChild(node, parseNode);
  }

  const queries: QueryIR[] = [];
  for (const node of foundNodes) {
    // parseTagged throws on a `$param` whose inline selections disagree
    // between references. Catch per tag so one bad template is reported by
    // name rather than aborting the file with a stack trace.
    try {
      queries.push(parseTagged(node.queryText, node.queryName));
    } catch (err) {
      errors.push(
        `${sourceFile.fileName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { queries, errors, warnings };
}

export const parseCode = (
  fileContent: string,
  fileName = 'unnamed.ts',
  interfacePrefix = '',
) => {
  const sourceFile = ts.createSourceFile(
    fileName,
    fileContent,
    ts.ScriptTarget.ES2015,
    true,
  );
  return parseFile(sourceFile, interfacePrefix);
};
