import fs from 'fs-extra';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedConfig } from './config.js';
import { generateDeclarationFile, TypeDeclarationSet } from './generator.js';
import { RUNTIME_MODULE } from './runtimeModule.js';
import {
  DEFAULT_SHARED_TYPES_FILE,
  SHARED_TYPES_HEADER,
  SharedTypeRegistry,
  relativeSpecifier,
  sharedTypesOf,
} from './sharedTypes.js';
import {
  TypeAllocator,
  TypeDefinitions,
  TypeMapping,
  TypeScope,
} from './types.js';

const config = (overrides: Partial<ParsedConfig> = {}): ParsedConfig =>
  ({
    srcDir: 'src',
    sharedTypesFile: DEFAULT_SHARED_TYPES_FILE,
    failOnError: false,
    typesOverrides: {},
    ...overrides,
  }) as ParsedConfig;

/** What one file's allocator ends up holding, through the real allocator. */
function definitions(
  use: (types: TypeAllocator) => void,
  overrides: Record<string, any> = {},
): TypeDefinitions {
  const types = new TypeAllocator(TypeMapping(overrides));
  use(types);
  return types.toTypeDefinitions();
}

/** A `text[]` result, which is `nullableStringArray` in both files that ask. */
const textArray = () =>
  definitions((types) => types.use('_text', TypeScope.Return));

/** An enum of the given values, as two schemas of the same name would give. */
const lobbyStatus = (values: string[]) =>
  definitions((types) =>
    types.use({ name: 'lobby_status', enumValues: values }, TypeScope.Return),
  );

const withRegistry = <T>(
  overrides: Partial<ParsedConfig>,
  body: (registry: SharedTypeRegistry, dir: string) => T,
): T => {
  const dir = mkdtempSync(join(tmpdir(), 'pgtyped-shared-'));
  return body(
    new SharedTypeRegistry(config({ srcDir: dir, ...overrides })),
    dir,
  );
};

/**
 * Every generated file declared its own copy of every alias it needed, so
 * `export *` from two of them was `TS2308: Module ... has already exported a
 * member named 'DateOrString'` (#565). They are declared once here instead.
 */
describe('the shared types file', () => {
  test('an alias two files need is declared once', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a/a.queries.ts', textArray());
    registry.register('src/b/deep/b.queries.ts', textArray());

    const rendered = registry.render() ?? '';

    expect(rendered.match(/export type nullableStringArray/g)).toHaveLength(1);
    expect(rendered).toContain(
      'export type nullableStringArray = (string | null)[];',
    );
  });

  test('the union is what every file between them needs', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a.queries.ts', textArray());
    registry.register(
      'src/b.queries.ts',
      definitions((types) => types.use('_int4', TypeScope.Return)),
    );

    const rendered = registry.render() ?? '';

    expect(rendered).toContain('export type nullableStringArray');
    expect(rendered).toContain('export type nullableNumberArray');
  });

  /**
   * `TypedQuery` is a value each sql-mode file constructs, not a type it
   * merely names, so it stays an import in the file that uses it.
   */
  test('the runtime import is not shared', () => {
    const defs = definitions((types) =>
      types.use({ name: 'TypedQuery', from: RUNTIME_MODULE }, TypeScope.Return),
    );

    expect(sharedTypesOf(defs)).toStrictEqual([]);
  });

  /**
   * An import is not an export, so a generated file that names an imported
   * type in a field — `email: EmailAddress` — has to be able to reach it.
   */
  test('an imported type is re-exported, not just imported', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register(
      'src/a.queries.ts',
      definitions((types) => types.use('email_address', TypeScope.Return), {
        email_address: {
          // As `stringToType` produces it: relative to the working directory,
          // which the shared file's own location then has to be worked out
          // against.
          return: { name: 'EmailAddress', from: './customTypes.js' },
        },
      }),
    );

    const rendered = registry.render() ?? '';

    expect(rendered).toContain(
      "import type { EmailAddress } from '../customTypes.js';",
    );
    expect(rendered).toContain('export type { EmailAddress };');
  });

  test('it is headed by the line that marks it as generated', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a.queries.ts', textArray());

    expect(registry.render()).toMatch(
      new RegExp(`^${SHARED_TYPES_HEADER.trim().replace(/[*/]/g, '\\$&')}`),
    );
  });
});

