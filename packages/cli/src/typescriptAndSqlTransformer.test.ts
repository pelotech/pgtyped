import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { TransformConfig } from './config.js';
import {
  findQueryFiles,
  isUnderNodeModules,
  matchFileOverride,
} from './typescriptAndSqlTransformer.js';

const sqlTransform = {
  mode: 'sql',
  include: '**/*.sql',
  emitTemplate: '{{dir}}/{{name}}.queries.ts',
} as TransformConfig;

/** A source tree with an installed dependency inside it, as #534 describes. */
function srcTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgtyped-discovery-'));
  const src = join(dir, 'src');
  mkdirSync(join(src, 'nested'), { recursive: true });
  writeFileSync(join(src, 'a.sql'), '/* @name A */\nSELECT 1;\n');
  writeFileSync(join(src, 'nested', 'b.sql'), '/* @name B */\nSELECT 1;\n');

  const dep = join(src, 'node_modules', 'somepkg');
  mkdirSync(join(dep, 'deep'), { recursive: true });
  writeFileSync(join(dep, 'c.sql'), '/* @name C */\nSELECT 1;\n');
  writeFileSync(join(dep, 'deep', 'd.sql'), '/* @name D */\nSELECT 1;\n');
  return src;
}

/**
 * `globSync` walked straight into an installed tree, so a dependency shipping
 * its own `.sql` files had every one of them described against this project's
 * schema. Upstream #534.
 */
describe('query file discovery', () => {
  test('files under node_modules are not query files', () => {
    const src = srcTree();

    const found = findQueryFiles(src, sqlTransform)
      .map((f) => relative(src, f).split(sep).join('/'))
      .sort();

    expect(found).toStrictEqual(['a.sql', 'nested/b.sql']);
  });

  test('an emitFileName is still excluded alongside node_modules', () => {
    const src = srcTree();
    writeFileSync(join(src, 'all.sql'), '/* @name All */\nSELECT 1;\n');

    const found = findQueryFiles(src, {
      ...sqlTransform,
      emitFileName: '/all.sql',
    } as TransformConfig)
      .map((f) => relative(src, f).split(sep).join('/'))
      .sort();

    expect(found).toStrictEqual(['a.sql', 'nested/b.sql']);
  });

  /**
   * The watcher had no exclusion either, so watch mode both descended into an
   * installed tree and held watch descriptors on it.
   */
  describe('the watcher ignores the same paths', () => {
    test.each([
      'src/node_modules',
      'src/node_modules/somepkg/c.sql',
      'src/node_modules/somepkg/deep/d.sql',
      'src\\node_modules\\somepkg\\c.sql',
    ])('%s is ignored', (fileName) => {
      expect(isUnderNodeModules(fileName)).toBe(true);
    });

    test.each([
      'src/a.sql',
      'src/nested/b.sql',
      // A directory merely *named* like one is not one.
      'src/node_modules_helpers/e.sql',
      'src/my_node_modules.sql',
    ])('%s is not ignored', (fileName) => {
      expect(isUnderNodeModules(fileName)).toBe(false);
    });
  });
});

/**
 * `--file` was matched with `fileList.includes(fileOverride)` — raw string
 * equality against glob output — so exactly one spelling of the path worked
 * and every other one printed "file was not found in provided transforms" and
 * generated nothing. Upstream #579.
 */
describe('--file matching', () => {
  const fileList = ['multi/a/one.sql', 'multi/b/two.sql'];

  test('the spelling glob happens to produce still matches', () => {
    expect(matchFileOverride(fileList, 'multi/a/one.sql')).toBe(
      'multi/a/one.sql',
    );
  });

  test.each([
    ['a leading ./', './multi/a/one.sql'],
    ['an absolute path', join(process.cwd(), 'multi', 'a', 'one.sql')],
    ['a redundant segment', 'multi/b/../a/one.sql'],
  ])('%s matches too', (_label, spelling) => {
    expect(matchFileOverride(fileList, spelling)).toBe('multi/a/one.sql');
  });

  test('the glob spelling is what is returned, not the one typed', () => {
    // So the `Processing …` lines do not depend on how the flag was written.
    expect(matchFileOverride(fileList, './multi/b/two.sql')).toBe(
      'multi/b/two.sql',
    );
  });

  test('a file the transform does not cover still matches nothing', () => {
    expect(matchFileOverride(fileList, 'multi/c/three.sql')).toBeUndefined();
  });
});
