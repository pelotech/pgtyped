import ts from 'typescript';
import { MappableType } from './db/type.js';
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
    expect(types.use('_bytea', TypeScope.Return)).toEqual(
      'nullableBufferArray',
    );
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
    expect(types.use('_varchar', TypeScope.Return)).toEqual(
      'nullableStringArray',
    );
  });

  /**
   * A range column used to generate `unknown` and log
   * `Postgres type 'tstzrange' is not supported by mapping`, because no range
   * type was in `DefaultTypeMapping` at all (issue #213). node-postgres
   * registers no parser for them, so the value is the server's own literal in
   * both directions.
   */
  describe('range types (issue #213)', () => {
    test.each([
      'int4range',
      'int8range',
      'numrange',
      'tsrange',
      'tstzrange',
      'daterange',
    ])('%s is a string in both directions, and is not an error', (pgType) => {
      const types = new TypeAllocator(TypeMapping());
      expect(types.use(pgType, TypeScope.Return)).toEqual('string');
      expect(types.use(pgType, TypeScope.Parameter)).toEqual('string');
      expect(types.errors).toStrictEqual([]);
    });

    test('a range is still overridable', () => {
      const types = new TypeAllocator(
        TypeMapping({ tstzrange: { return: { name: 'Period' } } }),
      );
      expect(types.use('tstzrange', TypeScope.Return)).toEqual('Period');
    });
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

  /**
   * A domain reaches the allocator as its own name plus whatever its base type
   * resolved to, so that an override naming the domain can win (#503, #594)
   * without an un-overridden domain losing the type it has always generated.
   */
  describe('domain types (issues #503, #594)', () => {
    const email = { name: 'email', baseType: 'text' };
    const mood = { name: 'mood', enumValues: ['sad', 'ok', 'happy'] };
    const moodDomain = { name: 'mood_d', baseType: mood };

    test('an override naming the domain wins', () => {
      const types = new TypeAllocator(
        TypeMapping({
          email: {
            return: { name: 'Email', from: './types' },
            parameter: { name: 'Email', from: './types' },
          },
        }),
      );
      expect(types.use(email, TypeScope.Return)).toEqual('Email');
      expect(types.use(email, TypeScope.Parameter)).toEqual('Email');
      expect(types.declaration('out.ts')).toContain(
        "import type { Email } from './types';",
      );
      expect(types.errors).toStrictEqual([]);
    });

    /**
     * The half upstream PR #637 leaves out. Without the fallback the bare
     * domain name reaches the mapping and fails it, so every project with a
     * domain column and no override for it gets `unknown` plus a codegen error
     * where it used to get a working type.
     */
    test('an un-overridden domain resolves to its base type, with no error', () => {
      const types = new TypeAllocator(TypeMapping());
      expect(types.use(email, TypeScope.Return)).toEqual('string');
      expect(types.use(email, TypeScope.Parameter)).toEqual('string');
      expect(types.errors).toStrictEqual([]);
    });

    test('a domain over an enum keeps the enum union', () => {
      const types = new TypeAllocator(TypeMapping());
      expect(types.use(moodDomain, TypeScope.Return)).toEqual('mood');
      expect(types.declaration('out.ts')).toContain(
        "export type mood = 'happy' | 'ok' | 'sad';",
      );
      expect(types.errors).toStrictEqual([]);
    });

    test('an override on a domain over an enum replaces the union', () => {
      const types = new TypeAllocator(
        TypeMapping({ mood_d: { return: { name: 'Mood' } } }),
      );
      expect(types.use(moodDomain, TypeScope.Return)).toEqual('Mood');
      // The enum it is built over is not emitted: nothing refers to it.
      expect(types.declaration('out.ts')).not.toContain('export type mood =');
    });

    test('a domain over a domain falls through to the nearest override', () => {
      const types = new TypeAllocator(
        TypeMapping({ email: { return: { name: 'Email' } } }),
      );
      expect(
        types.use({ name: 'email2', baseType: email }, TypeScope.Return),
      ).toEqual('Email');
      expect(
        types.use(
          { name: 'email2', baseType: { name: 'x', baseType: 'int4' } },
          TypeScope.Return,
        ),
      ).toEqual('number');
    });

    test('a scope with no override falls back on its own', () => {
      const types = new TypeAllocator(
        TypeMapping({ email: { return: { name: 'Email' } } }),
      );
      expect(types.use(email, TypeScope.Return)).toEqual('Email');
      // `parameter` was left unset, so that direction is still the base type
      // rather than an error.
      expect(types.use(email, TypeScope.Parameter)).toEqual('string');
      expect(types.errors).toStrictEqual([]);
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
      ['_numeric', 'nullableNumberArray', '[1.5]'],
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
      ['_int4', 'nullableNumberArray'],
      ['_text', 'nullableStringArray'],
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

/**
 * A Postgres array may hold NULL elements whatever the column's own
 * nullability, so `(string)[]` was a lie for every `text[]` result — issues
 * #613 and #460, and upstream PR #614.
 *
 * These pin the alias *definitions*, not just the names. Nothing did before,
 * which is how `(...)[]` stayed wrong through several passes over this file.
 */
describe('array element nullability (issues #613, #460)', () => {
  /** The declaration `pgType` produces in `scope`, alias name and all. */
  const declarationOf = (pgType: MappableType, scope: TypeScope): string => {
    const types = new TypeAllocator(TypeMapping());
    types.use(pgType, scope);
    return types.declaration('out.ts');
  };

  const category = { name: 'category', enumValues: ['novel', 'thriller'] };
  const categoryArray = { name: '_category', elementType: category };

  describe('a result says so', () => {
    test.each([
      ['_text', 'export type nullableStringArray = (string | null)[];'],
      ['_int4', 'export type nullableNumberArray = (number | null)[];'],
      // The hand-written `_numeric` entry is consulted before the derivation
      // below ever runs, so it carries its own scope-aware definition.
      ['_numeric', 'export type nullableNumberArray = (number | null)[];'],
    ])('%s declares %s', (pgType, expected) => {
      expect(declarationOf(pgType, TypeScope.Return)).toContain(expected);
    });

    test('an enum array declares its elements nullable too', () => {
      expect(declarationOf(categoryArray, TypeScope.Return)).toContain(
        'export type nullableCategoryArray = (category | null)[];',
      );
    });

    test('an overridden enum array keeps the override, and gains the null', () => {
      const types = new TypeAllocator(
        TypeMapping({
          category: {
            return: { name: 'Category', from: './customTypes.js' },
          },
        }),
      );
      types.use(categoryArray, TypeScope.Return);
      expect(types.declaration('out.ts')).toContain(
        'export type nullableCategoryArray = (Category | null)[];',
      );
    });
  });

  describe('a parameter does not', () => {
    // Widening what a caller may pass is not what those issues report, and
    // would loosen the contract for every project that already compiles.
    test.each([
      ['_text', 'export type stringArray = (string)[];'],
      ['_int4', 'export type numberArray = (number)[];'],
      ['_numeric', 'export type NumberOrStringArray = (number | string)[];'],
    ])('%s still declares %s', (pgType, expected) => {
      expect(declarationOf(pgType, TypeScope.Parameter)).toContain(expected);
    });

    test('an enum array still takes its elements non-null', () => {
      expect(declarationOf(categoryArray, TypeScope.Parameter)).toContain(
        'export type categoryArray = (category)[];',
      );
    });
  });

  /**
   * Why the return scope gets a name of its own. `TypeAllocator` registers
   * aliases by name, first occurrence winning, and one allocator serves both
   * scopes of a file — `packages/example` has `categoryArray` as a result and
   * as a parameter. Sharing the name would emit whichever definition was
   * reached first, and silently give the other scope the wrong type.
   */
  describe('both scopes of one allocator, emitted independently', () => {
    test('a text array is declared twice, correctly each time', () => {
      const types = new TypeAllocator(TypeMapping());
      expect(types.use('_text', TypeScope.Parameter)).toEqual('stringArray');
      expect(types.use('_text', TypeScope.Return)).toEqual(
        'nullableStringArray',
      );
      const declaration = types.declaration('out.ts');
      expect(declaration).toContain('export type stringArray = (string)[];');
      expect(declaration).toContain(
        'export type nullableStringArray = (string | null)[];',
      );
    });

    test('so is an enum array, whichever scope is reached first', () => {
      const types = new TypeAllocator(TypeMapping());
      expect(types.use(categoryArray, TypeScope.Return)).toEqual(
        'nullableCategoryArray',
      );
      expect(types.use(categoryArray, TypeScope.Parameter)).toEqual(
        'categoryArray',
      );
      const declaration = types.declaration('out.ts');
      expect(declaration).toContain(
        'export type categoryArray = (category)[];',
      );
      expect(declaration).toContain(
        'export type nullableCategoryArray = (category | null)[];',
      );
      expect(syntaxErrors(declaration)).toStrictEqual([]);
    });
  });

  /**
   * `Json` already admits null — it is the first member of the union — so the
   * suffix would be redundant, and with one definition for both scopes there
   * is no collision to name apart. Covers issue #323's alias as well.
   */
  test.each([TypeScope.Parameter, TypeScope.Return])(
    '_json is JsonArray in the %s scope, unchanged',
    (scope) => {
      const types = new TypeAllocator(TypeMapping());
      expect(types.use('_json', scope)).toEqual('JsonArray');
      expect(types.declaration('out.ts')).toContain(
        'export type JsonArray = (Json)[];',
      );
    },
  );
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
