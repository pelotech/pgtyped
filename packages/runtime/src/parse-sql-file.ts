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

/**
 * Annotation rules. Every rule is line-scoped: it may not cross a newline, and
 * it ends at the next annotation or at the end of its line. A rule that could
 * span lines would either be swallowed by a following description line or
 * stretch across one to reach a later `)`, and in both cases the declaration
 * is lost: the param silently degrades to `scalar`, which renders one
 * placeholder where the SQL needs a list and lets codegen name a statement
 * that must stay unnamed. Always use PARAM_RULE with the `m` flag, so `$` in
 * its lookahead means end of line.
 */
const NAME_RULE = `@name\\s+(${IDENT})`;
const PARAM_RULE = `@param\\s+(${IDENT})\\s*->\\s*(\\([^\\n]*?\\))(?=\\s*(?:@|$))`;
const COLUMN_RULE = `@column\\s+(${IDENT})([!?])`;

/**
 * An `@` that starts a word. Prose is free to contain `foo@bar.com` or a bare
 * `@`; only a word-initial `@` followed by letters is claimed as an
 * annotation and held to a rule.
 */
const ANNOTATION = /(?<![A-Za-z0-9_@])@([A-Za-z]+)/g;

/** Whether `rule` matches `text` starting exactly at `at`. */
function matchesAt(
  rule: string,
  text: string,
  at: number,
): RegExpExecArray | null {
  const re = new RegExp(rule, 'my');
  re.lastIndex = at;
  return re.exec(text);
}

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

/** A `@param` declaration: its transform, and where it was written. */
interface Declared {
  transform: Transform;
  /** Offset of the `@param` in the source text, for diagnostics about it. */
  offset: number;
}

interface Block {
  name: string;
  /** Offset of the `@name` in the source text. */
  offset: number;
  params: Map<string, Declared>;
  columns: ColumnHint[];
}

/**
 * Reports every `@…` in the block that is not a well-formed annotation, plus
 * the duplicates that would otherwise be silently overwritten. This is a
 * backstop as much as a courtesy: an annotation that no rule matches is a
 * declaration the user believes they made and the parser never saw.
 */
function checkAnnotations(
  inner: string,
  offset: number,
  nameAt: number,
  errors: Diagnostic[],
): void {
  const seen = new Set<string>();
  for (const m of inner.matchAll(ANNOTATION)) {
    const at = m.index;
    const report = (message: string): void => {
      errors.push({ message, offset: offset + at });
    };
    if (m[1] === 'name') {
      // The first well-formed @name is the block's; any other is ignored.
      if (at !== nameAt)
        report('Duplicate @name annotation; the first one wins');
    } else if (m[1] === 'param') {
      const p = matchesAt(PARAM_RULE, inner, at);
      if (!p)
        report('Malformed @param annotation; expected `@param name -> (...)`');
      else if (seen.has(p[1]))
        report(`Duplicate @param ${p[1]}; the last one wins`);
      else seen.add(p[1]);
    } else if (m[1] === 'column') {
      if (!matchesAt(COLUMN_RULE, inner, at))
        report(
          'Malformed @column annotation; expected `@column name!` or `@column name?`',
        );
    } else {
      report(`Unrecognised annotation @${m[1]}`);
    }
  }
}

/**
 * Reads the annotations out of the text between the comment delimiters.
 * Returns undefined if there is no `@name`, which is how an ordinary comment
 * is told from a header block. `offset` is the offset of `inner` in the source
 * text, so diagnostics point at the annotation they describe.
 */
