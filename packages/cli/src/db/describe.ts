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
