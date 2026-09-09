import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
 * quietly change what a run does. yargs' .env() also maps bare env vars onto
 * CLI options. Hand the child a scrubbed environment.
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
});
