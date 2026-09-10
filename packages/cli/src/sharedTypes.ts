/**
 * @fileoverview One file for the type aliases every generated file shares.
 *
 * Every generated file used to declare its own copy of every alias it needed —
 * `nullableCategoryArray`, `DateOrString`, an enum's string union — so two of
 * them re-exported from the same barrel is `TS2308: Module ... has already
 * exported a member named 'DateOrString'` (#565). The aliases are emitted once
 * here instead, and each generated file imports the ones it names.
 *
 * Two things follow from having a single target. The first is that the union
 * has to be maintained across files rather than derived from one: a query that
 * stops using an alias only releases it once no other file needs it, which in
 * watch mode means keeping the map alive for the whole session and releasing a
 * file's claim when it is deleted. The second is that a name can no longer
 * stand for two definitions. Within one file `TypeAllocator` resolves that
 * first-wins; across files into one target there is nothing to resolve it to,
 * so it is reported instead.
 */

import fs from 'fs-extra';
import path from 'path';
import type { ParsedConfig } from './config.js';
import { RUNTIME_MODULE } from './runtimeModule.js';
import { TypeAllocator, TypeDefinitions } from './types.js';

/** Where the shared aliases go when the config does not say otherwise. */
export const DEFAULT_SHARED_TYPES_FILE = 'pgtyped-shared.ts';

/**
 * First line of the shared file, and the mark that says it is ours.
 *
 * Deliberately not `*.queries.ts` or `*.types.ts` shaped, which are the two
 * names codegen already emits — this file is neither one file's queries nor
 * one file's types.
 */
export const SHARED_TYPES_HEADER =
  '/** Types shared by every file PgTyped generates. */\n';

/** One alias, enum or import, as it will be emitted into the shared file. */
export type SharedType =
  | { kind: 'import'; name: string; from: string; aliasOf?: string }
  | { kind: 'enum'; name: string; enumValues: string[] }
  | { kind: 'alias'; name: string; definition: string };

/**
 * The types in `defs` that belong in the shared file.
 *
 * Everything except the runtime import: `TypedQuery` is a *value* each sql-mode
 * file constructs, so it stays where it is used rather than being laundered
 * through a type-only module.
 *
 * Keyed by name with first occurrence winning, which is the rule
 * `TypeAllocator` already applies within a file.
 */
export function sharedTypesOf(defs: TypeDefinitions): SharedType[] {
  const byName = new Map<string, SharedType>();
  const add = (typ: SharedType) => {
    if (!byName.has(typ.name)) {
      byName.set(typ.name, typ);
    }
  };
  for (const [from, imports] of Object.entries(defs.imports)) {
    if (from === RUNTIME_MODULE) {
      continue;
    }
    for (const imp of imports) {
      add({ kind: 'import', name: imp.name, from, aliasOf: imp.aliasOf });
    }
  }
  for (const enumType of defs.enums) {
    add({
      kind: 'enum',
      name: enumType.name,
      enumValues: enumType.enumValues,
    });
  }
  for (const alias of defs.aliases) {
    add({ kind: 'alias', name: alias.name, definition: alias.definition });
  }
  return [...byName.values()];
}

/** `types` as the shape `TypeAllocator` knows how to declare. */
function toTypeDefinitions(types: SharedType[]): TypeDefinitions {
  const imports: TypeDefinitions['imports'] = {};
  const defs: TypeDefinitions = { imports: {}, enums: [], aliases: [] };
  for (const typ of types) {
    if (typ.kind === 'import') {
      imports[typ.from] ??= [];
      imports[typ.from].push({
        name: typ.name,
        from: typ.from,
        aliasOf: typ.aliasOf,
      });
    } else if (typ.kind === 'enum') {
      defs.enums.push({ name: typ.name, enumValues: typ.enumValues });
    } else {
      defs.aliases.push({ name: typ.name, definition: typ.definition });
    }
  }
  // Module order is the one thing `typeDefinitionDeclarations` takes as given,
  // and this file's contents come from however many source files in whatever
  // order they finished in.
  for (const from of Object.keys(imports).sort()) {
    defs.imports[from] = imports[from];
  }
  return defs;
}

