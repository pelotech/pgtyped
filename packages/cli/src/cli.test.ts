import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
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
const cliEntry = fileURLToPath(new URL('../lib/cli.js', import.meta.url));

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

/**
 * A server that accepts a connection and never answers it, so pg's startup
 * packet gets no reply and the CLI sits in `verifyConnection` for as long as a
 * test needs. That turns "does a config edit kill a run in flight?" into a
 * question with a deterministic answer instead of a race.
 */
async function hangingServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('no port assigned'));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long enough for the child to boot Node and for chokidar to have attached its
 * watcher — without the fix, that watcher is registered before `parseConfig`
 * even runs, so this only has to outlast process startup.
 */
const WATCHER_READY_MS = 2_000;
/** Long enough for a `Config file changed` exit to arrive if it is going to. */
const EXIT_WINDOW_MS = 5_000;

function spawnCli(args: string[], cwd: string) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd,
    env: childEnv(),
  });
  let output = '';
  child.stdout.setEncoding('utf-8').on('data', (chunk) => (output += chunk));
  child.stderr.setEncoding('utf-8').on('data', (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => resolve(code)),
  );
  return {
    /** The exit code, or `'running'` if the process outlasted `ms`. */
    settle: (ms: number) =>
      Promise.race([exited, delay(ms).then(() => 'running' as const)]),
    output: () => output,
    kill: () => child.kill('SIGKILL'),
  };
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

/**
 * `packages/cli` had no `"."` export and mapped `"./*"` onto `./lib/index.js`,
 * which was the bin: a `#!/usr/bin/env node` module with top-level yargs
 * parsing and `process.exit`. So the package could not be imported at all, and
 * any subpath import ran the CLI's argv parsing in the *importing* process —
 * printing --help and "Missing required argument: config" and taking the host
 * down with it. Found while evaluating PR #620.
 *
 * These resolve through the real `exports` map, from a scratch project with
 * the package symlinked into `node_modules`, because that map is the thing
 * under test.
 */
describe('the package can be imported without running the CLI', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));

  /** A scratch project with `@pelotech/pgtyped-cli` installed into it. */
  function consumer(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'pgtyped-consumer-'));
    mkdirSync(join(dir, 'node_modules', '@pelotech'), { recursive: true });
    symlinkSync(
      packageRoot,
      join(dir, 'node_modules', '@pelotech', 'pgtyped-cli'),
      'dir',
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    writeFileSync(join(dir, 'probe.mjs'), source);
    return dir;
  }

  function runNode(dir: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ['probe.mjs'], {
      cwd: dir,
      encoding: 'utf-8',
      env: childEnv(),
    });
  }

  test('the package entry point exports main and parses no argv', () => {
    const dir = consumer(
      "const m = await import('@pelotech/pgtyped-cli');\n" +
        "console.log('main:' + typeof m.main);\n",
    );

    const { status, stdout, stderr } = runNode(dir);

    expect(stderr).toBe('');
    expect(stdout).toBe('main:function\n');
    expect(status).toBe(0);
  }, 30_000);

  test('a subpath import gives that module, not the CLI', () => {
    const dir = consumer(
      "const m = await import('@pelotech/pgtyped-cli/generator.js');\n" +
        "console.log('gen:' + typeof m.generateInterface);\n",
    );

    const { status, stdout, stderr } = runNode(dir);

    // The whole symptom: --help and a demandOption failure in someone else's
    // process, with a non-zero exit nobody asked for.
    expect(stderr).not.toContain('Missing required argument');
    expect(stdout).not.toContain('--help');
    expect(stdout).toBe('gen:function\n');
    expect(status).toBe(0);
  }, 30_000);

  test('the bin is a separate module from the library entry point', () => {
    expect(
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
        bin: Record<string, string>;
      },
    ).toMatchObject({ bin: { pgtyped: 'lib/cli.js' } });
  });
});

/**
 * The config watcher used to be registered unconditionally, before the config
 * was even parsed, and its handler exits 0. So a one-shot run that overlapped
 * a config write — a build step templating a connection string in, say — died
 * mid-flight having written nothing, and reported success while doing it.
 * Upstream #609, #616.
 */
describe('config file watching', () => {
  test('a non-watch run is not ended by a config edit', async () => {
    const server = await hangingServer();
    const dir = project(
      sqlProject({
        db: {
          host: '127.0.0.1',
          port: server.port,
          user: 'postgres',
          password: 'password',
          dbName: 'postgres',
        },
      }),
    );
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'q.sql'),
      '/* @name OneShot */\nSELECT 1 AS one;\n',
    );

    const cli = spawnCli(['-c', 'config.json'], dir);
    try {
      await delay(WATCHER_READY_MS);
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify(sqlProject({ dbUrl: 'postgres://edited@127.0.0.1/x' })),
      );

      expect(await cli.settle(EXIT_WINDOW_MS)).toBe('running');
      expect(cli.output()).not.toContain('Config file changed');
    } finally {
      cli.kill();
      await server.close();
    }
  }, 30_000);

  test('a watch run still exits 0 when the config changes', async () => {
    const server = await hangingServer();
    const dir = project(
      sqlProject({
        db: {
          host: '127.0.0.1',
          port: server.port,
          user: 'postgres',
          password: 'password',
          dbName: 'postgres',
        },
      }),
    );
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'q.sql'),
      '/* @name Watched */\nSELECT 1 AS one;\n',
    );

    const cli = spawnCli(['-c', 'config.json', '-w'], dir);
    try {
      await delay(WATCHER_READY_MS);
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify(sqlProject({ dbUrl: 'postgres://edited@127.0.0.1/x' })),
      );

      // Deliberately exit 0: the run ended because the config it was started
      // with is gone, which is not a broken build. This also proves the
      // sibling test above is not passing vacuously — the same edit, made the
      // same way, does reach a watcher when one is registered.
      expect(await cli.settle(EXIT_WINDOW_MS)).toBe(0);
      expect(cli.output()).toContain('Config file changed. Exiting.');
    } finally {
      cli.kill();
      await server.close();
    }
  }, 30_000);
});
