import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exit codes are a property of the process, not of a function, so these run
 * the built CLI for real. They need `pnpm build` to have run first, which CI
 * does before `pnpm test`.
 */
const cliEntry = fileURLToPath(new URL('../lib/index.js', import.meta.url));

/**
 * The config file's db block is only a default: parseConfig lets PGHOST and
 * friends override it, so an ambient database in the developer's shell would
 * quietly rescue a test that is meant to fail to connect. yargs' .env() also
 * maps bare env vars onto CLI options. Hand the child a scrubbed environment.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PG') || key === 'DATABASE_URL') continue;
    if (['CONFIG', 'WATCH', 'URI', 'FILE'].includes(key)) continue;
    env[key] = value;
  }
  return env;
}

function runCli(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: 'utf-8',
    env: childEnv(),
  });
}

/** A port nothing is listening on, so connecting to it is refused at once. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('no port assigned'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function project(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgtyped-cli-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const sqlProject = (config: Record<string, unknown>) => ({
  srcDir: './src/',
  transforms: [
    {
      mode: 'sql',
      include: '**/*.sql',
      emitTemplate: '{{dir}}/{{name}}.queries.ts',
    },
  ],
  ...config,
});

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    throw new Error(
      `${cliEntry} does not exist. Run "pnpm build" before the CLI tests.`,
    );
  }
});

describe('cli exit codes', () => {
  test('an unrecognised config key fails the run', () => {
    const dir = project(sqlProject({ maxWorkerThreads: 4 }));

    const { status, stderr } = runCli(['-c', 'config.json'], dir);

    expect(status).not.toBe(0);
    expect(stderr).toContain('Failed to parse config file');
    expect(stderr).toContain('maxWorkerThreads');
  });

  test('a missing config file fails the run', () => {
    const dir = project(sqlProject({}));

    const { status, stderr } = runCli(['-c', 'no-such-config.json'], dir);

    expect(status).not.toBe(0);
    expect(stderr).toContain('Failed to parse config file');
  });

  test('an unreachable database fails the run and writes no file', async () => {
    const port = await closedPort();
    const dir = project(
      sqlProject({
        db: {
          host: '127.0.0.1',
          port,
          user: 'postgres',
          password: 'password',
          dbName: 'postgres',
        },
      }),
    );
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'q.sql'), '/* @name EnvQ */\nSELECT 1 AS one;\n');
    // Stands in for correct output from an earlier, working run: the defect
    // was that a connection failure replaced it with `export type … = never`.
    const emitted = join(src, 'q.queries.ts');
    writeFileSync(emitted, 'export type EnvQResult = { one: number };\n');

    const { status, stderr } = runCli(['-c', 'config.json'], dir);

    expect(status).not.toBe(0);
    expect(stderr).toContain('No files were written');
    expect(readFileSync(emitted, 'utf-8')).toBe(
      'export type EnvQResult = { one: number };\n',
    );
    expect(readdirSync(src).sort()).toEqual(['q.queries.ts', 'q.sql']);
  }, 30_000);
});
