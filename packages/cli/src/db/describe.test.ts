import { EventEmitter } from 'node:events';
import {
  describe as describeStatement,
  DescribeStatement,
  explain,
  serverVersionNum,
  supportsGenericPlan,
  type Described,
} from './describe.js';

/*
 * Two pg behaviours (verified against pg@8.23.0, pg-pool@3.14.0) shape both the
 * submittable and these tests:
 *
 * 1. On ErrorResponse the client drops the active query *before* handing the
 *    error to it, so handleReadyForQuery never follows an error and a
 *    submittable that waits for ReadyForQuery to reject hangs forever.
 *    node_modules/pg/lib/client.js, _handleErrorMessage:
 *      this._activeQuery = null
 *      if (activeQuery.name) {
 *        delete this.connection.submittedNamedStatements[activeQuery.name]
 *      }
 *      activeQuery.handleError(msg, this.connection)
 *
 * 2. Pool.query has no submittable branch: it forwards to client.query(text,
 *    values, cb) and releases the client only from that callback, which a
 *    submittable never fires. node_modules/pg-pool/index.js, query():
 *      client.query(text, values, (err, res) => {
 *        ...
 *        clientReleased = true
 *        client.release(err)
 *    So a submittable must go through pool.connect() -> client.query(d) ->
 *    client.release(), never pool.query(d).
 */

/** Enough of pg's Connection for the submittable: records sends, lets a test emit messages. */
function fakeConnection() {
  const sent: unknown[] = [];
  const con = Object.assign(new EventEmitter(), {
    parse: (q: unknown) => sent.push(['parse', q]),
    describe: (m: unknown) => sent.push(['describe', m]),
    sync: () => sent.push(['sync']),
  });
  return { con, sent };
}

const field = {
  name: 'n',
  tableID: 0,
  columnID: 0,
  dataTypeID: 23,
  dataTypeSize: 4,
  dataTypeModifier: -1,
  format: 'text',
};

describe('DescribeStatement', () => {
  test('sends Parse, Describe(statement), Sync for the unnamed statement', () => {
    const { con, sent } = fakeConnection();
    new DescribeStatement('SELECT $1').submit(con as never);
    expect(sent).toStrictEqual([
      ['parse', { name: '', text: 'SELECT $1', types: [] }],
      ['describe', { type: 'S', name: '' }],
      ['sync'],
    ]);
  });

  test('resolves with param OIDs and result fields on ReadyForQuery', async () => {
    const { con } = fakeConnection();
    const d = new DescribeStatement('SELECT $1::int AS n');
    d.submit(con as never);
    con.emit('parameterDescription', { dataTypeIDs: [23] });
    d.handleRowDescription({ fields: [field] } as never);
    d.handleReadyForQuery(con as never);
    await expect(d.promise).resolves.toStrictEqual({
      params: [{ oid: 23 }],
      fields: [
        {
          name: 'n',
          tableOID: 0,
          columnAttrNumber: 0,
          typeOID: 23,
          typeSize: 4,
          typeModifier: -1,
          formatCode: 0,
        },
      ],
    });
  });

  test('a statement with no result columns resolves with empty fields', async () => {
    const { con } = fakeConnection();
    const d = new DescribeStatement('INSERT INTO t VALUES ($1)');
    d.submit(con as never);
    con.emit('parameterDescription', { dataTypeIDs: [25] });
    d.handleEmptyQuery();
    d.handleReadyForQuery(con as never);
    await expect(d.promise).resolves.toStrictEqual({
      params: [{ oid: 25 }],
      fields: [],
    });
  });

  test('rejects inside handleError, because pg never calls handleReadyForQuery after an error', async () => {
    const { con } = fakeConnection();
    const d = new DescribeStatement('SELEC 1');
    d.submit(con as never);
    const err = Object.assign(new Error('syntax error at or near "SELEC"'), {
      code: '42601',
      position: '1',
    });
    d.handleError(err, con as never);
    await expect(d.promise).rejects.toBe(err);
    expect(con.listenerCount('parameterDescription')).toBe(0);
  });

  test('a ReadyForQuery arriving after an error does not resolve a rejected promise', async () => {
    const { con } = fakeConnection();
    const d = new DescribeStatement('SELEC 1');
    d.submit(con as never);
    const err = new Error('boom');
    d.handleError(err, con as never);
    d.handleReadyForQuery(con as never);
    await expect(d.promise).rejects.toBe(err);
  });

  test('stops listening for parameterDescription once resolved', () => {
    const { con } = fakeConnection();
    const d = new DescribeStatement('SELECT 1');
    d.submit(con as never);
    d.handleReadyForQuery(con as never);
    expect(con.listenerCount('parameterDescription')).toBe(0);
  });
});

