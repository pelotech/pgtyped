// packages/runtime/src/scanner.ts
import type { Key } from './ir.js';

/** A run of input that is either code or opaque (string, comment, quoted identifier). */
export interface Span {
  kind: 'code' | 'opaque';
  a: number;
  b: number;
}

/**
 * Splits SQL text into code and opaque spans. Params are only recognised in
 * code spans, so `:name` inside a string, a comment or a double-quoted
 * identifier is left alone. Everything inside a code span is treated as
 * undifferentiated text: this is not a SQL parser and never needs to be one.
 *
 * Unterminated constructs run to end of input rather than throwing, because a
 * half-typed file in watch mode is a normal state, not an exception.
 */
export function spans(text: string, opts: { dollarQuotes: boolean }): Span[] {
  const out: Span[] = [];
  let start = 0;
  let i = 0;

  const cut = (kind: Span['kind'], end: number): void => {
    if (end > start) out.push({ kind, a: start, b: end });
    start = end;
  };

  /** From an opening quote at `i`, the index just past its closing quote. A doubled quote is an escape. */
  const closeQuoted = (quote: string): number => {
    let j = i + 1;
    for (;;) {
      const q = text.indexOf(quote, j);
      if (q === -1) return text.length;
      if (text[q + 1] === quote) {
        j = q + 2;
        continue;
      }
      return q + 1;
    }
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
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
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

export interface ParamRef {
  name: string;
  required: boolean;
  /** Half-open span of the whole reference, sigil and inline selection included. */
  a: number;
  b: number;
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
 * `:` is the `.sql`-file sigil: `::` is a cast and `[1:2]` is a slice, and
 * neither is followed by an identifier, so a single regex excludes both.
 * Transforms come from `@param` annotations, so `:` refs carry no selection.
 *
 * `$` is the tag sigil: `$$name` is a spread and `$name(a, b!)` is an inline
 * pick. `$1` is a positional placeholder and not ours. A parenthesised group
 * after a scalar is only a selection when its contents are exactly a key list;
 * `$id (SELECT ...)` is a scalar followed by a subquery.
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
