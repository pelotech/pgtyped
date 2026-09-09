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
