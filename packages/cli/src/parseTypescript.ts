import { parseTagged, type QueryIR } from '@pelotech/pgtyped-runtime/internal';
import { camelCase } from 'change-case';
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
 * such as a `sql.prepared` name that does not match the variable holding it.
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

export function parseFile(sourceFile: ts.SourceFile): TSParseResult {
  const foundNodes: INode[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  parseNode(sourceFile);

  function parseNode(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = readSqlTag(node.tag);
      const queryText = node.template
        .getText()
        .replace('\n', '')
        .slice(1, -1)
        .trim();
      if (tag?.kind === 'invalid') {
        // Fatal: without the name codegen cannot tell what the generated
        // types should be called, and guessing would name them after a
        // variable the runtime never sees.
        errors.push(`${sourceFile.fileName}: ${tag.reason}`);
      } else if (tag?.kind === 'prepared' && tag.name !== undefined) {
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
        foundNodes.push({ queryName: tag.name, queryText });
      } else if (tag) {
        // A plain tag, or a `sql.prepared()` that derives its name: either way
        // the variable is the only name codegen has to work from.
        const queryName = node.parent.getChildren()[0].getText();
        foundNodes.push({ queryName, queryText });
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

export const parseCode = (fileContent: string, fileName = 'unnamed.ts') => {
  const sourceFile = ts.createSourceFile(
    fileName,
    fileContent,
    ts.ScriptTarget.ES2015,
    true,
  );
  return parseFile(sourceFile);
};
