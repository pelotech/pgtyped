import type { DatabaseConnection, QueryConfig } from './connection.js';
import { parseSqlFile } from './parse-sql-file.js';
import { TypedQuery } from './typed-query.js';

const irFor = (sql: string) => {
  const { queries, errors } = parseSqlFile(sql);
  expect(errors).toStrictEqual([]);
  return queries[0];
};

const SQL = `
  /* @name FindBookById */
  SELECT * FROM books WHERE id = :id;
`;
const NO_PARAMS_SQL = `
  /* @name CountBooks */
  SELECT count(*) FROM books;
`;

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

describe('TypedQuery', () => {
  test('exposes the canonical name from the IR', () => {
    expect(
      new TypedQuery({ ...irFor(SQL), name: 'FindBookById_abc12345' }).name,
    ).toBe('FindBookById_abc12345');
    expect(new TypedQuery(irFor(SQL)).name).toBeUndefined();
  });

  test('interpolates named params into positional placeholders', () => {
    expect(
      new TypedQuery({
        ...irFor(SQL),
        name: 'FindBookById_abc12345',
      }).compile({ id: 1 }),
    ).toStrictEqual({
      name: 'FindBookById_abc12345',
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('sends a named query as a single QueryConfig, connection first', async () => {
    const { calls, connection } = recording();
    await new TypedQuery({
      ...irFor(SQL),
      name: 'FindBookById_abc12345',
    }).run(connection, {
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
    await new TypedQuery<void, unknown>({
      ...irFor(NO_PARAMS_SQL),
      name: 'CountBooks_1a2b3c4d',
    }).run(connection);
    expect(calls).toStrictEqual([
      {
        name: 'CountBooks_1a2b3c4d',
        text: 'SELECT count(*) FROM books',
        values: [],
      },
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
    const { queries, warnings, errors } = parseSqlFile(declaredNotUsed);
    expect(errors).toStrictEqual([]);
    // The unused param is dropped from the IR entirely and reported instead.
    expect(queries[0].params).toStrictEqual([]);
    expect(warnings.map((w) => w.message)).toStrictEqual([
      expect.stringContaining('ids'),
    ]);
    const ir = { ...queries[0], name: 'CountBooksUnused_5e6f7a8b' };
    await new TypedQuery<void, unknown>(ir).run(connection);
    expect(calls).toStrictEqual([
      {
        name: 'CountBooksUnused_5e6f7a8b',
        text: 'SELECT count(*) FROM books',
        values: [],
      },
    ]);
  });

  test('re-renders a variable-arity query per call', () => {
    const spread = `
      /*
        @name FindBooksByIds
        @param ids -> (...)
      */
      SELECT * FROM books WHERE id IN :ids;
    `;
    // Codegen leaves array-spread queries unnamed precisely because the text
    // varies per call; compiling the same instance twice must reflect that.
    const query = new TypedQuery<{ ids: number[] }, unknown>(irFor(spread));
    expect(query.name).toBeUndefined();
    expect(query.compile({ ids: [1, 2] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1,$2)',
      values: [1, 2],
    });
    expect(query.compile({ ids: [1, 2, 3] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1,$2,$3)',
      values: [1, 2, 3],
    });
  });
});

const PARAMS_IR = () => irFor('/* @name Q */ SELECT :id');
const VOID_IR = () => irFor('/* @name Q */ SELECT 1');

const NAMED = () =>
  new TypedQuery<{ id: number }, { id: number }>({
    ...PARAMS_IR(),
    name: 'Q_abc12345',
  });
const UNNAMED = () =>
  new TypedQuery<{ id: number }, { id: number }>(PARAMS_IR());

describe('compile', () => {
  test('includes the canonical name when the query has one', () => {
    expect(NAMED().compile({ id: 1 })).toStrictEqual({
      name: 'Q_abc12345',
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('omits name when the query has none', () => {
    expect(UNNAMED().compile({ id: 1 })).toStrictEqual({
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('prepared: false drops the name', () => {
    expect(NAMED().compile({ id: 1 }, { prepared: false })).toStrictEqual({
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
    expect(() =>
      // @ts-expect-error params are required when the query declares them
      NAMED().compile(),
    ).toThrow(/requires parameters/);
  });

  // Documents a known limit rather than desired behaviour: a params object
  // whose keys are all valid RunOptions keys cannot be distinguished from
  // options, so it is misread. Only reachable if hasParams is wrong.
  test('cannot detect a params object that looks exactly like options', () => {
    const wrong = new TypedQuery<{ name: string }, unknown>(VOID_IR());
    expect(
      (wrong.compile as (...a: unknown[]) => QueryConfig)({ name: 'Alice' }),
    ).toStrictEqual({ name: 'Alice', text: 'SELECT 1', values: [] });
  });

  test('rejects a params object when the query declares none', () => {
    const noParams = new TypedQuery<void, unknown>(VOID_IR());
    expect(() =>
      (noParams.compile as (...a: unknown[]) => unknown)({ id: 1 }),
    ).toThrow(/declares no parameters/);
  });
});

describe('execute', () => {
  test('sends the compiled QueryConfig and returns rows with rowCount', async () => {
    const { calls, connection } = recording([{ id: 7 }]);
    const result = await NAMED().execute(connection, { id: 7 });
    expect(calls).toStrictEqual([
      { name: 'Q_abc12345', text: 'SELECT $1', values: [7] },
    ]);
    expect(result).toStrictEqual({ rows: [{ id: 7 }], rowCount: 1 });
  });

  test('passes the driver rowCount through, including null', async () => {
    const connection: DatabaseConnection = {
      query: async () => ({ rows: [], rowCount: null }),
    };
    await expect(NAMED().execute(connection, { id: 1 })).resolves.toStrictEqual(
      {
        rows: [],
        rowCount: null,
      },
    );
  });
});

describe('run', () => {
  test('returns just the rows', async () => {
    const { connection } = recording([{ id: 1 }, { id: 2 }]);
    await expect(NAMED().run(connection, { id: 1 })).resolves.toStrictEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  test('forwards options after params', async () => {
    const { calls, connection } = recording();
    await NAMED().run(connection, { id: 1 }, { prepared: false });
    expect(calls[0]).toStrictEqual({ text: 'SELECT $1', values: [1] });
  });
});

describe('parameterless queries', () => {
  const noParams = () =>
    new TypedQuery<void, { n: number }>({ ...VOID_IR(), name: 'NoParams_1' });

  test('run(connection) takes no params argument', async () => {
    const { calls, connection } = recording([{ n: 1 }]);
    await expect(noParams().run(connection)).resolves.toStrictEqual([{ n: 1 }]);
    expect(calls[0]).toStrictEqual({
      name: 'NoParams_1',
      text: 'SELECT 1',
      values: [],
    });
  });

  test('run(connection, options) reads the second argument as options', async () => {
    const { calls, connection } = recording();
    await noParams().run(connection, { prepared: false });
    expect(calls[0]).toStrictEqual({ text: 'SELECT 1', values: [] });
  });

  test('execute(connection) takes no params argument', async () => {
    const { connection } = recording([{ n: 1 }]);
    await expect(noParams().execute(connection)).resolves.toStrictEqual({
      rows: [{ n: 1 }],
      rowCount: 1,
    });
  });

  test('compile() takes no params argument', () => {
    expect(noParams().compile()).toStrictEqual({
      name: 'NoParams_1',
      text: 'SELECT 1',
      values: [],
    });
  });
});