/**
 * Generated files sit at whatever depth their queries do, and the package is
 * ESM-only, so the specifier is a real relative path carrying the extension
 * the emitted JavaScript will have.
 */
describe('the specifier a generated file reaches it through', () => {
  test.each([
    ['alongside it', 'src/x.queries.ts', './pgtyped-shared.js'],
    ['one level down', 'src/books/books.queries.ts', '../pgtyped-shared.js'],
    [
      'three levels down',
      'src/a/b/c/deep.queries.ts',
      '../../../pgtyped-shared.js',
    ],
  ])('%s: %s imports through %s', (_label, file, expected) => {
    expect(new SharedTypeRegistry(config()).specifier(file)).toBe(expected);
  });

  test('an emitTemplate that writes outside srcDir still resolves', () => {
    expect(
      new SharedTypeRegistry(config()).specifier('generated/types/x.ts'),
    ).toBe('../../src/pgtyped-shared.js');
  });

  test.each([
    ['shared.ts', './shared.js'],
    ['shared.mts', './shared.mjs'],
    ['shared.cts', './shared.cjs'],
  ])('%s is imported as %s', (file, expected) => {
    expect(relativeSpecifier('src/a.queries.ts', join('src', file))).toBe(
      expected,
    );
  });
});

/**
 * `packages/example/check-git-diff.sh` fails CI on any diff, so a run that
 * emitted the same types in a different order would break every build that
 * happened to describe its files in a different order.
 */
describe('the output is the same whatever order files finish in', () => {
  const build = (files: [string, TypeDefinitions][]) => {
    const registry = new SharedTypeRegistry(config());
    files.forEach(([file, defs]) => registry.register(file, defs));
    return registry.render();
  };

  test('registration order does not change a byte', () => {
    const overrides = {
      text: { return: { name: 'Ay', from: './z.js' } },
      int4: { return: { name: 'Zed', from: './a.js' } },
    };
    const a: [string, TypeDefinitions] = [
      'src/a.queries.ts',
      definitions((t) => {
        t.use('_text', TypeScope.Return);
        t.use('text', TypeScope.Return);
      }, overrides),
    ];
    const b: [string, TypeDefinitions] = [
      'src/b.queries.ts',
      definitions((t) => {
        t.use('_int4', TypeScope.Return);
        t.use('int4', TypeScope.Return);
      }, overrides),
    ];

    expect(build([a, b])).toBe(build([b, a]));
  });

  // Reached in the order that would put './z.js' first without a sort.
  test('imports are grouped in module order', () => {
    const overrides = {
      text: { return: { name: 'Ay', from: './z.js' } },
      int4: { return: { name: 'Zed', from: './a.js' } },
    };
    const rendered =
      build([
        [
          'src/a.queries.ts',
          definitions((t) => {
            t.use('text', TypeScope.Return);
            t.use('int4', TypeScope.Return);
          }, overrides),
        ],
      ]) ?? '';

    expect(rendered.indexOf("from '../a.js'")).toBeLessThan(
      rendered.indexOf("from '../z.js'"),
    );
  });

  // Reached in the order that would re-export `Zed` first without a sort.
  test('re-exported names come out in name order', () => {
    const overrides = {
      text: { return: { name: 'Ay', from: './z.js' } },
      int4: { return: { name: 'Zed', from: './a.js' } },
    };
    const rendered =
      build([
        [
          'src/a.queries.ts',
          definitions((t) => {
            t.use('int4', TypeScope.Return);
            t.use('text', TypeScope.Return);
          }, overrides),
        ],
      ]) ?? '';

    expect(rendered).toContain('export type { Ay, Zed };');
  });

  test('aliases come out in name order, not discovery order', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register(
      'src/a.queries.ts',
      definitions((t) => {
        t.use('_int4', TypeScope.Return);
        t.use('_text', TypeScope.Return);
        t.use('point', TypeScope.Return);
      }),
    );

    const names = [
      ...(registry.render() ?? '').matchAll(/export type (\w+) =/g),
    ].map((m) => m[1]);

    expect(names).toStrictEqual([...names].sort());
  });
});