describe('describe(pool, text)', () => {
  /** A pool whose one client drives the submittable to the given outcome, and records release(). */
  function fakePool(outcome: 'ok' | 'error') {
    const release = vi.fn();
    const client = {
      query: (d: DescribeStatement) => {
        const { con } = fakeConnection();
        d.submit(con as never);
        if (outcome === 'ok') {
          con.emit('parameterDescription', { dataTypeIDs: [] });
          d.handleRowDescription({ fields: [field] } as never);
          d.handleReadyForQuery(con as never);
        } else {
          d.handleError(new Error('nope'), con as never);
        }
        return d;
      },
      release,
    };
    return { pool: { connect: async () => client }, release };
  }

  test('checks out a client, awaits the description, releases the client', async () => {
    const { pool, release } = fakePool('ok');
    const result: Described = await describeStatement(
      pool as never,
      'SELECT 1 AS n',
    );
    expect(result.fields.map((f) => f.name)).toStrictEqual(['n']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('releases the client even when the statement fails', async () => {
    const { pool, release } = fakePool('error');
    await expect(describeStatement(pool as never, 'SELEC 1')).rejects.toThrow(
      'nope',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('explain', () => {
  /** A pool whose one client records every query it is given, and its release. */
  function recordingPool(fail?: Error) {
    const queries: { text: string; values?: unknown[] }[] = [];
    const release = vi.fn();
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push(values === undefined ? { text } : { text, values });
        if (fail) throw fail;
        return { rows: [] };
      },
      release,
    };
    return { pool: { connect: async () => client }, queries, release };
  }

  test('plans generically, binding nothing, on a server that can', async () => {
    const { pool, queries, release } = recordingPool();

    await explain(pool as never, 'SELECT id FROM t WHERE id = $1', 1, true);

    expect(queries).toStrictEqual([
      { text: 'EXPLAIN (GENERIC_PLAN) SELECT id FROM t WHERE id = $1' },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  /**
   * Before PostgreSQL 16 a parameterised statement cannot be planned without
   * values, so one NULL per placeholder is the only option — and the reason
   * the check under-reports there. `paramCount` is what decides how many, not
   * anything read out of the SQL text.
   */
  test('binds a NULL per parameter on a server that cannot', async () => {
    const { pool, queries, release } = recordingPool();

    await explain(
      pool as never,
      'INSERT INTO t (a, b) VALUES ($1, $2)',
      2,
      false,
    );

    expect(queries).toStrictEqual([
      {
        text: 'EXPLAIN INSERT INTO t (a, b) VALUES ($1, $2)',
        values: [null, null],
      },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('releases the client even when the server refuses to plan', async () => {
    const denied = Object.assign(new Error('permission denied for table t'), {
      code: '42501',
    });
    const { pool, release } = recordingPool(denied);

    await expect(
      explain(pool as never, 'SELECT id FROM t', 0, true),
    ).rejects.toBe(denied);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('supportsGenericPlan', () => {
  // EXPLAIN (GENERIC_PLAN) was added in PostgreSQL 16.
  test.each([
    [150019, false],
    [159999, false],
    [160000, true],
    [180006, true],
  ])('server_version_num %i -> %s', (version, supported) => {
    expect(supportsGenericPlan(version)).toBe(supported);
  });

  test('reads server_version_num as a number', async () => {
    const pool = {
      query: async () => ({ rows: [{ server_version_num: '180006' }] }),
    };

    await expect(serverVersionNum(pool as never)).resolves.toBe(180006);
  });
});
