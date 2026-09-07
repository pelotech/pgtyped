import {
  parseSQLFile,
  queryASTToIR,
  type SQLQueryIR,
} from '@pelotech/pgtyped-parser';
import type { DatabaseConnection, QueryConfig } from './connection.js';
import { TypedQuery } from './typed-query.js';

function irFor(sql: string, name?: string): SQLQueryIR {
  const ir = queryASTToIR(parseSQLFile(sql).queries[0]);
  return name ? { ...ir, name } : ir;
}

const SQL = `
  /* @name FindBookById */
  SELECT * FROM books WHERE id = :id;
`;
const NO_PARAMS_SQL = `
  /* @name CountBooks */
  SELECT count(*) FROM books;
`;

function recording() {
  const calls: QueryConfig[] = [];
  const connection: DatabaseConnection = {
    query: async (config) => {
      calls.push(config);
      return { rows: [], rowCount: 0 };
    },
  };
  return { calls, connection };
}

describe('TypedQuery', () => {
  test('exposes the canonical name from the IR', () => {
    expect(new TypedQuery(irFor(SQL, 'FindBookById_abc12345')).name).toBe(
      'FindBookById_abc12345',
    );
    expect(new TypedQuery(irFor(SQL)).name).toBeUndefined();
  });

  test('interpolates named params into positional placeholders', () => {
    expect(
      new TypedQuery(irFor(SQL, 'FindBookById_abc12345')).compile({ id: 1 }),
    ).toStrictEqual({
      name: 'FindBookById_abc12345',
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('sends a named query as a single QueryConfig, connection first', async () => {
    const { calls, connection } = recording();
    await new TypedQuery(irFor(SQL, 'FindBookById_abc12345')).run(connection, {
      id: 1,
    });
    expect(calls).toStrictEqual([
      {
        name: 'FindBookById_abc12345',
        text: 'SELECT * FROM books WHERE id = $1',
        values: [1],
      },
    ]);
  });

  test('a query with no used params is called with just the connection', async () => {
    const { calls, connection } = recording();
    await new TypedQuery<void, unknown>(
      irFor(NO_PARAMS_SQL, 'CountBooks_1'),
    ).run(connection);
    expect(calls).toStrictEqual([
      { name: 'CountBooks_1', text: 'SELECT count(*) FROM books', values: [] },
    ]);
  });

  test('a declared but unreferenced param does not count as a param', async () => {
    const { calls, connection } = recording();
    const declaredNotUsed = `
      /*
        @name CountBooksUnused
        @param ids -> (...)
      */
      SELECT count(*) FROM books;
    `;
    await new TypedQuery<void, unknown>(
      irFor(declaredNotUsed, 'CountBooksUnused_1'),
    ).run(connection);
    expect(calls).toStrictEqual([
      {
        name: 'CountBooksUnused_1',
        text: 'SELECT count(*) FROM books',
        values: [],
      },
    ]);
  });
});
