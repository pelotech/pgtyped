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
 * such as a `sql.named` name that does not match the variable holding it.
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
 *  - `named` is `` sql.named<T>('GetUsers')`…` ``, which carries its own name.
 *  - `invalid` is a `sql.named` whose name codegen cannot read.
 */
type SqlTag =
  | { kind: 'plain' }
  | { kind: 'named'; name: string }
  | { kind: 'invalid'; reason: string };

/**
 * Classifies the tag expression of a tagged template, on its AST shape rather
 * than its text: `sql.named<T>('X')` and `sql.named('X')` differ textually,
 * and so does any of them reformatted, but all are the same tag.
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
    callee.name.text !== 'named'
  ) {
    return undefined;
  }
  const [nameArg] = tag.arguments;
  if (!nameArg) {
    return {
      kind: 'invalid',
      reason: '`sql.named` was called without a statement name',
    };
  }
  // A no-substitution template is as readable here as a quoted string; a
  // variable, a concatenation or an interpolation is not.
  if (!ts.isStringLiteralLike(nameArg) || nameArg.text.trim() === '') {
    return {
      kind: 'invalid',
      reason: `\`sql.named\` needs a non-empty string literal name, got \`${nameArg.getText()}\``,
    };
  }
  return { kind: 'named', name: nameArg.text };
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
      } else if (tag?.kind === 'named') {
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
      } else if (tag?.kind === 'plain') {
        foundNodes.push({
          queryName: node.parent.getChildren()[0].getText(),
          queryText,
        });
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
