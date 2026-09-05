import {
  parseSQLFile,
  queryASTToIR,
  SQLQueryIR,
} from '@pelotech/pgtyped-parser';
import { IDatabaseConnection, PreparedQuery } from './tag.js';

function irFor(sql: string, name?: string): SQLQueryIR {
  const ir = queryASTToIR(parseSQLFile(sql).queries[0]);
  return name ? { ...ir, name } : ir;
}

const SCALAR_SQL = `
  /* @name FindBookById */
  SELECT * FROM books WHERE id = :id;
`;

/** Records exactly what the query was handed, without touching a database. */
function recordingConnection(rows: any[] = []) {
  const calls: any[][] = [];
  const connection = {
    query: async (...args: any[]) => {
      calls.push(args);
      return { rows, rowCount: rows.length };
    },
  } as unknown as IDatabaseConnection;
  return { calls, connection };
}

describe('PreparedQuery statement naming', () => {
  // The historical call shape. Queries without a name must keep using it, so
  // that turning the feature off is indistinguishable from never having it.
  test('sends an unnamed query as (text, values)', async () => {
    const { calls, connection } = recordingConnection();
    await new PreparedQuery(irFor(SCALAR_SQL)).run({ id: 1 }, connection);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['SELECT * FROM books WHERE id = $1', [1]]);
  });

  // node-postgres only prepares server-side when it receives a `name`, and the
  // only pg-native way to pass one is a QueryConfig as the first argument.
  test('sends a named query as a single QueryConfig argument', async () => {
    const { calls, connection } = recordingConnection();
    await new PreparedQuery(irFor(SCALAR_SQL, 'FindBookById_abc12345')).run(
      { id: 1 },
      connection,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      {
        name: 'FindBookById_abc12345',
        text: 'SELECT * FROM books WHERE id = $1',
        values: [1],
      },
    ]);
  });

  test('names runWithCounts queries too', async () => {
    const { calls, connection } = recordingConnection([{ id: 1 }]);
    const result = await new PreparedQuery(
      irFor(SCALAR_SQL, 'FindBookById_abc12345'),
    ).runWithCounts({ id: 1 }, connection);

    expect(calls[0][0]).toMatchObject({ name: 'FindBookById_abc12345' });
    expect(result.rowCount).toEqual(1);
  });

  // Named statements are unsafe under PgBouncer in transaction-pooling mode,
  // so a caller must be able to opt out without regenerating.
  test('sends unnamed when the caller passes name: false', async () => {
    const { calls, connection } = recordingConnection();
    await new PreparedQuery(irFor(SCALAR_SQL, 'FindBookById_abc12345')).run(
      { id: 1 },
      connection,
      { name: false },
    );

    expect(calls[0]).toEqual(['SELECT * FROM books WHERE id = $1', [1]]);
  });

  test('lets the caller override the canonical name', async () => {
    const { calls, connection } = recordingConnection();
    await new PreparedQuery(irFor(SCALAR_SQL, 'FindBookById_abc12345')).run(
      { id: 1 },
      connection,
      { name: 'custom_name' },
    );

    expect(calls[0][0]).toMatchObject({ name: 'custom_name' });
  });

  test('still strips column hint suffixes from named query results', async () => {
    const { connection } = recordingConnection([{ 'total!': 3 }]);
    const rows = await new PreparedQuery(
      irFor(SCALAR_SQL, 'FindBookById_abc12345'),
    ).run({ id: 1 }, connection);

    expect(rows).toEqual([{ total: 3 }]);
  });

  // Streaming goes through pg-cursor, whose prepared-statement semantics
  // differ, so it stays on the unnamed path for now.
  test('leaves streaming queries unnamed', () => {
    const streamCalls: any[][] = [];
    const connection = {
      query: async () => ({ rows: [], rowCount: 0 }),
      stream: (...args: any[]) => {
        streamCalls.push(args);
        return { read: async () => [], close: async () => undefined };
      },
    } as unknown as IDatabaseConnection;

    new PreparedQuery(irFor(SCALAR_SQL, 'FindBookById_abc12345')).stream(
      { id: 1 },
      connection,
    );

    expect(streamCalls[0]).toEqual(['SELECT * FROM books WHERE id = $1', [1]]);
  });
});
