// packages/runtime/src/scanner.test.ts
import { scanParams, scanQuotedParams, spans } from './scanner.js';

describe('spans', () => {
  const opaque = (text: string, dollarQuotes = true) =>
    spans(text, { dollarQuotes })
      .filter((s) => s.kind === 'opaque')
      .map((s) => text.slice(s.a, s.b));

  test('single-quoted strings, with doubled-quote escapes', () => {
    expect(opaque("SELECT 'a', 'it''s', 'b'")).toStrictEqual([
      "'a'",
      "'it''s'",
      "'b'",
    ]);
  });

  test('double-quoted identifiers, with doubled-quote escapes', () => {
    expect(opaque('SELECT "col", "we""ird"')).toStrictEqual([
      '"col"',
      '"we""ird"',
    ]);
  });

  test('line comments run to end of line', () => {
    expect(opaque('SELECT 1 -- :notaparam\nFROM t')).toStrictEqual([
      '-- :notaparam\n',
    ]);
  });

  test('block comments', () => {
    expect(opaque('/* :x */ SELECT /* :y */ 1')).toStrictEqual([
      '/* :x */',
      '/* :y */',
    ]);
  });

  test('dollar-quoted strings with and without a tag', () => {
    expect(opaque('SELECT $$:x$$, $fn$ :y $fn$')).toStrictEqual([
      '$$:x$$',
      '$fn$ :y $fn$',
    ]);
  });

  test('dollar quotes are off for tag syntax, where $$ means spread', () => {
    expect(opaque('SELECT $$ids', false)).toStrictEqual([]);
  });

  test('an unterminated string runs to end of input rather than throwing', () => {
    expect(opaque("SELECT 'oops")).toStrictEqual(["'oops"]);
  });
});

describe('scanParams with the : sigil (.sql files)', () => {
  const names = (sql: string) => scanParams(sql, ':').map((p) => p.name);

  test('finds :name references', () => {
    expect(
      names('SELECT * FROM books WHERE id = :id AND rank > :rank'),
    ).toStrictEqual(['id', 'rank']);
  });

  test('records required marks and exact locations', () => {
    const [p] = scanParams('WHERE id = :id!', ':');
    expect(p).toStrictEqual({
      name: 'id',
      required: true,
      a: 11,
      b: 15,
      spread: false,
      keys: undefined,
    });
  });

  test('ignores casts', () => {
    expect(names('SELECT :id::int, x::text')).toStrictEqual(['id']);
  });

  test('ignores array slices', () => {
    expect(names('SELECT arr[1:2], :id')).toStrictEqual(['id']);
  });

  test('ignores references inside strings, comments and identifiers', () => {
    expect(names(`SELECT ':a', "b:c", /* :d */ :e -- :f`)).toStrictEqual(['e']);
  });

  test('reports every reference of a param used twice', () => {
    const refs = scanParams('WHERE a = :id OR b = :id', ':');
    expect(refs.map((r) => r.name)).toStrictEqual(['id', 'id']);
    expect(refs[0].a).not.toBe(refs[1].a);
  });
});

describe('scanParams with the $ sigil (sql tags)', () => {
  test('scalar, required, and cast', () => {
    const [p] = scanParams('HAVING count(*) > $minCommentCount!::int', '$');
    expect(p).toStrictEqual({
      name: 'minCommentCount',
      required: true,
      a: 18,
      b: 35,
      spread: false,
      keys: undefined,
    });
  });

  test('$$name is a spread', () => {
    const [p] = scanParams('WHERE id IN $$ids', '$');
    expect(p).toStrictEqual({
      name: 'ids',
      required: false,
      a: 12,
      b: 17,
      spread: true,
      keys: undefined,
    });
  });

  test('inline pick selection with per-key required marks', () => {
    const [p] = scanParams(
      'VALUES $notification(payload!, user_id!, type)',
      '$',
    );
    expect(p.keys).toStrictEqual([
      { name: 'payload', required: true },
      { name: 'user_id', required: true },
      { name: 'type', required: false },
    ]);
    expect(p.spread).toBe(false);
  });

  test('inline pick-spread selection', () => {
    const [p] = scanParams('VALUES $$params(payload!, user_id!, type!)', '$');
    expect(p.spread).toBe(true);
    expect(p.keys?.map((k) => k.name)).toStrictEqual([
      'payload',
      'user_id',
      'type',
    ]);
  });

  test('a parenthesised subquery after a scalar is not a selection', () => {
    const [p] = scanParams('WHERE $id (SELECT 1)', '$');
    expect(p.keys).toBeUndefined();
    expect(p.b).toBe(9);
  });

  test('positional $1 placeholders are not params', () => {
    expect(scanParams('SELECT $1, $id', '$').map((p) => p.name)).toStrictEqual([
      'id',
    ]);
  });

  test('the selection span is included in the location', () => {
    const [p] = scanParams('X $a(b, c) Y', '$');
    expect('X $a(b, c) Y'.slice(p.a, p.b)).toBe('$a(b, c)');
  });
});

