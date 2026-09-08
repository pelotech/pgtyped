// packages/runtime/src/scanner.test.ts
import { scanParams, spans } from './scanner.js';

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
    expect(p).toMatchObject({
      name: 'minCommentCount',
      required: true,
      spread: false,
      keys: undefined,
    });
  });

  test('$$name is a spread', () => {
    const [p] = scanParams('WHERE id IN $$ids', '$');
    expect(p).toMatchObject({ name: 'ids', spread: true, keys: undefined });
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
