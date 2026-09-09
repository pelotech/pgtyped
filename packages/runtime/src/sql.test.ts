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

test('sql.named yields a TypedQuery carrying a canonical statement name', () => {
  const q = sql.named<{
    params: { id: number };
    result: { id: number };
  }>('GetOne')`SELECT * FROM books WHERE id = $id`;
  expect(q).toBeInstanceOf(TypedQuery);
  expect(q.name).toMatch(/^GetOne_[0-9a-f]{8}$/);
});

// Both call shapes must still infer from the single type argument, which is
// why `named` is a property on a function declaration rather than the result
// of an Object.assign. These annotations are the assertion; they fail at
// `tsc`, not at runtime.
test('both tag forms infer their params and result types', () => {
  const plain: TypedQuery<{ id: number }, { id: number }> = sql<{
    params: { id: number };
    result: { id: number };
  }>`SELECT * FROM books WHERE id = $id`;
  const named: TypedQuery<{ id: number }, { id: number }> = sql.named<{
    params: { id: number };
    result: { id: number };
  }>('GetOne')`SELECT * FROM books WHERE id = $id`;
  expect(plain.compile({ id: 1 }).values).toStrictEqual([1]);
  expect(named.compile({ id: 1 }).values).toStrictEqual([1]);
});
