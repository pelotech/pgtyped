/**
 * A `TypeDb` over an in-process PGlite, so codegen can run with no server and
 * no listener anywhere: create a PGlite, apply your migrations to it in the
 * same process, hand it to `main`'s `db` parameter.
 *
 * `@electric-sql/pglite` is an optional peer dependency — a WASM Postgres is
 * several megabytes and nobody generating against a real server should pay for
 * it — so this module is reachable only through the package's `./pglite`
 * export. Importing `@pelotech/pgtyped-cli` itself never loads it, the same way
 * `parseTypescript.ts` keeps the TypeScript compiler off the `sql`-only path.
 */

import { protocol, type PGliteInterface } from '@electric-sql/pglite';
import {
  supportsGenericPlan,
  type Described,
  type DescribedField,
} from './describe.js';
import type { TypeDb } from './type-db.js';

/**
 * PGlite re-exports its message classes as values only, so the two shapes this
 * module narrows to are named through `InstanceType` rather than imported.
 */
type ParameterDescription = InstanceType<
  typeof protocol.messages.ParameterDescriptionMessage
>;
type RowDescription = InstanceType<
  typeof protocol.messages.RowDescriptionMessage
>;

/**
 * The slice of PGlite this adapter calls, in the same spirit as `describe.ts`'s
 * `Pick<Pool, 'connect'>`: a `Transaction` has no `execProtocol`, so spelling
 * out what is needed says which objects will actually do.
 */
export type PGliteDb = Pick<
  PGliteInterface,
  'query' | 'exec' | 'execProtocol' | 'runExclusive'
>;

function concat(parts: Uint8Array[]): Uint8Array {
  const message = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  return message;
}

/**
 * One Parse + Describe(statement) + Sync on the unnamed statement, exactly as
 * the pool adapter's `DescribeStatement` sends it.
 *
 * `db.describeQuery()` looks like the obvious call and cannot be used: it
 * returns `{dataTypeID, parser}` per column and no `tableID`/`columnID`, so the
 * `pg_attribute` nullability join in `db/types.ts` has nothing to join on and
 * every column comes out nullable. `execProtocol` with the exported
 * `protocol.serialize` gives the full RowDescription and touches no private
 * API.
 *
 * Resolves `undefined` if the instance answered with nothing at all — no
 * parameter description, no row description and no error. A statement Describe
 * always carries a `parameterDescription` (an empty one for a query with no
 * parameters, followed by `noData` rather than a `rowDescription` when nothing
 * is returned), so a response with neither is not a description of anything.
 * An error is thrown by `execProtocol` itself and never reaches the loop.
 */
async function sendDescribe(
  db: PGliteDb,
  text: string,
): Promise<Described | undefined> {
  const { messages } = await db.execProtocol(
    concat([
      protocol.serialize.parse({ text }),
      protocol.serialize.describe({ type: 'S' }),
      protocol.serialize.sync(),
    ]),
  );

  let params: { oid: number }[] | undefined;
  let fields: DescribedField[] | undefined;
  for (const message of messages) {
    if (message.name === 'parameterDescription') {
      params = (message as ParameterDescription).dataTypeIDs.map((oid) => ({
        oid,
      }));
    } else if (message.name === 'rowDescription') {
      fields = (message as RowDescription).fields.map((field) => ({
        name: field.name,
        tableOID: field.tableID,
        columnAttrNumber: field.columnID,
        typeOID: field.dataTypeID,
        typeSize: field.dataTypeSize,
        typeModifier: field.dataTypeModifier,
        // Already the wire's 0/1. pg hands its consumers the decoded
        // `'text'`/`'binary'`, which is why `DescribeStatement` compares
        // against a string and this does not.
        formatCode: field.format,
      }));
    }
  }
  if (params === undefined && fields === undefined) {
    return undefined;
  }
  return { params: params ?? [], fields: fields ?? [] };
}

async function describe(db: PGliteDb, text: string): Promise<Described> {
  // The most important line in this file. `execProtocol` is *not* covered by
  // PGlite's query lock, and the failure is silent: a same-tick burst of nine
  // unlocked describes has one caller receive every backend message and the
  // other eight receive none, yielding an empty `Described` — which codegen
  // renders as `never` with no error at all. `runExclusive` is what makes
  // concurrent transforms correct here.
  const described = await db.runExclusive(async () => {
    // An empty answer is never returned as a description. The known cause is
    // a client session through `@electric-sql/pglite-socket`: after the
    // server is stopped, the instance's next `execProtocol` returns zero
    // messages and the one after it is normal, so the first Describe would
    // otherwise come back as "no params, no columns" and be typed as such.
    // Parse/Describe/Sync has no side effects, so a second attempt is safe
    // and drains whatever swallowed the first; if that is empty too, the
    // instance is not answering and saying so beats generating from nothing.
    // The guard is not socket-specific on purpose — it covers any cause of
    // swallowed output, which is why there is no drain at construction.
    return (await sendDescribe(db, text)) ?? (await sendDescribe(db, text));
  });
  if (described === undefined) {
    throw new Error(
      `PGlite returned no response to a Describe of this query, and none on a ` +
        `retry either: no parameter description, no row description and no ` +
        `error. The instance is not answering the extended-query protocol, so ` +
        `no types can be generated for it. Query: ${text}`,
    );
  }
  return described;
}

/**
 * `EXPLAIN` through `exec()`, never `query()`: `query()` always sends a Bind,
 * so `EXPLAIN (GENERIC_PLAN) … WHERE id = $1` fails `08P01 bind message
 * supplies 0 parameters`. The pre-16 fallback is the one place a Bind is
 * wanted, and there `query()` is right.
 *
 * See `explain` in `describe.ts` for why nothing is rolled back and what
 * `GENERIC_PLAN` buys.
 */
async function explain(
  db: PGliteDb,
  text: string,
  paramCount: number,
  genericPlan: boolean,
): Promise<void> {
  if (genericPlan) {
    await db.exec(`EXPLAIN (GENERIC_PLAN) ${text}`);
  } else {
    await db.query(`EXPLAIN ${text}`, new Array<null>(paramCount).fill(null));
  }
}

/**
 * Wraps `db` as the database type discovery talks to.
 *
 * The instance is not opened, closed or migrated here: whatever schema it
 * already has is the schema codegen describes against. Privileges are the
 * caller's too — a PGlite has no listener to authenticate against, so codegen
 * runs as the superuser that created it unless the caller has done `SET ROLE`.
 */
export function pgliteTypeDb(db: PGliteDb): TypeDb {
  // Asked for once per run, and only if something calls explain(); see
  // `typeDb`. PGlite has only ever shipped Postgres 16 and up, so the fallback
  // below is unreachable today — the version is read rather than assumed so
  // the two adapters cannot answer this differently.
  let genericPlan: Promise<boolean> | undefined;
  const canPlanGenerically = () =>
    (genericPlan ??= db
      .query<{ server_version_num: string }>('SHOW server_version_num')
      .then(({ rows }) =>
        supportsGenericPlan(Number(rows[0].server_version_num)),
      ));

  return {
    describe: (text) => describe(db, text),
    rows: async (sql) => (await db.query<Record<string, unknown>>(sql)).rows,
    explain: async (text, paramCount) =>
      explain(db, text, paramCount, await canPlanGenerically()),
  };
}
