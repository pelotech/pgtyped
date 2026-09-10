import { declareImport } from './types.js';

test('default', () => {
  expect(
    declareImport(
      [{ name: 'Alias', from: 'package', aliasOf: 'default' }],
      './',
    ),
  ).toBe("import type Alias from 'package';\n");
});

test('named', () => {
  expect(
    declareImport(
      [
        { name: 'Foo', from: 'package' },
        { name: 'Bar', from: 'package' },
        { name: 'Baz', from: 'package', aliasOf: 'Baz' },
      ],
      './',
    ),
  ).toBe("import type { Foo, Bar, Baz } from 'package';\n");
});

test('named aliased', () => {
  expect(
    declareImport(
      [
        { name: 'Alias1', from: 'package', aliasOf: 'Foo' },
        { name: 'Alias2', from: 'package', aliasOf: 'Bar' },
      ],
      './',
    ),
  ).toBe("import type { Foo as Alias1, Bar as Alias2 } from 'package';\n");
});

test('mix', () => {
  expect(
    declareImport(
      [
        { name: 'Alias', from: 'package', aliasOf: 'default' },
        { name: 'Alias1', from: 'package', aliasOf: 'Foo' },
        { name: 'Bar', from: 'package' },
        { name: 'Alias2', from: 'package', aliasOf: 'Baz' },
      ],
      './',
    ),
  ).toBe(
    "import type Alias from 'package';\nimport type { Foo as Alias1, Bar, Baz as Alias2 } from 'package';\n",
  );
});

describe('relative imports', () => {
  test('sub dir', () => {
    expect(
      declareImport(
        [{ name: 'Alias', from: './my/custom/path', aliasOf: 'default' }],
        './my/file.ts',
      ),
    ).toBe("import type Alias from './custom/path';\n");
  });

  test('parent dir', () => {
    expect(
      declareImport(
        [{ name: 'Alias', from: './my/custom/path', aliasOf: 'default' }],
        './foo/bar/file.ts',
      ),
    ).toBe("import type Alias from '../../my/custom/path';\n");
  });

  test('parent parent dir', () => {
    expect(
      declareImport(
        [{ name: 'Alias', from: '../my/custom/path', aliasOf: 'default' }],
        './foo/bar/file.ts',
      ),
    ).toBe("import type Alias from '../../../my/custom/path';\n");
  });

  test('sub dir with extension', () => {
    expect(
      declareImport(
        [{ name: 'Alias', from: './my/custom/path.js', aliasOf: 'default' }],
        './my/file.ts',
      ),
    ).toBe("import type Alias from './custom/path.js';\n");
  });

  test('parent dir with extension', () => {
    expect(
      declareImport(
        [{ name: 'Alias', from: './my/custom/path.ts', aliasOf: 'default' }],
        './foo/bar/file.ts',
      ),
    ).toBe("import type Alias from '../../my/custom/path.ts';\n");
  });

  test('parent parent dir with extension', () => {
    expect(
      declareImport(
        [{ name: 'Alias', from: '../my/custom/path.ts', aliasOf: 'default' }],
        './foo/bar/file.ts',
      ),
    ).toBe("import type Alias from '../../../my/custom/path.ts';\n");
  });
});

test('a quote in the module specifier is escaped', () => {
  // Same defect as the enum unions in #611: the specifier was interpolated
  // into a string literal raw, so one apostrophe emitted a file that does not
  // parse.
  expect(
    declareImport(
      [{ name: 'Alias', from: "pack'age", aliasOf: 'default' }],
      './',
    ),
  ).toBe("import type Alias from 'pack\\'age';\n");
  expect(declareImport([{ name: 'Foo', from: "pack'age" }], './')).toBe(
    "import type { Foo } from 'pack\\'age';\n",
  );
});
