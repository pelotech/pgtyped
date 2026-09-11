// packages/runtime/src/scanner.ts
import type { Key, Loc } from './ir.js';

/** A run of input that is either code or opaque (string, comment, quoted identifier). */
export interface Span extends Loc {
  kind: 'code' | 'opaque';
}

/** An opening dollar-quote delimiter, `$$` or `$tag$`, anchored at the start. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

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
      const m = DOLLAR_TAG.exec(text.slice(i));
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
  /** `$name(k!, k::int4)`. Always undefined for the `:` sigil. */
  keys: Key[] | undefined;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * What may follow a key's `::`. An identifier, optionally schema-qualified,
 * with any number of `[]` suffixes — nothing else. There is no whitespace in
 * it and no parenthesised modifier, so the multi-word spellings are out:
 * write `timestamptz`, `varchar`, `float8` and `numeric` rather than
 * `timestamp with time zone`, `character varying`, `double precision` or
 * `numeric(10,2)`. Every multi-word type has a single-word alias, and a
 * modifier cannot change the OID that `ParameterDescription` reports, so
 * nothing is out of reach.
 *
 * The narrowness is the point: the text goes into the SQL verbatim, so a
 * grammar that admitted arbitrary text would admit arbitrary SQL.
 */
const KEY_TYPE = new RegExp(`^${IDENT}(?:\\.${IDENT})?(?:\\[\\])*$`);

/**
 * One key of a selection: `name`, `name!`, `name::type` or `name!::type`.
 *
 * The cast body is matched loosely here — everything up to the next comma or
 * the closing paren — and checked by `parseKey`. Matching `KEY_TYPE` in this
 * position instead would send a mistyped cast back to the subquery branch
 * below, where a group that is not a key list is silently left in the SQL; a
 * loose match keeps it a selection so the mistake can be reported.
 */
const KEY = `${IDENT}!?(?:\\s*::[^,)]*)?`;

/** The body of a selection, as a source fragment the `.sql` front-end embeds too. */
export const KEY_LIST_SOURCE = `\\s*${KEY}(?:\\s*,\\s*${KEY})*\\s*,?\\s*`;
const KEY_LIST = new RegExp(`^${KEY_LIST_SOURCE}$`);

/**
 * One key, or a throw naming it.
 *
 * `!` comes before the cast — `id!::int4`, never `id::int4!` — so that the
 * marker always sits directly on the name it qualifies. That is already how a
 * scalar reference reads: `:id!::int4` parses today, the `!` binding to the
 * name and the cast going to the server untouched. The reversed spelling is
 * rejected by name rather than by the general type error, because it is the
 * mistake anyone who knows the `!` marker will make first.
 */
function parseKey(text: string): Key {
  const at = text.indexOf('::');
  const head = (at === -1 ? text : text.slice(0, at)).trimEnd();
  const name = head.replace(/!$/, '');
  const required = head.endsWith('!');
  if (at === -1) return { name, required };

  const type = text.slice(at + 2).trim();
  if (type.endsWith('!') && KEY_TYPE.test(type.slice(0, -1)))
    throw new Error(
      `Key "${text.trim()}" writes "!" after the cast; a required typed key is ` +
        `"${name}!::${type.slice(0, -1)}", with "!" on the name`,
    );
  if (!KEY_TYPE.test(type))
    throw new Error(
      `Key "${name}" is cast to "${type}", which is not a usable type name: a key ` +
        `type is an identifier, optionally schema-qualified, with any number of "[]" ` +
        `suffixes — "int4", "public.my_enum", "text[]". Multi-word types have ` +
        `single-word aliases: "timestamptz", "varchar", "float8".`,
    );
  return { name, required, type };
}

/** Throws on a key that `KEY` admitted but `parseKey` will not have. */
export function parseKeys(list: string): Key[] {
  return list
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map(parseKey);
}

/**
 * What counts as a reference, for a sigil. The single source of truth for it:
 * `scanQuotedParams` reports only what this matches, so a colon that is not a
 * parameter outside a dollar-quoted body is not called one inside it either.
 */
