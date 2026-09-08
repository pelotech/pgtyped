import {
  unprepared,
  type DatabaseConnection,
  type QueryConfig,
} from './connection.js';

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

describe('unprepared', () => {
  test('strips the statement name so the query is sent unnamed', async () => {
    const { calls, connection } = recording();
    await unprepared(connection).query({
      name: 'FindBookById_abc12345',
      text: 'SELECT 1',
      values: [],
    });
    expect(calls).toStrictEqual([{ text: 'SELECT 1', values: [] }]);
    expect(calls[0]).not.toHaveProperty('name');
  });

  test('passes an already-unnamed query through unchanged', async () => {
    const { calls, connection } = recording();
    await unprepared(connection).query({ text: 'SELECT 1', values: [1] });
    expect(calls).toStrictEqual([{ text: 'SELECT 1', values: [1] }]);
  });

  test("does not mutate the caller's config object", async () => {
    const { connection } = recording();
    const config: QueryConfig = { name: 'Q_1', text: 'SELECT 1', values: [] };
    await unprepared(connection).query(config);
    expect(config).toStrictEqual({ name: 'Q_1', text: 'SELECT 1', values: [] });
  });

  test('returns the underlying result', async () => {
    const result = { rows: [{ a: 1 }], rowCount: 1 };
    const connection: DatabaseConnection = {
      query: async () => result,
    };
    await expect(
      unprepared(connection).query({ text: 'x', values: [] }),
    ).resolves.toBe(result);
  });
});
