// packages/runtime/src/scanner.ts
import type { Key, Loc } from './ir.js';

/** A run of input that is either code or opaque (string, comment, quoted identifier). */
export interface Span extends Loc {
  kind: 'code' | 'opaque';
}

/**
 * Splits SQL text into code and opaque spans. Params are only recognised in
 * code spans, so `:name` inside a string, a comment or a double-quoted
 * identifier is left alone. Everything inside a code span is treated as
 * undifferentiated text: this is not a SQL parser and never needs to be one.
 *
 * Unterminated constructs run to end of input rather than throwing, because a
 * half-typed file in watch mode is a normal state, not an exception.
 *
 * Spans are contiguous and ordered but not alternating: a string followed
 * immediately by a block comment yields two adjacent opaque spans, because the
 * empty code span between them is dropped.
 */
export function spans(text: string, opts: { dollarQuotes: boolean }): Span[] {
  const out: Span[] = [];
  let start = 0;
  let i = 0;

  const cut = (kind: Span['kind'], end: number): void => {
    if (end > start) out.push({ kind, a: start, b: end });
    start = end;
  };

  /**
   * From an opening quote at `i`, the index just past its closing quote. A
   * doubled quote is always an escape.
   *
   * A backslash is an escape only in an `E'...'` string. Under
   * standard_conforming_strings, on by default since 9.1, `'a\\'` is a
   * complete string whose content is a backslash. Getting this wrong in
   * either direction closes the string at the wrong place, which turns the
   * rest of the file opaque and silently drops every later parameter.
   */
  const closeQuoted = (quote: string): number => {
    const escapes =
      quote === "'" &&
      /(?:^|[^A-Za-z0-9_])[Ee]$/.test(text.slice(Math.max(0, i - 2), i));
    let j = i + 1;
    while (j < text.length) {
      const c = text[j];
      if (escapes && c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) {
        if (text[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return text.length;
  };

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (c === '-' && n === '-') {
      cut('code', i);
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      cut('opaque', i);
      continue;
    }
    if (c === '/' && n === '*') {
      cut('code', i);
      // Postgres nests block comments, so scanning to the first `*/` would end
      // the comment early and treat the tail as code. Commenting out a chunk
      // that already contains a comment is ordinary, and the failure is
      // silent: params inside it would become real generated params.
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j++;
      }
      i = depth === 0 ? j : text.length;
      cut('opaque', i);
      continue;
    }
    if (c === "'" || c === '"') {
      cut('code', i);
      i = closeQuoted(c);
      cut('opaque', i);
      continue;
    }
    if (opts.dollarQuotes && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        cut('code', i);
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? text.length : close + tag.length;
        cut('opaque', i);
        continue;
      }
    }
    i++;
  }
  cut('code', text.length);
  return out;
}

/** Half-open span `[a, b)` covers the whole reference: sigil and inline selection included. */
export interface ParamRef extends Loc {
  name: string;
  required: boolean;
  /** `$$name`. Always false for the `:` sigil. */
  spread: boolean;
  /** `$name(k!, k)`. Always undefined for the `:` sigil. */
  keys: Key[] | undefined;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const KEY_LIST = new RegExp(`^\\s*${IDENT}!?(\\s*,\\s*${IDENT}!?)*\\s*,?\\s*$`);

function parseKeys(list: string): Key[] {
  return list
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => ({ name: k.replace(/!$/, ''), required: k.endsWith('!') }));
}

/**
 * Every parameter reference in `text`, in source order.
 *
 * `:` is the `.sql`-file sigil. The lookbehind excludes `::` casts, and a
 * slice with numeric bounds (`arr[1:2]`) is excluded because a digit is not an
 * identifier start. A slice with a non-numeric upper bound is NOT excluded:
 * `tags[lo:hi]` reports `hi` as a param, exactly as the old ANTLR grammar did.
 * Transforms come from `@param` annotations, so `:` refs carry no selection.
 *
 * `$` is the tag sigil: `$$name` is a spread and `$name(a, b!)` is an inline
 * pick. `$1` is a positional placeholder and not ours. A parenthesised group
 * after a scalar is only a selection when its contents are exactly a key list;
 * `$id (SELECT ...)` is a scalar followed by a subquery. That sniff is how the
 * old grammar disambiguated too, and it inherits the same blind spot: a group
 * whose contents happen to look like a key list, such as `$id (t)`, reads as a
 * pick. A malformed selection degrades to a scalar and leaves the group in the
 * SQL rather than reporting a diagnostic.
 *
 * The selection is matched against the enclosing code span, so a quote or
 * comment inside the parentheses hides the closing `)` and the reference stays
 * a scalar.
 */
export function scanParams(text: string, sigil: ':' | '$'): ParamRef[] {
  const re =
    sigil === ':'
      ? new RegExp(`(?<!:):(${IDENT})(!?)`, 'g')
      : new RegExp(`(?<!\\$)(\\$\\$?)(${IDENT})(!?)`, 'g');
  const refs: ParamRef[] = [];

  for (const span of spans(text, { dollarQuotes: sigil === ':' })) {
    if (span.kind !== 'code') continue;
    const code = text.slice(span.a, span.b);

    for (const m of code.matchAll(re)) {
      const at = span.a + m.index;
      let end = at + m[0].length;
      let keys: Key[] | undefined;
      const spread = sigil === '$' && m[1] === '$$';
      const name = sigil === ':' ? m[1] : m[2];
      const required = (sigil === ':' ? m[2] : m[3]) === '!';

      if (sigil === '$') {
        const rest = code.slice(m.index + m[0].length);
        const sel = /^\s*\(([^)]*)\)/.exec(rest);
        if (sel && KEY_LIST.test(sel[1])) {
          keys = parseKeys(sel[1]);
          end += sel[0].length;
        }
      }
      refs.push({ name, required, a: at, b: end, spread, keys });
    }
  }
  return refs;
}