function readBlock(
  inner: string,
  offset: number,
  errors: Diagnostic[],
): Block | undefined {
  const name = new RegExp(NAME_RULE).exec(inner);
  if (!name) return undefined;

  const params = new Map<string, Declared>();
  let read = 0;
  for (const m of inner.matchAll(new RegExp(PARAM_RULE, 'gm'))) {
    read++;
    const t = transform(m[2]);
    if (t) params.set(m[1], { transform: t, offset: offset + m.index });
    else
      errors.push({
        message: `Cannot parse transform for @param ${m[1]}: ${m[2].trim()}`,
        offset: offset + m.index,
      });
  }
  // A declaration must never disappear without a diagnostic, so count what was
  // written and insist the rule read all of it.
  const written = (inner.match(/@param\s/g) ?? []).length;
  if (written > read)
    errors.push({
      message: `Block @name ${name[1]} declares ${written} @param annotations but only ${read} could be read`,
      offset: offset + name.index,
    });

  const columns: ColumnHint[] = [];
  for (const m of inner.matchAll(new RegExp(COLUMN_RULE, 'g')))
    columns.push({ name: m[1], nullable: m[2] === '?' });

  checkAnnotations(inner, offset, name.index, errors);
  return { name: name[1], offset: offset + name.index, params, columns };
}

/**
 * Splits a `.sql` file into queries. Each query is a `/* @name ... *∕` block
 * followed by one statement, ended by `;`, by the next `@name` block, or by
 * end of input.
 *
 * Only comments *before* a block are ignored. A comment between the block and
 * the end of the statement is part of `statement`, verbatim — `statement` is
 * what codegen hashes into the prepared statement name, so it is reported
 * exactly as it will be sent. A statement with no block, a block with no
 * statement, and a statement not ended by `;` are all errors.
 *
 * `errors` is fatal: when it is non-empty, `queries` must not be used. A query
 * whose `@param` could not be read is still emitted, with that param fallen
 * back to `scalar` — which is precisely the wrong SQL — so the diagnostics,
 * not the queries, are the result in that case.
 */
export function parseSqlFile(text: string): SqlFileParse {
  const queries: QueryIR[] = [];
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const all = spans(text, { dollarQuotes: true });

  let block: Block | undefined;
  /** Where the current statement starts: just past the block, or past the last `;`. */
  let blockEnd = 0;
  /** Whether a statement body has started; if so, an `@name` block ends it. */
  let inBody = false;

  const finish = (end: number, unterminated = false): void => {
    const raw = text.slice(blockEnd, end);
    const statement = raw.trim();
    const lead = raw.length - raw.trimStart().length;
    inBody = false;
    if (statement === '') return;
    if (unterminated)
      errors.push({
        message: block
          ? `Statement for @name ${block.name} is not terminated by ";"`
          : 'Statement is not terminated by ";"',
        offset: end - raw.length + lead,
      });
    if (!block) {
      errors.push({
        message: 'Statement has no /* @name ... */ block',
        offset: end - raw.length + lead,
      });
      return;
    }
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
          transform: block.params.get(ref.name)?.transform ?? {
            type: 'scalar',
          },
          required: ref.required,
          locs: [loc],
        });
      }
    }
    for (const [declared, { offset }] of block.params) {
      if (!byName.has(declared)) {
        warnings.push({
          message: `Parameter "${declared}" is defined but never used`,
          offset,
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

  /** A block that never got a statement produces no export, so say so. */
  const discard = (): void => {
    if (block)
      errors.push({
        message: `Block @name ${block.name} has no statement`,
        offset: block.offset,
      });
    block = undefined;
  };

  for (const span of all) {
    const chunk = text.slice(span.a, span.b);
    if (span.kind === 'opaque' && chunk.startsWith('/*')) {
      const read = readBlock(
        chunk.slice(2, chunk.endsWith('*/') ? -2 : undefined),
        span.a + 2,
        errors,
      );
      if (read) {
        // A header block is a hard statement boundary. Absorbing it into an
        // unterminated statement above would drop this query entirely and ship
        // the comment inside the previous one's prepared statement text.
        if (inBody) finish(span.a, true);
        discard();
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
        finish(semi);
        blockEnd = semi + 1;
        from = semi + 1;
      }
      if (!inBody && text.slice(from, span.b).trim() !== '') inBody = true;
    } else if (!inBody && block) {
      inBody = true;
    }
  }
  finish(text.length);
  discard();
  return { queries, warnings, errors };
}
