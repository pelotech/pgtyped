import ts from 'typescript';
import { TypeAllocator, TypeMapping, TypeScope } from './types.js';

describe('TypeAllocator', () => {
  test('Allows overrides', () => {
    const types = new TypeAllocator(
      TypeMapping({
        foo: { return: { name: 'bar' }, parameter: { name: 'baz' } },
      }),
    );
    expect(types.use('foo', TypeScope.Return)).toEqual('bar');
    expect(types.use('foo', TypeScope.Parameter)).toEqual('baz');
  });

  /**
   * `Buffer` is the only mapped type whose TypeScript name is not an ES global,
   * so a generated file with a `bytea` column used to depend on @types/node
   * being on the ambient global list. Where it is not — Deno, workerd, Bun, or
   * anything compiling with `"types": []` — that is
   * `error TS2591: Cannot find name 'Buffer'`. Covers PR #612 / issue #262.
   */
  test('bytea imports Buffer instead of assuming the ambient global', () => {
    const types = new TypeAllocator(TypeMapping());
    expect(types.use('bytea', TypeScope.Return)).toEqual('Buffer');
    expect(types.declaration('out.ts')).toContain(
      "import type { Buffer } from 'node:buffer';",
    );
  });

  test('a bytea array imports Buffer too', () => {
    const types = new TypeAllocator(TypeMapping());
    // `_bytea` is the PG type name for an array of bytea values; the element
    // type has to be used for its import to reach the declaration.
    expect(types.use('_bytea', TypeScope.Return)).toEqual('BufferArray');
    expect(types.declaration('out.ts')).toContain(
      "import type { Buffer } from 'node:buffer';",
    );
  });

  test('a bytea parameter imports Buffer too', () => {
    const types = new TypeAllocator(TypeMapping());
    expect(types.use('bytea', TypeScope.Parameter)).toEqual('Buffer');
    expect(types.declaration('out.ts')).toContain(
      "import type { Buffer } from 'node:buffer';",
    );
  });

  /**
   * A `typesOverrides` entry naming an array type used to be ignored: the
   * `_`-prefix branch ran before the mapping was consulted, so the override
   * was shadowed by the element type's. This is the same lookup order that
   * `_numeric` depends on.
   */
  test('an override naming an array type wins over the element derivation', () => {
    const types = new TypeAllocator(
      TypeMapping({ _text: { return: { name: 'TextTuple' } } }),
    );
    expect(types.use('_text', TypeScope.Return)).toEqual('TextTuple');
    // Unoverridden array types still derive from their element type.
    expect(types.use('_varchar', TypeScope.Return)).toEqual('stringArray');
  });

  // Covers issue #323
  test('Uses `Json` when using `JsonArray`', () => {
    const types = new TypeAllocator(TypeMapping());
    // `_json` is the type name from PG corresponding to an array of JSON values
    types.use('_json', TypeScope.Return);
    // The definition of `JsonArray` depends on the definition of `Json`, so we
    // expect both to be included
    expect(types.types).toMatchObject({
      Json: expect.objectContaining({ name: 'Json' }),
      JsonArray: expect.objectContaining({ name: 'JsonArray' }),
    });
  });
});

/**
 * Pins the six entries that declared a type node-postgres does not return
 * (issue #552), and the neighbours that were right and must not move with them.
 *
 * Every expectation here was read off PostgreSQL 17 through `pg` — select the
 * column, look at the value — rather than off the pg-types source; the same
 * values are asserted end to end by `packages/example`. The reproduction is in
 * docs/upstream-triage.md.
 */