describe('locations are absolute offsets into the input', () => {
  // A mutation of `span.a + m.index` to `m.index` passes every test whose
  // input has no opaque span before the param. These do.
  test('after a string, with the : sigil', () => {
    const [p] = scanParams("SELECT 'aaaaaaaaaa', :id", ':');
    expect(p).toStrictEqual({
      name: 'id',
      required: false,
      a: 21,
      b: 24,
      spread: false,
      keys: undefined,
    });
  });

  test('after a string, with the $ sigil', () => {
    const [p] = scanParams("SELECT 'aaaaaaaa', $id", '$');
    expect(p).toStrictEqual({
      name: 'id',
      required: false,
      a: 19,
      b: 22,
      spread: false,
      keys: undefined,
    });
  });

  test('after a line comment', () => {
    const sql = 'SELECT 1 -- note\nWHERE id = :id';
    const [p] = scanParams(sql, ':');
    expect(sql.slice(p.a, p.b)).toBe(':id');
    expect(p.a).toBe(28);
  });

  test('a param at offset 0', () => {
    expect(scanParams(':id', ':')[0]).toStrictEqual({
      name: 'id',
      required: false,
      a: 0,
      b: 3,
      spread: false,
      keys: undefined,
    });
  });

  test('empty input', () => {
    expect(spans('', { dollarQuotes: true })).toStrictEqual([]);
    expect(scanParams('', ':')).toStrictEqual([]);
  });
});

describe('escape rules that decide where a string ends', () => {
  // Closing a string at the wrong place turns the rest of the file opaque and
  // silently drops every later param, so both directions are pinned.
  test("E'...' treats a backslash as an escape", () => {
    const sql = "SELECT E'it\\'s' , :id";
    expect(
      spans(sql, { dollarQuotes: true })
        .filter((s) => s.kind === 'opaque')
        .map((s) => sql.slice(s.a, s.b)),
    ).toStrictEqual(["E'it\\'s'".slice(1)]);
    expect(scanParams(sql, ':').map((p) => p.name)).toStrictEqual(['id']);
  });

  test("plain '...' does not, so a trailing backslash still closes it", () => {
    const sql = "SELECT 'a\\', :id";
    expect(scanParams(sql, ':').map((p) => p.name)).toStrictEqual(['id']);
  });

  test('an E preceded by a word character is not an escape-string prefix', () => {
    const sql = "SELECT CASE'a\\', :id";
    expect(scanParams(sql, ':').map((p) => p.name)).toStrictEqual(['id']);
  });

  test('block comments nest, as they do in Postgres', () => {
    const sql = '/* outer /* inner */ WHERE x = :evil */ SELECT :real';
    expect(scanParams(sql, ':').map((p) => p.name)).toStrictEqual(['real']);
  });

  test('an unterminated block comment runs to end of input', () => {
    const sql = 'SELECT 1 /* :notaparam';
    expect(scanParams(sql, ':')).toStrictEqual([]);
  });

  test('a CRLF line comment ends at the newline', () => {
    const sql = 'SELECT 1 -- :fake\r\nWHERE id = :id';
    expect(scanParams(sql, ':').map((p) => p.name)).toStrictEqual(['id']);
  });
});

describe('key types in a tag selection', () => {
  test('a type is captured per key, and untyped keys carry none', () => {
    const [p] = scanParams('VALUES $$foos(id::int4, val)', '$');
    expect(p.keys).toStrictEqual([
      { name: 'id', required: false, type: 'int4' },
      { name: 'val', required: false },
    ]);
  });

  test('the required marker comes before the cast', () => {
    const [p] = scanParams('VALUES $foo(id!::int4)', '$');
    expect(p.keys).toStrictEqual([
      { name: 'id', required: true, type: 'int4' },
    ]);
  });

  test('the selection span still covers the whole reference', () => {
    const sql = 'X $a(b::int4, c) Y';
    const [p] = scanParams(sql, '$');
    expect(sql.slice(p.a, p.b)).toBe('$a(b::int4, c)');
  });

  test('schema qualification and [] suffixes are accepted', () => {
    const [p] = scanParams('VALUES $x(a::public.my_enum, b::text[])', '$');
    expect(p.keys).toStrictEqual([
      { name: 'a', required: false, type: 'public.my_enum' },
      { name: 'b', required: false, type: 'text[]' },
    ]);
  });

  test('the reversed ordering is rejected by name', () => {
    expect(() => scanParams('VALUES $$foos(id::int4!)', '$')).toThrow(
      'Parameter "foos": Key "id::int4!" writes "!" after the cast; a required ' +
        'typed key is "id!::int4", with "!" on the name',
    );
  });

  test('a type that is not an identifier is rejected, naming the key', () => {
    expect(() =>
      scanParams('VALUES $$foos(id::int4, name::character varying)', '$'),
    ).toThrow(/Key "name" is cast to "character varying"/);
  });

  test('a cast with no type is rejected', () => {
    expect(() => scanParams('VALUES $x(a::)', '$')).toThrow(
      /Key "a" is cast to ""/,
    );
  });
});

