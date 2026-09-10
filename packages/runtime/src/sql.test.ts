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

test('sql.prepared yields a TypedQuery carrying a canonical statement name', () => {
  const q = sql.prepared<{
    params: { id: number };
    result: { id: number };
  }>('GetOne')`SELECT * FROM books WHERE id = $id`;
  expect(q).toBeInstanceOf(TypedQuery);
  expect(q.name).toMatch(/^GetOne_[0-9a-f]{8}$/);
});

test('sql.prepared with no name derives one from the statement', () => {
  const q = sql.prepared<{
    params: { id: number };
    result: { id: number };
  }>()`SELECT * FROM books WHERE id = $id`;
  expect(q).toBeInstanceOf(TypedQuery);
  expect(q.name).toMatch(/^pgtyped_[0-9a-f]{16}$/);
});

test('sql.prepared carries its name as queryName, unhashed', () => {
  const q = sql.prepared<{
    params: { id: number };
    result: { id: number };
  }>('GetOne')`SELECT * FROM books WHERE id = $id`;
  expect(q.queryName).toBe('GetOne');
  expect(q.name).toMatch(/^GetOne_[0-9a-f]{8}$/);
});

// A spread tag is granted no statement name, so `queryName` is the only
// identifier it has — the case `sql.prepared` and codegen share.
test('a spread tag keeps its queryName despite carrying no statement name', () => {
  const q = sql.prepared<{
    params: { ids: number[] };
    result: { id: number };
  }>('GetMany')`SELECT * FROM books WHERE id IN $$ids`;
  expect(q.name).toBeUndefined();
  expect(q.queryName).toBe('GetMany');
});

// Documents a limit rather than desired behaviour. A tag has no name at
// runtime unless one is passed to `sql.prepared`: codegen reads the variable a
// tag is assigned to, but that happens at generation time and never reaches
// the emitted query. Anyone keying metrics off a tag should name it.
test('an unnamed tag falls back to the placeholder queryName', () => {
  const plain = sql<{
    params: { id: number };
    result: { id: number };
  }>`SELECT * FROM books WHERE id = $id`;
  const derived = sql.prepared<{
    params: { id: number };
    result: { id: number };
  }>()`SELECT * FROM books WHERE id = $id`;
  expect(plain.queryName).toBe('query');
  expect(derived.queryName).toBe('query');
});

// Both call shapes must still infer from the single type argument, which is
// why `prepared` is a property on a function declaration rather than the result
// of an Object.assign. These annotations are the assertion; they fail at
// `tsc`, not at runtime.
test('both tag forms infer their params and result types', () => {
  const plain: TypedQuery<{ id: number }, { id: number }> = sql<{
    params: { id: number };
    result: { id: number };
  }>`SELECT * FROM books WHERE id = $id`;
  const named: TypedQuery<{ id: number }, { id: number }> = sql.prepared<{
    params: { id: number };
    result: { id: number };
  }>('GetOne')`SELECT * FROM books WHERE id = $id`;
  const derived: TypedQuery<{ id: number }, { id: number }> = sql.prepared<{
    params: { id: number };
    result: { id: number };
  }>()`SELECT * FROM books WHERE id = $id`;
  expect(plain.compile({ id: 1 }).values).toStrictEqual([1]);
  expect(named.compile({ id: 1 }).values).toStrictEqual([1]);
  expect(derived.compile({ id: 1 }).values).toStrictEqual([1]);
});