describe('DefaultTypeMapping agrees with the driver', () => {
  const use = (pgType: string, scope: TypeScope) =>
    new TypeAllocator(TypeMapping()).use(pgType, scope);

  describe('the return direction is what the driver hands back', () => {
    test.each([
      // [pg type,      generated type, the value actually returned]
      ['interval', 'PgInterval', '{ hours: 1 }'],
      ['time', 'string', "'01:02:03'"],
      ['timetz', 'string', "'01:02:03+00'"],
      ['bit', 'string', "'101'"],
      ['_numeric', 'numberArray', '[1.5]'],
      ['point', 'PgPoint', '{ x: 1, y: 2 }'],
    ])('%s is %s, because the driver returns %s', (pgType, expected) => {
      expect(use(pgType, TypeScope.Return)).toEqual(expected);
    });

    test.each([
      // A lone `numeric` really is a string — it is only the elements of a
      // `numeric[]` that pg-types runs through parseFloat — and the date/time
      // types either side of `time` really are `Date`s.
      ['numeric', 'string'],
      ['decimal', 'string'],
      ['date', 'Date'],
      ['timestamp', 'Date'],
      ['timestamptz', 'Date'],
      ['bool', 'boolean'],
      ['_int4', 'numberArray'],
      ['_text', 'stringArray'],
    ])('%s is still %s', (pgType, expected) => {
      expect(use(pgType, TypeScope.Return)).toEqual(expected);
    });
  });

  describe('the parameter direction is what the server accepts', () => {
    test.each([
      // A `Date` serialises to a full ISO timestamp, which none of these three
      // can parse; a boolean reaches `bit` as 't'; and neither `{ x, y }` nor
      // `[x, y]` is valid input syntax for a `point`. Text is the one form
      // that works for all five.
      ['interval', 'string'],
      ['time', 'string'],
      ['timetz', 'string'],
      ['bit', 'string'],
      ['point', 'string'],
    ])('%s takes a %s', (pgType, expected) => {
      expect(use(pgType, TypeScope.Parameter)).toEqual(expected);
    });

    test.each([
      // Unchanged: the server takes either form for a numeric, in an array or
      // on its own, and does parse an ISO timestamp as a date or timestamp.
      ['numeric', 'NumberOrString'],
      ['_numeric', 'NumberOrStringArray'],
      ['date', 'DateOrString'],
      ['timestamptz', 'DateOrString'],
    ])('%s still takes a %s', (pgType, expected) => {
      expect(use(pgType, TypeScope.Parameter)).toEqual(expected);
    });
  });

  describe('the object types are declared locally, not imported', () => {
    test('point emits a { x, y } alias', () => {
      const types = new TypeAllocator(TypeMapping());
      types.use('point', TypeScope.Return);
      expect(types.declaration('out.ts')).toBe(
        'export type PgPoint = { x: number; y: number };\n',
      );
    });

    /**
     * The fields are optional because the parser sets only the ones the
     * interval uses: `'1 hour'` is `{ hours: 1 }` and `'0 seconds'` is `{}`.
     * The methods are on `PostgresInterval.prototype`, so a returned value
     * satisfies this structurally — and requiring them is what stops a
     * hand-written `{ hours: 1 }` being passed off as one.
     */
    test('interval emits the PostgresInterval shape, all fields optional', () => {
      const types = new TypeAllocator(TypeMapping());
      types.use('interval', TypeScope.Return);
      expect(types.declaration('out.ts')).toBe(
        `export type PgInterval = {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
  toPostgres(): string;
  toISO(): string;
  toISOString(): string;
};
`,
      );
    });

    test('neither adds an import to the generated file', () => {
      const types = new TypeAllocator(TypeMapping());
      types.use('point', TypeScope.Return);
      types.use('interval', TypeScope.Return);
      expect(types.toTypeDefinitions().imports).toStrictEqual({});
      expect(syntaxErrors(types.declaration('out.ts'))).toStrictEqual([]);
    });
  });
});

/** The syntax errors TypeScript reports for `source`, if any. */
const syntaxErrors = (source: string): string[] =>
  (
    ts.transpileModule(source, { reportDiagnostics: true }).diagnostics ?? []
  ).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));

const declare = (name: string, enumValues: string[]): string =>
  TypeAllocator.typeDefinitionDeclarations('out.ts', {
    imports: {},
    enums: [{ name, enumValues }],
    aliases: [],
  });

describe('enum declarations', () => {
  // Covers issue #611
  test('an enum value containing a quote emits parseable TypeScript', () => {
    // The values were interpolated raw, which emitted
    // `export type model_enum = '525' | 'car's' | 'rileys';` — a file that
    // does not parse, while codegen still exited 0.
    const declaration = declare('model_enum', ['525', "car's", 'rileys']);
    expect(declaration).toBe(
      "export type model_enum = '525' | 'car\\'s' | 'rileys';\n",
    );
    expect(syntaxErrors(declaration)).toStrictEqual([]);
  });

  test('backslashes, double quotes and control characters are escaped too', () => {
    const declaration = declare('weird', ['a\\b', 'say "hi"', 'line\nbreak']);
    expect(declaration).toBe(
      `export type weird = 'a\\\\b' | 'line\\nbreak' | 'say "hi"';\n`,
    );
    expect(syntaxErrors(declaration)).toStrictEqual([]);
  });

  test('ordinary values are still emitted single-quoted and sorted', () => {
    expect(declare('notification_type', ['reminder', 'deadline'])).toBe(
      "export type notification_type = 'deadline' | 'reminder';\n",
    );
  });
});
