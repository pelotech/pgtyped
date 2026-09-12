import nun from 'nunjucks';
import pg from 'pg';
import { ParsedConfig, TransformConfig } from './config.js';
import {
  currentRole,
  type TypeDb,
  typeDb,
  verifyConnection,
} from './db/type-db.js';
import { SharedTypeRegistry } from './sharedTypes.js';
import { TypescriptAndSqlTransformer } from './typescriptAndSqlTransformer.js';
import { debug, fatal, MAX_CONCURRENCY } from './util.js';

// tslint:disable:no-console

nun.configure({ autoescape: false });

/** What the run says when `checkPrivileges` is on and `roleName` is a superuser. */
function superuserWarning(roleName: string): string {
  return (
    `checkPrivileges is on, but codegen is running as "${roleName}", which is a superuser. ` +
    `A superuser bypasses every privilege check, so every query will pass and the check ` +
    `cannot report anything. Connect as the role the application runs as — or SET ROLE to ` +
    `it — for the check to mean anything.`
  );
}

/**
 * Runs codegen once, or starts it watching.
 *
 * Returns the exit code the run earned, or `undefined` in watch mode, where
 * the run has no end: the pool and the file watchers stay open and the caller
 * is expected to keep the process alive. `cli.ts` owns the exit; nothing here
 * ends the process except an unrecoverable failure, so importing this module
 * cannot take a host process down with it (see the note in `cli.ts`).
 *
 * `injectedDb` hands codegen a database it did not open. Nothing else on this
 * path needs a server — `pg` is imported for the pool and for nothing else —
 * so a caller holding an in-process Postgres can generate types with no
 * listener anywhere. `pgliteTypeDb` in `db/pglite.ts` is the adapter this fork
 * ships; anything implementing `TypeDb` works.
 */
export async function main(
  cfg: ParsedConfig | Promise<ParsedConfig>,
  // tslint:disable-next-line:no-shadowed-variable
  isWatchMode: boolean,
  // tslint:disable-next-line:no-shadowed-variable
  fileOverride?: string,
  injectedDb?: TypeDb,
): Promise<number | undefined> {
  const config = await cfg;
  debug('starting codegenerator');

  // Undefined exactly when a database was injected: there is then no pool to
  // build, none to close, and nothing to verify. Skipping the pre-flight is
  // right rather than merely convenient — it exists to catch an unreachable
  // *server*, and an injected TypeDb has none. A broken one still fails per
  // query, which is where an in-process database's failures belong.
  let pool: pg.Pool | undefined;
  let db = injectedDb;

  if (!db) {
    // Codegen waits on the database, not on the CPU, so a small connection
    // pool buys the parallelism a thread pool used to. pg connects lazily, so
    // no connection is opened until the check below.
    pool = new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.dbName,
      ssl: config.db.ssl,
      max: MAX_CONCURRENCY,
    });
    db = typeDb(pool);

    // Nothing is written until the database has answered once. A failure here
    // used to arrive later, as a describe error per query, which codegen turns
    // into a `never` type — so an unreachable database quietly replaced
    // correct output with broken output and exited 0.
    try {
      await verifyConnection(pool);
    } catch (e) {
      await pool.end().catch(() => undefined);
      fatal(
        `Could not connect to the database at ${config.db.host}:${config.db.port} as user "${config.db.user}". No files were written.`,
        e,
      );
    }
  }

  // A superuser bypasses every privilege check, so with `checkPrivileges` on
  // and codegen connected as one, every query passes and the clean run says
  // nothing at all — a silent false negative from the one feature whose job
  // is to catch privilege problems. Asked once per run, here, before any file
  // is processed: the answer is a property of the connection, not of a query,
  // and a run with the check off must not pay for a round trip it never uses.
  // The lookup goes through `rows`, so it holds for an injected PGlite too,
  // which is superuser by default and answers as the `SET ROLE` role after one.
  if (config.checkPrivileges) {
    const role = await currentRole(db);
    if (role.superuser) {
      console.warn(superuserWarning(role.name));
      // Advisory by default, fatal under failOnError — the rule every other
      // diagnostic follows. Before the first file rather than at the first
      // query, so the strict reading writes nothing at all.
      if (config.failOnError) {
        console.error(
          'failOnError is set, so the run stops here. No files were written.',
        );
        await pool?.end();
        return 1;
      }
    }
  }

  // One registry for every transform: a project with both `.sql` files and
  // `sql` tags shares one set of aliases between them.
  const sharedTypes = new SharedTypeRegistry(config);

  const transformTask = async (transform: TransformConfig) => {
    const transformer = new TypescriptAndSqlTransformer(
      db,
      config,
      transform,
      sharedTypes,
    );
    return transformer.start(isWatchMode, fileOverride);
  };

  const tasks = config.transforms.map(transformTask);

  // In watch mode the pool, if there is one, stays open for the lifetime of
  // the process.
  if (isWatchMode) {
    return undefined;
  }

  let transforms;
  try {
    transforms = await Promise.all(tasks);
  } catch {
    // The failing file has already been reported; failOnError got us here.
    await pool?.end();
    return 1;
  }
  let exitCode = 0;
  // Written once every transform has finished, because its contents are the
  // union over all of them. A `--file` run has only described the one file it
  // was given, so it knows nothing about what the rest still need and leaves
  // the union alone rather than truncating it to one file's share.
  if (sharedTypes.enabled) {
    if (fileOverride) {
      console.log(
        `Left ${sharedTypes.relativePath} alone: --file describes one file, which is not ` +
          `enough to know what the others still share. Run without --file if a new shared ` +
          `type is missing from it.`,
      );
    } else {
      try {
        if (await sharedTypes.write()) {
          console.log(`Saved shared types to ${sharedTypes.relativePath}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        await pool?.end();
        return 1;
      }
    }
  }
  if (fileOverride && !transforms.some((x) => x)) {
    // A `--file` that matched nothing generated nothing, and said so on
    // stdout while exiting 0 — so a targeted regeneration step could silently
    // do nothing and still report success (#579).
    console.error(
      'File override specified, but file was not found in provided transforms',
    );
    exitCode = 1;
  }
  await pool?.end();
  return exitCode;
}
