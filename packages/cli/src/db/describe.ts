import type { Connection, Pool, Submittable } from 'pg';

export interface DescribedField {
  name: string;
  tableOID: number;
  columnAttrNumber: number;
  typeOID: number;
  typeSize: number;
  typeModifier: number;
  formatCode: number;
}

export interface Described {
  params: { oid: number }[];
  fields: DescribedField[];
}

/**
 * The slice of pg's Connection this module calls. @types/pg declares parse()
 * and describe() with a second `more` argument that the runtime ignores, and
 * types() as string[]; this local view matches what the runtime actually
 * accepts so the calls typecheck without lying about arity.
 */
interface DescribeConnection {
  parse(query: { name: string; text: string; types: never[] }): void;
  describe(msg: { type: 'S'; name: string }): void;
  sync(): void;
  once(
    event: 'parameterDescription',
    listener: (msg: { dataTypeIDs: number[] }) => void,
  ): unknown;
  removeListener(
    event: 'parameterDescription',
    listener: (msg: { dataTypeIDs: number[] }) => void,
  ): unknown;
}

interface RowDescriptionMessage {
  fields: {
    name: string;
    tableID: number;
    columnID: number;
    dataTypeID: number;
    dataTypeSize: number;
    dataTypeModifier: number;
    format: string;
  }[];
}

/**
 * Asks Postgres what a statement's parameter and result types are without
 * executing it: Parse + Describe(statement) + Sync on the unnamed statement,
 * so nothing accumulates server-side.
 *
 * pg's Client drives any object with submit() through the handle* methods
 * below as backend messages arrive. Two pg behaviours shape this class:
 * ParameterDescription is not routed to the active query, so it is taken off
 * the connection directly; and on ErrorResponse the client drops the active
 * query *before* calling handleError, so handleReadyForQuery never follows an
 * error and the promise must settle in handleError itself.
 */
export class DescribeStatement implements Submittable {
  readonly promise: Promise<Described>;
  private resolve!: (d: Described) => void;
  private reject!: (e: Error) => void;
  private settled = false;
  private connection: DescribeConnection | undefined;
  private params: { oid: number }[] = [];
  private fields: DescribedField[] = [];
  private readonly onParams = (msg: { dataTypeIDs: number[] }): void => {
    this.params = msg.dataTypeIDs.map((oid) => ({ oid }));
  };

  constructor(private readonly text: string) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  submit(connection: Connection): void {
    const con = connection as unknown as DescribeConnection;
    this.connection = con;
    con.once('parameterDescription', this.onParams);
    con.parse({ name: '', text: this.text, types: [] });
    con.describe({ type: 'S', name: '' });
    con.sync();
  }

  handleRowDescription(msg: RowDescriptionMessage): void {
    this.fields = msg.fields.map((f) => ({
      name: f.name,
      tableOID: f.tableID,
      columnAttrNumber: f.columnID,
      typeOID: f.dataTypeID,
      typeSize: f.dataTypeSize,
      typeModifier: f.dataTypeModifier,
      formatCode: f.format === 'binary' ? 1 : 0,
    }));
  }

  handleError(err: Error, _connection: Connection): void {
    this.settle(() => this.reject(err));
  }

  handleReadyForQuery(_connection: Connection): void {
    this.settle(() =>
      this.resolve({ params: this.params, fields: this.fields }),
    );
  }

  private settle(outcome: () => void): void {
    if (this.settled) return;
    this.settled = true;
    this.connection?.removeListener('parameterDescription', this.onParams);
    outcome();
  }

  // Describe never produces these; pg still requires the methods to exist.
  handleEmptyQuery(): void {}
  handleDataRow(): void {}
  handleCommandComplete(): void {}
  handlePortalSuspended(): void {}
  handleCopyInResponse(): void {}
  handleCopyData(): void {}
}

/**
 * Describes `text` on a client checked out of `pool`. Pool.query() has no
 * submittable path — it would never release the client — so this is the only
 * correct way to run a DescribeStatement against a pool.
 */
export async function describe(
  pool: Pick<Pool, 'connect'>,
  text: string,
): Promise<Described> {
  const client = await pool.connect();
  try {
    const statement = new DescribeStatement(text);
    client.query(statement);
    return await statement.promise;
  } finally {
    client.release();
  }
}

/**
 * The `server_version_num` above which `EXPLAIN (GENERIC_PLAN)` exists, added
 * in PostgreSQL 16.
 */
const GENERIC_PLAN_MIN_VERSION = 160000;

/** `SHOW server_version_num` as an integer, e.g. 180006 for 18.6. */
export async function serverVersionNum(
  pool: Pick<Pool, 'query'>,
): Promise<number> {
  const { rows } = await pool.query('SHOW server_version_num');
  return Number((rows[0] as { server_version_num: string }).server_version_num);
}

export function supportsGenericPlan(version: number): boolean {
  return version >= GENERIC_PLAN_MIN_VERSION;
}

/**
 * Plans `text` without running it, so the server applies the table and column
 * privileges it otherwise only checks at execute time. Resolves if the role
 * may run the query, rejects with the server's error if it may not.
 *
 * `EXPLAIN` without `ANALYZE` never executes: an `INSERT`, `UPDATE`, `DELETE`
 * or `… RETURNING` is planned and discarded, no row is written and no sequence
 * advances. That was verified against a live server, not assumed, so no
 * transaction is wrapped around this — there is nothing to roll back.
 *
 * On PostgreSQL 16 and up the statement is planned with `GENERIC_PLAN`, which
 * plans `$1` as a parameter rather than as a value. That matters: with values
 * bound, `WHERE id = $1` against a NULL folds to a constant false, the planner
 * drops the whole join tree, and a table reachable only through it — an
 * `EXISTS (SELECT 1 FROM secrets)`, say — never gets its privileges checked at
 * all. `GENERIC_PLAN` binds nothing, so it cannot mis-plan on a value, and no
 * parameter can be blamed for what it reports.
 *
 * Before 16 there is no such option and the only way to plan a parameterised
 * statement is to give it values, so `NULL` is bound for each one and the
 * check under-reports on exactly the shape above.
 */
export async function explain(
  pool: Pick<Pool, 'connect'>,
  text: string,
  paramCount: number,
  genericPlan: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    if (genericPlan) {
      await client.query(`EXPLAIN (GENERIC_PLAN) ${text}`);
    } else {
      await client.query(
        `EXPLAIN ${text}`,
        new Array<null>(paramCount).fill(null),
      );
    }
  } finally {
    client.release();
  }
}
