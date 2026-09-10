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

/**
 * Environment over config is the precedence PgTyped has always had, and it is
 * not changing — someone is relying on it. What was wrong is that it was
 * silent: `PGDATABASE=prod` in a developer's shell replaced an explicit
 * `dbUrl` and generated types from the wrong schema without a word, and the
 * only reason the triage saw it at all was that the displaced database
 * happened not to exist.
 */
describe('an ambient PG* variable displacing the config', () => {
  const dbUrl = 'postgres://alice:s3cret@dbhost:6000/app_dev';

  beforeEach(() => {
    // The developer running the tests may well have some of these exported.
    for (const name of [
      'PGHOST',
      'PGUSER',
      'PGPASSWORD',
      'PGDATABASE',
      'PGPORT',
      'PGURI',
      'DATABASE_URL',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const parse = (body: Record<string, unknown>, uri?: string) => {
    const warnings: string[] = [];
    const spy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: [unknown]) => {
        warnings.push(String(args[0]));
      });
    try {
      return { config: parseConfig(configFile(body), uri), warnings };
    } finally {
      spy.mockRestore();
    }
  };

  test('is reported, naming the variable and the field it displaced', () => {
    vi.stubEnv('PGDATABASE', 'prod');
    const { config, warnings } = parse({ dbUrl });

    expect(warnings).toEqual([
      'Warning: environment variable PGDATABASE overrides dbName from the config file: ' +
        '"prod" replaces "app_dev", set by dbUrl. Environment variables take precedence over ' +
        'the config file, so that is what PgTyped will connect with — unset PGDATABASE if it ' +
        'is not what you meant.',
    ]);
    // The precedence itself is unchanged.
    expect(config.db.dbName).toBe('prod');
  });

  test('names the db key when that is where the value came from', () => {
    vi.stubEnv('PGHOST', 'elsewhere');
    const { warnings } = parse({ db: { host: 'configured-host' } });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PGHOST');
    expect(warnings[0]).toContain('set by db.host');
    expect(warnings[0]).toContain('"elsewhere" replaces "configured-host"');
  });

  // Filling in what the config left unset is what these variables are *for*.
  test('stays quiet when the config left the field unset', () => {
    vi.stubEnv('PGHOST', 'from-env');
    vi.stubEnv('PGPORT', '6543');
    const { config, warnings } = parse({ db: { dbName: 'app_dev' } });

    expect(warnings).toEqual([]);
    expect(config.db.host).toBe('from-env');
    expect(config.db.port).toBe(6543);
  });

  test('stays quiet when there is no config file db section at all', () => {
    vi.stubEnv('PGHOST', 'from-env');
    vi.stubEnv('PGDATABASE', 'from-env');
    expect(parse({}).warnings).toEqual([]);
  });

  test('stays quiet when the variable agrees with the config', () => {
    vi.stubEnv('PGDATABASE', 'app_dev');
    vi.stubEnv('PGPORT', '6000');
    expect(parse({ dbUrl }).warnings).toEqual([]);
  });

  // The flag has already taken precedence over the config by then, so the
  // environment is not what displaced the config's value.
  test('stays quiet when a --uri flag already displaced the config value', () => {
    vi.stubEnv('PGDATABASE', 'from-env');
    const { config, warnings } = parse(
      { dbUrl },
      'postgres://bob:pw@flaghost:7000/from_flag',
    );

    expect(warnings).toEqual([]);
    expect(config.db.dbName).toBe('from-env');
  });

  test('PGPASSWORD is named but its value is not printed', () => {
    vi.stubEnv('PGPASSWORD', 'from-env-password');
    const { warnings } = parse({ db: { password: 'configured-password' } });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'environment variable PGPASSWORD overrides the password set by db.password',
    );
    expect(warnings[0]).not.toContain('from-env-password');
    expect(warnings[0]).not.toContain('configured-password');
  });

  // A URI displaces every field at once, and neither value can be quoted into
  // the message because a connection string carries the password.
  test('PGURI displacing dbUrl is reported once, without either URI', () => {
    vi.stubEnv('PGURI', 'postgres://bob:pw@urihost:7000/from_uri');
    const { config, warnings } = parse({ dbUrl });

    expect(warnings).toEqual([
      'Warning: environment variable PGURI overrides dbUrl from the config file. ' +
        'Environment variables take precedence over the config file, so that is what PgTyped ' +
        'will connect with — unset PGURI if it is not what you meant.',
    ]);
    expect(config.db.dbName).toBe('from_uri');
  });

  test('DATABASE_URL is named as itself', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://bob:pw@urihost:7000/from_uri');
    const { warnings } = parse({ dbUrl });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('environment variable DATABASE_URL');
  });
});
