import nun from 'nunjucks';
import pg from 'pg';
import { ParsedConfig, TransformConfig } from './config.js';
import { typeDb, verifyConnection } from './db/type-db.js';
import { TypescriptAndSqlTransformer } from './typescriptAndSqlTransformer.js';
import { debug, fatal, MAX_CONCURRENCY } from './util.js';

// tslint:disable:no-console

nun.configure({ autoescape: false });

/**
 * Runs codegen once, or starts it watching.
 *
 * Returns the exit code the run earned, or `undefined` in watch mode, where
 * the run has no end: the pool and the file watchers stay open and the caller
 * is expected to keep the process alive. `cli.ts` owns the exit; nothing here
 * ends the process except an unrecoverable failure, so importing this module
 * cannot take a host process down with it (see the note in `cli.ts`).
 */
export async function main(
  cfg: ParsedConfig | Promise<ParsedConfig>,
  // tslint:disable-next-line:no-shadowed-variable
  isWatchMode: boolean,
  // tslint:disable-next-line:no-shadowed-variable
  fileOverride?: string,
): Promise<number | undefined> {
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
    return undefined;
  }

  let transforms;
  try {
    transforms = await Promise.all(tasks);
  } catch {
    // The failing file has already been reported; failOnError got us here.
    await pool.end();
    return 1;
  }
  let exitCode = 0;
  if (fileOverride && !transforms.some((x) => x)) {
    // A `--file` that matched nothing generated nothing, and said so on
    // stdout while exiting 0 — so a targeted regeneration step could silently
    // do nothing and still report success (#579).
    console.error(
      'File override specified, but file was not found in provided transforms',
    );
    exitCode = 1;
  }
  await pool.end();
  return exitCode;
}