/**
 * `TypeAllocator` resolves a name claimed twice first-wins, which within one
 * file was the bug `197c625` fixed. Across files into one target there is
 * nothing to resolve it to: one name cannot hold two definitions, so it is
 * reported rather than silently decided.
 */
describe('two files defining one name differently', () => {
  const conflicting = (registry: SharedTypeRegistry) => {
    registry.register('src/b.queries.ts', lobbyStatus(['open', 'closed']));
    registry.register('src/a.queries.ts', lobbyStatus(['waiting', 'playing']));
  };

  const warningsFrom = (body: () => void): string[] => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      body();
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }
  };

  test('is reported, naming the type, both definitions and both files', () => {
    const registry = new SharedTypeRegistry(config());
    conflicting(registry);

    const warnings = warningsFrom(() => registry.render());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"lobby_status"');
    expect(warnings[0]).toContain(
      "export type lobby_status = 'closed' | 'open';",
    );
    expect(warnings[0]).toContain(
      "export type lobby_status = 'playing' | 'waiting';",
    );
    expect(warnings[0]).toContain('a.queries.ts');
    expect(warnings[0]).toContain('b.queries.ts');
  });

  test('resolves to the same one however the run was ordered', () => {
    const first = new SharedTypeRegistry(config());
    const second = new SharedTypeRegistry(config());
    warningsFrom(() => {
      conflicting(first);
      second.register('src/a.queries.ts', lobbyStatus(['waiting', 'playing']));
      second.register('src/b.queries.ts', lobbyStatus(['open', 'closed']));
    });

    let rendered: [string | null, string | null] = [null, null];
    warningsFrom(() => {
      rendered = [first.render(), second.render()];
    });

    expect(rendered[0]).toBe(rendered[1]);
    // Files are visited in path order, so a.queries.ts is what wins.
    expect(rendered[0]).toContain(
      "export type lobby_status = 'playing' | 'waiting';",
    );
  });

  test('is fatal under failOnError', () => {
    const registry = new SharedTypeRegistry(config({ failOnError: true }));
    conflicting(registry);

    expect(() => warningsFrom(() => registry.render())).toThrow(/lobby_status/);
  });

  test('two files agreeing on a definition is not a conflict', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a.queries.ts', textArray());
    registry.register('src/b.queries.ts', textArray());

    expect(warningsFrom(() => registry.render())).toStrictEqual([]);
  });
});

describe('a project with nothing to share', () => {
  test('renders nothing at all', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register(
      'src/a.queries.ts',
      definitions((types) => types.use('text', TypeScope.Return)),
    );

    expect(registry.render()).toBeNull();
  });

  test('writes no stray empty file', async () =>
    withRegistry({}, async (registry, dir) => {
      registry.register(
        join(dir, 'a.queries.ts'),
        definitions((types) => types.use('text', TypeScope.Return)),
      );

      expect(await registry.write()).toBe(false);
      expect(await fs.pathExists(join(dir, DEFAULT_SHARED_TYPES_FILE))).toBe(
        false,
      );
    }));

  test('removes one left over from a run that did share something', async () =>
    withRegistry({}, async (registry, dir) => {
      const shared = join(dir, DEFAULT_SHARED_TYPES_FILE);
      registry.register(join(dir, 'a.queries.ts'), textArray());
      expect(await registry.write()).toBe(true);

      registry.release(join(dir, 'a.queries.ts'));

      expect(await registry.write()).toBe(true);
      expect(await fs.pathExists(shared)).toBe(false);
    }));

  test('leaves a file it did not write alone', async () =>
    withRegistry({}, async (registry, dir) => {
      const shared = join(dir, DEFAULT_SHARED_TYPES_FILE);
      await fs.outputFile(shared, 'export const mine = 1;\n');

      expect(await registry.write()).toBe(false);
      expect(await fs.readFile(shared, { encoding: 'utf-8' })).toBe(
        'export const mine = 1;\n',
      );
    }));
});

