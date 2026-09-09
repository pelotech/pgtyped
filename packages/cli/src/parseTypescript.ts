import { parseTagged, type QueryIR } from '@pelotech/pgtyped-runtime/internal';
import ts from 'typescript';

interface INode {
  queryName: string;
  queryText: string;
}

/**
 * `errors` holds already-formatted messages, one per `sql` tag that could not
 * be parsed. They are fatal for the whole file: the queries that did parse are
 * still returned, but codegen must not emit from a file it only half read.
 */
export type TSParseResult = { queries: QueryIR[]; errors: string[] };

export function parseFile(sourceFile: ts.SourceFile): TSParseResult {
  const foundNodes: INode[] = [];
  parseNode(sourceFile);

  function parseNode(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.TaggedTemplateExpression) {
      const queryName = node.parent.getChildren()[0].getText();
      const taggedTemplateNode = node as ts.TaggedTemplateExpression;
      const tagName = taggedTemplateNode.tag.getText();
      const queryText = taggedTemplateNode.template
        .getText()
        .replace('\n', '')
        .slice(1, -1)
        .trim();
      if (tagName === 'sql') {
        foundNodes.push({
          queryName,
          queryText,
        });
      }
    }

    ts.forEachChild(node, parseNode);
  }

  const queries: QueryIR[] = [];
  const errors: string[] = [];
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

  return { queries, errors };
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
