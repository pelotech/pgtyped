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
