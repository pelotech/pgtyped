#!/usr/bin/env node

import chokidar from 'chokidar';
import nun from 'nunjucks';
import pg from 'pg';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseConfig, ParsedConfig, TransformConfig } from './config.js';
import { typeDb } from './db/type-db.js';
import { TypescriptAndSqlTransformer } from './typescriptAndSqlTransformer.js';
import { debug, MAX_CONCURRENCY } from './util.js';

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
  // buys the parallelism a thread pool used to. pg connects lazily, so this
  // costs nothing until the first query.
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

  const transformTask = async (transform: TransformConfig) => {
    const transformer = new TypescriptAndSqlTransformer(db, config, transform);
    return transformer.start(isWatchMode);
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
  console.log('Config file required. See help -h for details.\nExiting.');
  process.exit(0);
}

if (isWatchMode && fileOverride) {
  console.log('File override is not compatible with watch mode.\nExiting.');
  process.exit(0);
}

try {
  chokidar.watch(configPath, {}).on('change', () => {
    console.log('Config file changed. Exiting.');
    process.exit();
  });
  const config = parseConfig(configPath, connectionUri);
  main(config, isWatchMode || false, fileOverride).catch((e) =>
    debug('error in main: %o', e.message),
  );
} catch (e) {
  console.error('Failed to parse config file:');
  console.error((e as any).message);
  process.exit();
}
