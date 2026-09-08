// packages/runtime/src/parse-sql-file.ts
import type {
  ColumnHint,
  Diagnostic,
  Key,
  ParamIR,
  QueryIR,
  Transform,
} from './ir.js';
import { scanParams, spans } from './scanner.js';

export interface SqlFileParse {
  queries: QueryIR[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const KEYS = `\\s*${IDENT}!?(?:\\s*,\\s*${IDENT}!?)*\\s*,?\\s*`;

function keys(list: string): Key[] {
  return list
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => ({ name: k.replace(/!$/, ''), required: k.endsWith('!') }));
}

/** `(...)` | `(a, b!)` | `((a, b)...)`, or undefined if unrecognised. */
function transform(rule: string): Transform | undefined {
  const r = rule.trim();
  if (/^\(\s*\.\.\.\s*\)$/.test(r)) return { type: 'array_spread' };
  const spread = new RegExp(`^\\(\\((${KEYS})\\)\\s*\\.\\.\\.\\s*\\)$`).exec(r);
  if (spread) return { type: 'pick_array_spread', keys: keys(spread[1]) };
  const pick = new RegExp(`^\\((${KEYS})\\)$`).exec(r);
  if (pick) return { type: 'pick_tuple', keys: keys(pick[1]) };
  return undefined;
}

interface Block {
  name: string;
  params: Map<string, Transform>;
  columns: ColumnHint[];
}

/** Reads the annotations out of the text between the comment delimiters. Returns undefined if there is no `@name`. */
function readBlock(
  inner: string,
  offset: number,
  errors: Diagnostic[],
): Block | undefined {
  const name = /@name\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(inner);
  if (!name) return undefined;
  const params = new Map<string, Transform>();
  for (const m of inner.matchAll(
    /@param\s+([A-Za-z_][A-Za-z0-9_]*)\s*->\s*(\([^@]*?\))(?=\s*(?:@|$))/gs,
  )) {
    const t = transform(m[2]);
    if (t) params.set(m[1], t);
    else
      errors.push({
        message: `Cannot parse transform for @param ${m[1]}: ${m[2].trim()}`,
        offset: offset + m.index,
      });
  }
  const columns: ColumnHint[] = [];
  for (const m of inner.matchAll(/@column\s+([A-Za-z_][A-Za-z0-9_]*)([!?])/g)) {
    columns.push({ name: m[1], nullable: m[2] === '?' });
  }
  return { name: name[1], params, columns };
}

/**
 * Splits a `.sql` file into queries. Each query is a `/* @name ... *∕` block
 * followed by one statement, ended by `;` or end of input. Other comments are
 * ignored; a statement without a block is an error.
 */
export function parseSqlFile(text: string): SqlFileParse {
  const queries: QueryIR[] = [];
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const all = spans(text, { dollarQuotes: true });

  let block: Block | undefined;
  let blockEnd = 0;
  let bodyStart: number | undefined;

  const finish = (end: number): void => {
    const raw = text.slice(bodyStart ?? blockEnd, end);
    const statement = raw.trim();
    bodyStart = undefined;
    if (statement === '') return;
    if (!block) {
      errors.push({
        message: 'Statement has no /* @name ... */ block',
        offset: end - raw.length,
      });
      return;
    }
    const lead = raw.length - raw.trimStart().length;
    const byName = new Map<string, ParamIR>();
    for (const ref of scanParams(statement, ':')) {
      const existing = byName.get(ref.name);
      const loc = { a: ref.a, b: ref.b };
      if (existing) {
        existing.locs.push(loc);
        existing.required ||= ref.required;
      } else {
        byName.set(ref.name, {
          name: ref.name,
          transform: block.params.get(ref.name) ?? { type: 'scalar' },
          required: ref.required,
          locs: [loc],
        });
      }
    }
    for (const declared of block.params.keys()) {
      if (!byName.has(declared)) {
        warnings.push({
          message: `Parameter "${declared}" is defined but never used`,
          offset: blockEnd - lead,
        });
      }
    }
    queries.push({
      queryName: block.name,
      statement,
      params: [...byName.values()],
      columns: block.columns,
    });
    block = undefined;
  };

  for (const span of all) {
    const chunk = text.slice(span.a, span.b);
    if (
      span.kind === 'opaque' &&
      chunk.startsWith('/*') &&
      bodyStart === undefined
    ) {
      const read = readBlock(
        chunk.slice(2, chunk.endsWith('*/') ? -2 : undefined),
        span.a,
        errors,
      );
      if (read) {
        block = read;
        blockEnd = span.b;
        continue;
      }
    }
    if (span.kind === 'code') {
      let from = span.a;
      for (;;) {
        const semi = text.indexOf(';', from);
        if (semi === -1 || semi >= span.b) break;
        if (bodyStart === undefined) bodyStart = blockEnd;
        finish(semi);
        blockEnd = semi + 1;
        from = semi + 1;
      }
      if (bodyStart === undefined && text.slice(from, span.b).trim() !== '')
        bodyStart = blockEnd;
    } else if (bodyStart === undefined && block) {
      bodyStart = blockEnd;
    }
  }
  finish(text.length);
  return { queries, warnings, errors };
}
