// packages/runtime/src/parse-sql-file.ts
import type {
  ColumnHint,
  Diagnostic,
  ParamIR,
  QueryIR,
  Transform,
} from './ir.js';
import {
  KEY_LIST_SOURCE,
  parseKeys,
  scanParams,
  scanQuotedParams,
  spans,
} from './scanner.js';

export interface SqlFileParse {
  queries: QueryIR[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
/**
 * Shared with the tag front-end so that `(id!::int4, val::text)` means the same
 * thing written either way. `parseKeys` throws on a key this admits but cannot
 * read, which `readBlock` turns into a diagnostic naming the `@param`.
 */
const KEYS = KEY_LIST_SOURCE;

const NAME_RULE = `@name\\s+(${IDENT})`;

/**
 * What a header block has to open with. Leading whitespace and the `*` that
 * decorates a multi-line comment are all that may come before the `@name`, so
 * the decorated form, where every line opens with a `*`, still qualifies.
 *
 * Mentioning `@name` is not enough. A comment written inside a statement that
 * refers to one — `\/* WHERE id = :x -- see @name GetUsersById *∕` — would
 * otherwise be promoted to a header, inventing a query and cutting the
 * statement it was written in half. Requiring the annotation to come first
 * tells the two apart without weakening the rule that a header ends the
 * statement above it, which is what reports a missing `;`.
 */
const HEADER_START = /^[\s*]*@name\s/;

/** Matches up to the transform's opening paren; `readRule` finds its close. */
const PARAM_HEAD = `@param\\s+(${IDENT})\\s*->\\s*(?=\\()`;
const COLUMN_RULE = `@column\\s+(${IDENT})([!?])`;

/**
 * A transform rule starting at the `(` at `from`, ending just past its
 * balanced closing paren, or undefined if it never closes.
 *
 * The end has to come from paren balance rather than a newline or a lookahead.
 * Ending at a newline would reject a rule wrapped across lines, which the old
 * ANTLR grammar accepted because it skipped newlines inside comments. Ending
 * at "the next annotation or end of block" would let a trailing description
 * line swallow the rule entirely. Both failures land in the same place: the
 * declaration is lost, the param degrades to `scalar`, and the query renders
 * one placeholder where the SQL needs a list — while codegen, seeing no
 * variable-arity param, assigns a statement name that must never exist.
 */
function readRule(text: string, from: number): string | undefined {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(from, i + 1);
  }
  return undefined;
}

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

/**
 * `(...)` | `(a, b!::int4)` | `((a, b)...)`, or undefined if unrecognised.
 * Throws, rather than returning undefined, on a key list that is shaped like
 * one but contains a key `parseKeys` will not read: the shape is unambiguous
 * enough to say what is wrong with it.
 */
function transform(rule: string): Transform | undefined {
  const r = rule.trim();
  if (/^\(\s*\.\.\.\s*\)$/.test(r)) return { type: 'array_spread' };
  const spread = new RegExp(`^\\(\\((${KEYS})\\)\\s*\\.\\.\\.\\s*\\)$`).exec(r);
  if (spread) return { type: 'pick_array_spread', keys: parseKeys(spread[1]) };
  const pick = new RegExp(`^\\((${KEYS})\\)$`).exec(r);
  if (pick) return { type: 'pick_tuple', keys: parseKeys(pick[1]) };
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
 *
 * Severity is drawn by consequence. A malformed `@param` or `@column` and a
 * duplicate `@name` change what is generated, so they are errors and the file
 * emits nothing. An annotation nobody recognises cannot: `@deprecated` on a
 * query is documentation, and failing the build over it stops the project
 * dead. It stays a warning, which still surfaces a typo like `@nmae` and which
 * `failOnError` promotes for anyone who wants the strict reading.
 */
function checkAnnotations(
  inner: string,
  offset: number,
  nameAt: number,
  errors: Diagnostic[],
  warnings: Diagnostic[],
): void {
  const seen = new Set<string>();
  for (const m of inner.matchAll(ANNOTATION)) {
    const at = m.index;
    const report = (into: Diagnostic[], message: string): void => {
      into.push({ message, offset: offset + at });
    };
    if (m[1] === 'name') {
      // The first well-formed @name is the block's; any other is ignored.
      if (at !== nameAt)
        report(errors, 'Duplicate @name annotation; the first one wins');
    } else if (m[1] === 'param') {
      const p = matchesAt(PARAM_HEAD, inner, at);
      if (!p || readRule(inner, at + p[0].length) === undefined)
        report(
          errors,
          'Malformed @param annotation; expected `@param name -> (...)`',
        );
      else if (seen.has(p[1]))
        report(errors, `Duplicate @param ${p[1]}; the last one wins`);
      else seen.add(p[1]);
    } else if (m[1] === 'column') {
      if (!matchesAt(COLUMN_RULE, inner, at))
        report(
          errors,
          'Malformed @column annotation; expected `@column name!` or `@column name?`',
        );
    } else {
      report(warnings, `Unrecognised annotation @${m[1]}`);
    }
  }
}

/**
 * Reads the annotations out of the text between the comment delimiters.
 * Returns undefined if the block does not open with `@name`, which is how an
 * ordinary comment is told from a header block. `offset` is the offset of `inner` in the source
 * text, so diagnostics point at the annotation they describe.
 */
function readBlock(
  inner: string,
  offset: number,
  errors: Diagnostic[],
  warnings: Diagnostic[],
): Block | undefined {
  if (!HEADER_START.test(inner)) return undefined;
  const name = new RegExp(NAME_RULE).exec(inner);
  if (!name) return undefined;

  const params = new Map<string, Declared>();
  let read = 0;
  for (const m of inner.matchAll(new RegExp(PARAM_HEAD, 'g'))) {
    const rule = readRule(inner, m.index + m[0].length);
    if (rule === undefined) continue;
    read++;
    let t: Transform | undefined;
    try {
      t = transform(rule);
    } catch (err) {
      errors.push({
        message: `Cannot parse transform for @param ${m[1]}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        offset: offset + m.index,
      });
      continue;
    }
    if (t) params.set(m[1], { transform: t, offset: offset + m.index });
    else
      errors.push({
        message: `Cannot parse transform for @param ${m[1]}: ${rule.trim()}`,
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

  checkAnnotations(inner, offset, name.index, errors, warnings);
  return { name: name[1], offset: offset + name.index, params, columns };
}

/**
 * Splits a `.sql` file into queries. Each query is a `/* @name ... *∕` block
 * followed by one statement, ended by `;`, by the next `@name` block, or by
 * end of input.
 *
 * Only comments *before* a block are ignored. A comment between the block and
 * the end of the statement is part of `statement`, verbatim — it is sent to
 * the server as written, and so feeds the hash in the prepared statement name,
 * which is why it is reported exactly as it will be sent.
 *
 * A statement with no block and a block with no statement are errors. So is a
 * statement ended by the next `@name` block rather than by `;`, since dropping
 * the `;` there silently welds two queries together. The last statement in the
 * file is deliberately exempt: end of input is an unambiguous end, so a file
 * whose final query omits its `;` parses.
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
    // A `:name` inside `$$ … $$` is a string to Postgres, so it generates no
    // parameter and the query's params type comes out `void` with nothing said
    // about why (#549). Reading it as a string is correct and stays; only the
    // silence goes. A warning, not an error: a dollar-quoted body containing a
    // colon is legal SQL, and plenty of them mean it.
    for (const ref of scanQuotedParams(statement)) {
      warnings.push({
        message:
          `Parameter "${statement.slice(ref.a, ref.b)}" in @name ${block.name} is inside a ` +
          `dollar-quoted string (${ref.tag} … ${ref.tag}), so Postgres reads it as literal ` +
          `text: no parameter is generated for it and the sigil reaches the server as ` +
          `written. A dollar-quoted body cannot take parameters — if it was meant as one, ` +
          `the reference has to move outside the quotes.`,
        offset: blockEnd + lead + ref.a,
      });
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
        warnings,
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
