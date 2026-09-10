import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './config.js';

function configFile(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgtyped-config-'));
  const file = join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      srcDir: './src',
      transforms: [{ mode: 'sql', include: '**/*.sql' }],
      ...body,
    }),
  );
  return file;
}

describe('parseConfig', () => {
  test('preparedStatements defaults to true', () => {
    expect(parseConfig(configFile({})).preparedStatements).toBe(true);
  });

  test('hungarianNotation defaults to false', () => {
    expect(parseConfig(configFile({})).hungarianNotation).toBe(false);
  });

  test('explicit values are honoured', () => {
    const c = parseConfig(
      configFile({ preparedStatements: false, hungarianNotation: true }),
    );
    expect(c.preparedStatements).toBe(false);
    expect(c.hungarianNotation).toBe(true);
  });

  test('a ts-implicit transform is rejected by name', () => {
    expect(() =>
      parseConfig(
        configFile({
          transforms: [
            {
              mode: 'ts-implicit',
              include: 'x.ts',
              functionName: 'sql',
              emitFileName: 'out.ts',
            },
          ],
        }),
      ),
    ).toThrow(/mode "ts-implicit" was removed in 3\.0/);
  });

  test('maxWorkerThreads is rejected as unknown', () => {
    expect(() => parseConfig(configFile({ maxWorkerThreads: 4 }))).toThrow(
      /maxWorkerThreads/,
    );
  });

  test('a missing transforms field is a clear error naming the field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgtyped-config-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ srcDir: './src' }));
    expect(() => parseConfig(file)).toThrow(/transforms/);
  });

  // Only the top level used to be strict, so a typo one level down was
  // dropped and read back as "not set" — `db: { dbname: 'x' }` quietly
  // generated types against the default `postgres` database.
  describe('nested objects are strict too', () => {
    test('an unknown key in db is rejected, naming the path', () => {
      expect(() => parseConfig(configFile({ db: { dbname: 'x' } }))).toThrow(
        /db\.dbname/,
      );
    });

    test('an unknown key in a transform is rejected, naming the path', () => {
      expect(() =>
        parseConfig(
          configFile({
            transforms: [
              { mode: 'sql', include: '**/*.sql', emitFilename: 'out.ts' },
            ],
          }),
        ),
      ).toThrow(/transforms\.0\.emitFilename/);
    });

    test('an unknown key in a typesOverrides entry is rejected', () => {
      expect(() =>
        parseConfig(configFile({ typesOverrides: { date: { retrun: 'x' } } })),
      ).toThrow(/typesOverrides\.date\.retrun/);
    });

    test('the spelling that was meant still works', () => {
      expect(parseConfig(configFile({ db: { dbName: 'x' } })).db.dbName).toBe(
        'x',
      );
    });

    test('db.ssl stays permissive, being handed to node TLS verbatim', () => {
      const c = parseConfig(
        configFile({
          db: { dbName: 'x', ssl: { rejectUnauthorized: false, ca: ['pem'] } },
        }),
      );
      expect(c.db.ssl).toStrictEqual({
        rejectUnauthorized: false,
        ca: ['pem'],
      });
    });
  });

  /**
   * `typesOverrides` is keyed by type name. A column-shaped key passed
   * validation, because the schema is a plain record, and then did nothing at
   * all — no warning, no error (#567). It cannot be implemented for parameters,
   * which have no column to be scoped to, so it is rejected instead.
   */
  describe('a column-shaped typesOverrides key', () => {
    test('is rejected, naming the key and what to do instead', () => {
      expect(() =>
        parseConfig(
          configFile({
            typesOverrides: { 'lobbies.status': './x.js#MyStatus' },
          }),
        ),
      ).toThrow(/"lobbies\.status" looks like a column/);
      expect(() =>
        parseConfig(
          configFile({
            typesOverrides: { 'lobbies.status': './x.js#MyStatus' },
          }),
        ),
      ).toThrow(/CREATE DOMAIN/);
    });

    test('is rejected in the two-directional form too', () => {
      expect(() =>
        parseConfig(
          configFile({
            typesOverrides: { 'lobbies.status': { return: './x.js#MyStatus' } },
          }),
        ),
      ).toThrow(/looks like a column/);
    });

    test('every bad key is reported, not just the first', () => {
      try {
        parseConfig(
          configFile({
            typesOverrides: { 'a.b': 'string', 'c.d': 'string' },
          }),
        );
        expect.unreachable('parseConfig should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('"a.b"');
        expect((err as Error).message).toContain('"c.d"');
      }
    });

    test('a type name is still accepted, dots being the only thing rejected', () => {
      const c = parseConfig(
        configFile({
          typesOverrides: { lobby_status: './x.js#MyStatus', int8: 'BigInt' },
        }),
      );
      expect(c.typesOverrides.lobby_status.return).toStrictEqual({
        name: 'MyStatus',
        from: './x.js',
        aliasOf: undefined,
      });
      expect(c.typesOverrides.int8.parameter).toStrictEqual({
        name: 'BigInt',
      });
    });
  });
});