describe('a cast does not turn a subquery into a selection', () => {
  // Loosening the key-list sniff to admit `a::int4` is the one place this
  // change could silently reclassify SQL. `SELECT` is a legal identifier, so
  // what keeps the subquery a subquery is that nothing a key list allows —
  // a `::`, a comma, or the end — follows it.
  test('a cast directly on an identifier is a selection', () => {
    const [p] = scanParams('VALUES $x(a::int4)', '$');
    expect(p.keys).toStrictEqual([
      { name: 'a', required: false, type: 'int4' },
    ]);
  });

  test('a subquery whose projection has a cast is still a subquery', () => {
    const sql = 'WHERE id = $x(SELECT 1::int4)';
    const [p] = scanParams(sql, '$');
    expect(p.keys).toBeUndefined();
    expect(sql.slice(p.a, p.b)).toBe('$x');
  });

  test('and so is one that selects a cast column from a table', () => {
    const sql = 'WHERE id = $x(SELECT id::int4 FROM t)';
    const [p] = scanParams(sql, '$');
    expect(p.keys).toBeUndefined();
    expect(sql.slice(p.a, p.b)).toBe('$x');
  });
});

describe('known limits, pinned so a change is a decision', () => {
  test('a slice with a non-numeric upper bound reports it as a param', () => {
    expect(
      scanParams('SELECT tags[lo:hi] FROM t', ':').map((p) => p.name),
    ).toStrictEqual(['hi']);
  });

  test('a group that looks like a key list reads as a pick, even after a space', () => {
    const [p] = scanParams('WHERE $id (t)', '$');
    expect(p.keys).toStrictEqual([{ name: 't', required: false }]);
  });

  test('a malformed selection degrades to a scalar and is left in the SQL', () => {
    const [p] = scanParams('VALUES $x(a !, b)', '$');
    expect(p.keys).toBeUndefined();
    expect('VALUES $x(a !, b)'.slice(p.a, p.b)).toBe('$x');
  });

  test('an empty selection degrades to a scalar', () => {
    const [p] = scanParams('VALUES $x()', '$');
    expect(p.keys).toBeUndefined();
  });
});

/**
 * The other half of the dollar-quote rule: `scanParams` skips these, and this
 * is what lets the front-end say so rather than generating `void` in silence
 * (#549). Nothing here changes what is generated.
 */
describe('scanQuotedParams', () => {
  const found = (sql: string) =>
    scanQuotedParams(sql).map((r) => [sql.slice(r.a, r.b), r.tag]);

  test('reports the reference and the delimiter that hid it', () => {
    expect(found('DO $$ SELECT :name $$')).toStrictEqual([[':name', '$$']]);
    expect(found('DO $fn$ SELECT :name $fn$')).toStrictEqual([
      [':name', '$fn$'],
    ]);
  });

  test('reports every reference in the body, in source order', () => {
    expect(found('DO $$ :a AND :b $$').map(([text]) => text)).toStrictEqual([
      ':a',
      ':b',
    ]);
  });

  test('reports nothing outside a dollar-quoted body', () => {
    expect(found('SELECT :id FROM t')).toStrictEqual([]);
    expect(found("SELECT ':id' FROM t")).toStrictEqual([]);
  });

  test('descends into a nested dollar quote, under its own tag', () => {
    expect(found('DO $o$ EXECUTE $i$ :name $i$ $o$')).toStrictEqual([
      [':name', '$i$'],
    ]);
  });

  test('an unterminated body still reports what is in it', () => {
    expect(found('DO $$ SELECT :name')).toStrictEqual([[':name', '$$']]);
  });

  test('an empty body reports nothing', () => {
    expect(found('SELECT $$$$')).toStrictEqual([]);
  });

  /**
   * It matches with the same pattern `scanParams` does, so what is not a
   * parameter outside the quotes is not reported as one inside them. A
   * warning that fired on `x := 1` would fire on every `DO` block ever
   * written, which is worse than the silence it replaces.
   */
  describe('matches only what would have been a param outside the quotes', () => {
    // Named with JSON.stringify so the one with a newline in it reads.
    const nothing = (body: string) =>
      test(JSON.stringify(body), () =>
        expect(found(`DO $$ ${body} $$`)).toStrictEqual([]),
      );

    nothing('x := 1');
    nothing('val::int4');
    nothing('a::b::c');
    nothing('arr[1:2]');
    nothing("RAISE NOTICE 'bad:thing'");
    nothing('-- see :name\n');
    nothing('SELECT 1; -- 12:30');
  });

  test('the same references `scanParams` skips, and no others', () => {
    const sql = 'SELECT :real, $$ :fake $$';
    expect(scanParams(sql, ':').map((p) => p.name)).toStrictEqual(['real']);
    expect(scanQuotedParams(sql).map((r) => r.name)).toStrictEqual(['fake']);
  });

  /**
   * Why the `$` front-end gets no equivalent. It scans with
   * `dollarQuotes: false`, because `$$name` is its spread sigil, so `$$ … $$`
   * is not a quoted body there and a `$name` between those delimiters is a
   * real parameter — there is nothing to warn about.
   */
  test('a $name between $$ delimiters in a tag is a real param', () => {
    expect(scanParams('DO $$ SELECT $name $$', '$').map((p) => p.name)).toEqual(
      ['name'],
    );
  });
});