function paramRe(sigil: ':' | '$'): RegExp {
  return sigil === ':'
    ? new RegExp(`(?<!:):(${IDENT})(!?)`, 'g')
    : new RegExp(`(?<!\\$)(\\$\\$?)(${IDENT})(!?)`, 'g');
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
 * `$` is the tag sigil: `$$name` is a spread and `$name(a, b!::int4)` is an
 * inline pick. `$1` is a positional placeholder and not ours. A parenthesised
 * group after a scalar is only a selection when its contents are exactly a key
 * list; `$id (SELECT ...)` is a scalar followed by a subquery. That sniff is how
 * the old grammar disambiguated too, and it inherits the same blind spot: a
 * group whose contents happen to look like a key list, such as `$id (t)`, reads
 * as a pick. A group that is not a key list at all degrades to a scalar and is
 * left in the SQL rather than reporting a diagnostic.
 *
 * Key types do not widen that sniff into a subquery. `KEY` only admits a cast
 * body directly after an identifier, so `$x(a::int4)` is a selection while
 * `$x(SELECT 1::int4)` is still a subquery — `SELECT` is an identifier, but
 * what follows it is neither a `::`, a comma nor the end. What the loose cast
 * body buys is that a key list with an unusable type is reported here rather
 * than falling back to the subquery reading and reaching the server as SQL.
 *
 * The selection is matched against the enclosing code span, so a quote or
 * comment inside the parentheses hides the closing `)` and the reference stays
 * a scalar.
 */
export function scanParams(text: string, sigil: ':' | '$'): ParamRef[] {
  const re = paramRe(sigil);
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
          try {
            keys = parseKeys(sel[1]);
          } catch (err) {
            throw new Error(
              `Parameter "${name}": ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            );
          }
          end += sel[0].length;
        }
      }
      refs.push({ name, required, a: at, b: end, spread, keys });
    }
  }
  return refs;
}

/** A reference a dollar-quoted body swallowed: where it is, and what hid it. */
export interface QuotedParamRef extends Loc {
  name: string;
  /** The delimiter of the body it sits in: `$$`, or `$tag$`. */
  tag: string;
}

/**
 * Every parameter reference that sits inside a dollar-quoted body, in source
 * order — precisely the ones `scanParams` leaves alone.
 *
 * `$$ … $$` and `$tag$ … $tag$` are string literals to Postgres, so a `:name`
 * written inside one is literal text and no parameter is generated for it.
 * That is the right reading and nothing here changes it; what it changes is
 * that the reading can now be said out loud, because a query that quietly
 * types its params as `void` explains nothing to whoever wrote the `:name`.
 *
 * Two things keep it off ordinary PL/pgSQL, which is full of colons that were
 * never parameters. It matches with `paramRe`, so `x := 1`, `val::int` and
 * `arr[1:2]` are no more references in here than they are anywhere else — the
 * cost of a false positive is that every `DO` block in every project warns,
 * which teaches people to stop reading warnings. And it descends through the
 * body's own strings and comments, so the colon in `RAISE 'bad:thing'` is left
 * alone exactly as it would be outside. A nested dollar quote is still a
 * dollar quote, so what it contains is reported under its own tag.
 *
 * `:` only. The tag front-end's sigil is `$`, and `scanParams` scans a tag
 * with `dollarQuotes: false` because `$$name` is its spread: `$$ … $$` is not
 * a quoted body there, and a `$name` written between those delimiters is a
 * real parameter today. There is nothing to report.
 */
export function scanQuotedParams(text: string): QuotedParamRef[] {
  const re = paramRe(':');
  const refs: QuotedParamRef[] = [];

  /** `tag` is the body `chunk` sits in, or undefined at the top level. */
  const walk = (chunk: string, base: number, tag: string | undefined): void => {
    for (const span of spans(chunk, { dollarQuotes: true })) {
      const part = chunk.slice(span.a, span.b);
      if (span.kind === 'code') {
        if (tag === undefined) continue;
        for (const m of part.matchAll(re)) {
          const at = base + span.a + m.index;
          refs.push({
            name: m[1],
            a: at,
            b: at + m[0].length,
            tag,
          });
        }
        continue;
      }
      const open = DOLLAR_TAG.exec(part);
      // Any other opaque span is a string, a comment or a quoted identifier:
      // already invisible to params, and not what this is about.
      if (!open) continue;
      const [delim] = open;
      // An unterminated body runs to the end of the chunk, as `spans` cut it.
      const closed =
        part.endsWith(delim) && part.length >= delim.length * 2
          ? -delim.length
          : undefined;
      walk(
        part.slice(delim.length, closed),
        base + span.a + delim.length,
        delim,
      );
    }
  };

  walk(text, 0, undefined);
  return refs;
}