describe('releasing an alias', () => {
  test('keeps it while another file still needs it', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a.queries.ts', textArray());
    registry.register('src/b.queries.ts', textArray());

    registry.release('src/a.queries.ts');

    expect(registry.render()).toContain('nullableStringArray');
  });

  test('drops it once the last file stops needing it', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a.queries.ts', textArray());
    registry.register('src/b.queries.ts', textArray());

    registry.release('src/a.queries.ts');
    // Re-registered with a query that needs nothing shared, which is what an
    // edit that drops the last array column looks like.
    registry.register(
      'src/b.queries.ts',
      definitions((types) => types.use('text', TypeScope.Return)),
    );

    expect(registry.render()).toBeNull();
  });

  test('a path spelled differently is still the same file', () => {
    const registry = new SharedTypeRegistry(config());
    registry.register('src/a.queries.ts', textArray());

    registry.release('./src/nested/../a.queries.ts');

    expect(registry.render()).toBeNull();
  });
});

/** A generated file, with one query whose declarations are beside the point. */
const declarationSet = (types: TypeAllocator): TypeDeclarationSet => ({
  typedQueries: [
    {
      mode: 'ts',
      fileName: 'src/books/books.ts',
      query: { name: 'q', queryTypeAlias: 'QQuery' },
      typeDeclaration: "/** 'Q' query type */\n",
    },
  ],
  typeDefinitions: types.toTypeDefinitions(),
  directUses: types.directUses,
  fileName: 'src/books/books.sql',
});

/** The names a generated file imports from the shared file. */
const sharedImportOf = (content: string): string[] => {
  const match = /import type \{([^}]*)\} from '[^']*pgtyped-shared\.js';/.exec(
    content,
  );
  return match ? match[1].trim().split(', ') : [];
};

describe('what a generated file emits', () => {
  test('an import of the shared names it uses, and no declarations', () => {
    const types = new TypeAllocator(TypeMapping());
    types.use({ name: 'TypedQuery', from: RUNTIME_MODULE }, TypeScope.Return);
    types.use('_text', TypeScope.Return);

    const content = generateDeclarationFile(
      declarationSet(types),
      '../pgtyped-shared.js',
    );

    expect(content).toContain(
      "import { TypedQuery } from '@pelotech/pgtyped-runtime';",
    );
    expect(sharedImportOf(content)).toStrictEqual(['nullableStringArray']);
    expect(content).not.toContain('export type nullableStringArray');
  });

  /**
   * The enum is named by the array alias's definition and by nothing in the
   * generated file, so importing it would name something the file never
   * mentions.
   */
  test('nothing it only reaches through another alias', () => {
    const types = new TypeAllocator(TypeMapping());
    types.use(
      {
        name: '_category',
        elementType: { name: 'category', enumValues: ['novel', 'thriller'] },
      },
      TypeScope.Return,
    );

    const content = generateDeclarationFile(
      declarationSet(types),
      './pgtyped-shared.js',
    );

    expect(sharedImportOf(content)).toStrictEqual(['nullableCategoryArray']);
  });

  test('the opt-out declares every alias in the file, as before', () => {
    const types = new TypeAllocator(TypeMapping());
    types.use({ name: 'TypedQuery', from: RUNTIME_MODULE }, TypeScope.Return);
    types.use('_text', TypeScope.Return);

    const content = generateDeclarationFile(declarationSet(types));

    expect(content).toContain(
      'export type nullableStringArray = (string | null)[];',
    );
    expect(content).not.toContain('pgtyped-shared');
  });

  test('a file with nothing shared is unchanged either way', () => {
    const types = new TypeAllocator(TypeMapping());
    types.use({ name: 'TypedQuery', from: RUNTIME_MODULE }, TypeScope.Return);
    types.use('text', TypeScope.Return);

    expect(
      generateDeclarationFile(declarationSet(types), './pgtyped-shared.js'),
    ).toBe(generateDeclarationFile(declarationSet(types)));
  });
});

describe('sharedTypesFile: false', () => {
  const off = new SharedTypeRegistry(config({ sharedTypesFile: false }));

  test('has no file to write to', () => {
    expect(off.enabled).toBe(false);
    expect(off.filePath).toBeNull();
  });

  test('offers no specifier, which is what restores per-file aliases', () => {
    expect(off.specifier('src/a.queries.ts')).toBeUndefined();
  });

  test('registers nothing and writes nothing', async () => {
    off.register('src/a.queries.ts', textArray());

    expect(off.contributionOf('src/a.queries.ts')).toStrictEqual([]);
    expect(off.render()).toBeNull();
    expect(await off.write()).toBe(false);
  });
});