/**
 * The module specifier `fromFile` should import `target` through.
 *
 * Generated files sit at whatever depth their queries do, so this is a real
 * relative path rather than a fixed one; the package is ESM-only, so it
 * carries the extension the emitted JavaScript will have, not the `.ts` the
 * file is written as.
 */
export function relativeSpecifier(fromFile: string, target: string): string {
  const relative = path
    .relative(path.dirname(fromFile), target)
    // TS import declarations take posix separators whatever the platform
    // writes paths with (see #533).
    .split(path.sep)
    .join(path.posix.sep);
  const prefixed = relative.startsWith('.') ? relative : `./${relative}`;
  return prefixed.replace(/\.([mc]?)ts$/, '.$1js');
}

/** The `import type` line a generated file reaches the shared file through. */
export function sharedImportDeclaration(
  names: string[],
  specifier: string,
): string {
  if (names.length === 0) {
    return '';
  }
  return `import type { ${[...names].sort().join(', ')} } from '${specifier}';\n`;
}

/**
 * The aliases, enums and imports of every file generated so far, and the file
 * they are emitted into.
 *
 * One registry serves every transform: a project with both `sql` files and
 * `sql` tags shares one set of aliases between them, and `packages/example`
 * has `notification_type` reached from both.
 */
export class SharedTypeRegistry {
  /** Generated file -> what it contributes. Keyed by resolved path. */
  private readonly contributions = new Map<string, SharedType[]>();
  /** Writes are serialised: watch mode has several files in flight at once. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Null when the config turned shared types off. */
  readonly filePath: string | null;

