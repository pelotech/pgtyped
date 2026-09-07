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
    expect(calls).toEqual([{ text: 'SELECT 1', values: [] }]);
  });

  test('passes an already-unnamed query through unchanged', async () => {
    const { calls, connection } = recording();
    await unprepared(connection).query({ text: 'SELECT 1', values: [1] });
    expect(calls).toEqual([{ text: 'SELECT 1', values: [1] }]);
  });

  test('returns the underlying result', async () => {
    const connection: DatabaseConnection = {
      query: async () => ({ rows: [{ a: 1 }], rowCount: 1 }),
    };
    await expect(
      unprepared(connection).query({ text: 'x', values: [] }),
    ).resolves.toEqual({
      rows: [{ a: 1 }],
      rowCount: 1,
    });
  });
});
