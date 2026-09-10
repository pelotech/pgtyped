#!/usr/bin/env node

import chokidar from 'chokidar';
import nun from 'nunjucks';
import pg from 'pg';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseConfig, ParsedConfig, TransformConfig } from './config.js';
import { typeDb, verifyConnection } from './db/type-db.js';
import { TypescriptAndSqlTransformer } from './typescriptAndSqlTransformer.js';
import { debug, fatal, MAX_CONCURRENCY } from './util.js';

// tslint:disable:no-console

nun.configure({ autoescape: false });

async function main(
  cfg: ParsedConfig | Promise<ParsedConfig>,
  // tslint:disable-next-line:no-shadowed-variable
  isWatchMode: boolean,
  // tslint:disable-next-line:no-shadowed-variable
  fileOverride?: string,
) {
  const config = await cfg;
  debug('starting codegenerator');

  // Codegen waits on the database, not on the CPU, so a small connection pool
  // buys the parallelism a thread pool used to. pg connects lazily, so no
  // connection is opened until the check below.
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.dbName,
    ssl: config.db.ssl,
    max: MAX_CONCURRENCY,
  });
  const db = typeDb(pool);

  // Nothing is written until the database has answered once. A failure here
  // used to arrive later, as a describe error per query, which codegen turns
  // into a `never` type — so an unreachable database quietly replaced correct
  // output with broken output and exited 0.
  try {
    await verifyConnection(pool);
  } catch (e) {
    await pool.end().catch(() => undefined);
    fatal(
      `Could not connect to the database at ${config.db.host}:${config.db.port} as user "${config.db.user}". No files were written.`,
      e,
    );
  }

  const transformTask = async (transform: TransformConfig) => {
    const transformer = new TypescriptAndSqlTransformer(db, config, transform);
    return transformer.start(isWatchMode, fileOverride);
  };

  const tasks = config.transforms.map(transformTask);

  // In watch mode the pool stays open for the lifetime of the process.
  if (isWatchMode) {
    return;
  }

  let transforms;
  try {
    transforms = await Promise.all(tasks);
  } catch {
    // The failing file has already been reported; failOnError got us here.
    await pool.end();
    process.exit(1);
  }
  if (fileOverride && !transforms.some((x) => x)) {
    console.log(
      'File override specified, but file was not found in provided transforms',
    );
  }
  await pool.end();
  process.exit(0);
}

const args = yargs(hideBin(process.argv))
  .version()
  .env()
  .options({
    config: {
      alias: 'c',
      type: 'string',
      description: 'Config file path',
      demandOption: true,
    },
    watch: {
      alias: 'w',
      description: 'Watch mode',
      type: 'boolean',
    },
    uri: {
      type: 'string',
      description: 'DB connection URI (overrides config)',
    },
    file: {
      alias: 'f',
      type: 'string',
      conflicts: 'watch',
      description: 'File path (process single file, incompatible with --watch)',
    },
  })
  .epilogue('For more information, find our manual at https://pgtyped.dev/')
  .parseSync();

const {
  watch: isWatchMode,
  file: fileOverride,
  config: configPath,
  uri: connectionUri,
} = args;

if (typeof configPath !== 'string') {
  fatal('Config file required. See help -h for details.\nExiting.');
}

if (isWatchMode && fileOverride) {
  fatal('File override is not compatible with watch mode.\nExiting.');
}

try {
  // Watch mode only. A one-shot run holds no long-lived state that a config
  // edit could invalidate, and watching from one anyway meant a build step
  // that rewrote the config while codegen ran — templating in a connection
  // string, say — killed the run mid-flight: exit 0, nothing written, green
  // CI, no generated types (#609, #616).
  if (isWatchMode) {
    chokidar.watch(configPath, {}).on('change', () => {
      // Not a failure: the config the run was started with is gone, so the run
      // ends deliberately and the user (or their supervisor process) restarts
      // it against the new one. Exiting non-zero here would report a broken
      // build every time someone edited the config in watch mode.
      console.log('Config file changed. Exiting.');
      process.exit(0);
    });
  }
  const config = parseConfig(configPath, connectionUri);
  main(config, isWatchMode || false, fileOverride).catch((e) =>
    fatal('Codegen failed:', e),
  );
} catch (e) {
  fatal('Failed to parse config file:', e);
}