  constructor(private readonly config: ParsedConfig) {
    this.filePath =
      config.sharedTypesFile === false
        ? null
        : path.join(config.srcDir, config.sharedTypesFile);
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  /** The shared file as it should be spelled in a log line. */
  get relativePath(): string {
    return this.filePath ? path.relative(process.cwd(), this.filePath) : '';
  }

  /** Whether `fileName` is the shared file, whichever way it is spelled. */
  isSharedFile(fileName: string): boolean {
    return (
      this.filePath !== null &&
      path.resolve(fileName) === path.resolve(this.filePath)
    );
  }

  /**
   * The specifier `decsFileName` imports shared types through, or `undefined`
   * when shared types are off — which is what puts the generator back on the
   * per-file declarations it emitted before.
   */
  specifier(decsFileName: string): string | undefined {
    return this.filePath === null
      ? undefined
      : relativeSpecifier(decsFileName, this.filePath);
  }

  /** Records what the file just generated into `decsFileName` needs. */
  register(decsFileName: string, defs: TypeDefinitions): void {
    if (this.filePath === null) {
      return;
    }
    const types = sharedTypesOf(defs);
    if (types.length === 0) {
      // A file that needs nothing shared holds no claim on anything: this is
      // how the last user of an alias releases it by being edited.
      this.contributions.delete(path.resolve(decsFileName));
      return;
    }
    this.contributions.set(path.resolve(decsFileName), types);
  }

  /** Drops a file's claim on everything it contributed. */
  release(decsFileName: string): void {
    this.contributions.delete(path.resolve(decsFileName));
  }

  /** The names `decsFileName` currently contributes, for tests and logs. */
  contributionOf(decsFileName: string): string[] {
    return (this.contributions.get(path.resolve(decsFileName)) ?? []).map(
      (t) => t.name,
    );
  }

  /** How `typ` will read in the shared file. */
  private declarationOf(typ: SharedType): string {
    return TypeAllocator.typeDefinitionDeclarations(
      this.filePath ?? '',
      toTypeDefinitions([typ]),
    ).trim();
  }

  /**
   * One definition per name, in name order, having reported every name two
   * files define differently.
   *
   * Files are visited in path order rather than in the order they happened to
   * finish, so that a conflict resolves to the same definition on every run
   * and regeneration stays byte-identical.
   */
  private resolve(): SharedType[] {
    const chosen = new Map<string, { typ: SharedType; file: string }>();
    const conflicts: string[] = [];
    for (const file of [...this.contributions.keys()].sort()) {
      for (const typ of this.contributions.get(file)!) {
        const existing = chosen.get(typ.name);
        if (!existing) {
          chosen.set(typ.name, { typ, file });
          continue;
        }
        if (this.declarationOf(existing.typ) === this.declarationOf(typ)) {
          continue;
        }
        conflicts.push(
          `Two generated files define the shared type "${typ.name}" differently, and ` +
            `${this.relativePath} can only declare one of them:\n` +
            `  ${this.declarationOf(existing.typ)}  (from ${path.relative(process.cwd(), existing.file)})\n` +
            `  ${this.declarationOf(typ)}  (from ${path.relative(process.cwd(), file)})\n` +
            `The first is what was emitted, so the second file's queries are typed with the ` +
            `wrong definition. Give one of them a type name of its own — a typesOverrides ` +
            `entry, or a domain — or set sharedTypesFile to false to go back to per-file aliases.`,
        );
      }
    }
    // Advisory by default, fatal under failOnError: the same rule the rest of
    // codegen follows for a problem whose output is still a complete file.
    // tslint:disable-next-line:no-console
    conflicts.forEach((conflict) => console.warn(conflict));
    if (this.config.failOnError && conflicts.length > 0) {
      throw new Error(conflicts.join('\n'));
    }
    return [...chosen.values()]
      .map(({ typ }) => typ)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The shared file's contents, or null when nothing is shared at all. */
  render(): string | null {
    if (this.filePath === null) {
      return null;
    }
    const types = this.resolve();
    if (types.length === 0) {
      return null;
    }
    const defs = toTypeDefinitions(types);
    // Two passes so that the re-export can sit with the imports it re-exports
    // rather than after every alias.
    const importDecs = TypeAllocator.typeDefinitionDeclarations(this.filePath, {
      imports: defs.imports,
      enums: [],
      aliases: [],
    });
    const aliasDecs = TypeAllocator.typeDefinitionDeclarations(this.filePath, {
      imports: {},
      enums: defs.enums,
      aliases: defs.aliases,
    });
    // An import is not an export, so a generated file that names an imported
    // type directly — `email: EmailAddress` — needs it passed on from here.
    const importedNames = types
      .filter((typ) => typ.kind === 'import')
      .map((typ) => typ.name);
    const reexport = importedNames.length
      ? `export type { ${importedNames.join(', ')} };\n`
      : '';
    return (
      SHARED_TYPES_HEADER +
      [importDecs, reexport, aliasDecs].filter((s) => s).join('\n')
    );
  }

  /**
   * Writes the shared file if what it should hold has changed. Returns whether
   * anything was written or removed.
   */
  async write(): Promise<boolean> {
    if (this.filePath === null) {
      return false;
    }
    const run = this.queue.then(() => this.writeNow(this.filePath!));
    // A rejected write must not poison every later one, so the queue follows
    // the settled promise rather than the failing one.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeNow(filePath: string): Promise<boolean> {
    const contents = this.render();
    const existing = (await fs.pathExists(filePath))
      ? await fs.readFile(filePath, { encoding: 'utf-8' })
      : null;
    if (contents === null) {
      // Nothing is shared. Emitting an empty file would leave a stray module
      // in every project that has no enums and no array columns; one left over
      // from a run that did have them is removed, but only if it is ours.
      if (existing !== null && existing.startsWith(SHARED_TYPES_HEADER)) {
        await fs.remove(filePath);
        return true;
      }
      return false;
    }
    if (existing === contents) {
      return false;
    }
    await fs.outputFile(filePath, contents);
    return true;
  }
}
