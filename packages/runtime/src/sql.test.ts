import type { DatabaseConnection, QueryConfig } from './connection.js';
import { sql } from './sql.js';
import { TypedQuery } from './typed-query.js';

test('sql tag yields an unnamed TypedQuery', () => {
  const q = sql<{
    params: { id: number };
    result: { id: number };
  }>`SELECT * FROM books WHERE id = $id`;
  expect(q).toBeInstanceOf(TypedQuery);
  expect(q.name).toBeUndefined();
  expect(q.compile({ id: 3 })).toStrictEqual({
    text: 'SELECT * FROM books WHERE id = $1',
    values: [3],
  });
});

test('a tag with no params is called with just the connection', async () => {
  const calls: QueryConfig[] = [];
  const connection: DatabaseConnection = {
    query: async (c) => (calls.push(c), { rows: [], rowCount: 0 }),
  };
  await sql<{ params: void; result: { n: number } }>`SELECT 1 AS n`.run(
    connection,
  );
  expect(calls).toStrictEqual([{ text: 'SELECT 1 AS n', values: [] }]);
});
