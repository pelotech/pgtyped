import type { DatabaseConnection, QueryConfig } from './connection.js';
import { Query } from './query.js';

/** Minimal concrete Query: fixed text, params become values in key order. */
class FixedQuery<TParams, TResult> extends Query<TParams, TResult> {
  constructor(
    private readonly text: string,
    readonly name: string | undefined,
    protected readonly hasParams: boolean,
  ) {
    super();
  }
  protected interpolate(params: TParams) {
    const values = params ? Object.values(params as object) : [];
    return { text: this.text, values };
  }
}

function recording(rows: unknown[] = []) {
  const calls: QueryConfig[] = [];
  const connection: DatabaseConnection = {
    query: async (config) => {
      calls.push(config);
      return { rows, rowCount: rows.length };
    },
  };
  return { calls, connection };
}

const NAMED = () =>
  new FixedQuery<{ id: number }, { id: number }>(
    'SELECT $1',
    'Q_abc12345',
    true,
  );
const UNNAMED = () =>
  new FixedQuery<{ id: number }, { id: number }>('SELECT $1', undefined, true);

describe('compile', () => {
  test('includes the canonical name when the query has one', () => {
    expect(NAMED().compile({ id: 1 })).toEqual({
      name: 'Q_abc12345',
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('omits name when the query has none', () => {
    expect(UNNAMED().compile({ id: 1 })).toEqual({
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('prepared: false drops the name', () => {
    expect(NAMED().compile({ id: 1 }, { prepared: false })).toEqual({
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('name option overrides the canonical name', () => {
    expect(NAMED().compile({ id: 1 }, { name: 'custom' })).toMatchObject({
      name: 'custom',
    });
  });

  // The two RunOptions precedence rules its doc comment promises.
  test('prepared: false beats an explicitly passed name', () => {
    expect(
      NAMED().compile({ id: 1 }, { prepared: false, name: 'custom' }),
    ).toStrictEqual({ text: 'SELECT $1', values: [1] });
  });

  test('prepared: true never invents a name for an unnamed query', () => {
    expect(UNNAMED().compile({ id: 1 }, { prepared: true })).toStrictEqual({
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('a query with params rejects a call without them at the type level', () => {
    // @ts-expect-error params are required when the query declares them
    NAMED().compile();
  });
});

describe('execute', () => {
  test('sends the compiled QueryConfig and returns rows with rowCount', async () => {
    const { calls, connection } = recording([{ id: 7 }]);
    const result = await NAMED().execute(connection, { id: 7 });
    expect(calls).toEqual([
      { name: 'Q_abc12345', text: 'SELECT $1', values: [7] },
    ]);
    expect(result).toEqual({ rows: [{ id: 7 }], rowCount: 1 });
  });

  test('strips column hint suffixes from rows', async () => {
    const { connection } = recording([{ 'total!': 3, 'maybe?': null }]);
    const { rows } = await NAMED().execute(connection, { id: 1 });
    expect(rows).toEqual([{ total: 3, maybe: null }]);
  });
});

describe('run', () => {
  test('returns just the rows', async () => {
    const { connection } = recording([{ id: 1 }, { id: 2 }]);
    await expect(NAMED().run(connection, { id: 1 })).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  test('forwards options after params', async () => {
    const { calls, connection } = recording();
    await NAMED().run(connection, { id: 1 }, { prepared: false });
    expect(calls[0]).toEqual({ text: 'SELECT $1', values: [1] });
  });
});

describe('parameterless queries', () => {
  const noParams = () =>
    new FixedQuery<void, { n: number }>('SELECT 1', 'NoParams_1', false);

  test('run(connection) takes no params argument', async () => {
    const { calls, connection } = recording([{ n: 1 }]);
    await expect(noParams().run(connection)).resolves.toEqual([{ n: 1 }]);
    expect(calls[0]).toEqual({
      name: 'NoParams_1',
      text: 'SELECT 1',
      values: [],
    });
  });

  test('run(connection, options) reads the second argument as options', async () => {
    const { calls, connection } = recording();
    await noParams().run(connection, { prepared: false });
    expect(calls[0]).toEqual({ text: 'SELECT 1', values: [] });
  });

  test('execute(connection) takes no params argument', async () => {
    const { connection } = recording([{ n: 1 }]);
    await expect(noParams().execute(connection)).resolves.toEqual({
      rows: [{ n: 1 }],
      rowCount: 1,
    });
  });

  test('compile() takes no params argument', () => {
    expect(noParams().compile()).toEqual({
      name: 'NoParams_1',
      text: 'SELECT 1',
      values: [],
    });
  });
});
