import type { DatabaseConnection, QueryConfig } from './connection.js';
import { parseSqlFile } from './parse-sql-file.js';
import { preparedStatementName } from './statement-name.js';
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

// `queryName` is the identifier a caller can actually key metrics, span names
// and slow-query logs on. Each of these is a case where `name` cannot serve:
// it is either absent, or it moves when the SQL does.
describe('queryName', () => {
  test('is the @name, alongside the statement name, when the query has both', () => {
    const query = new TypedQuery({
      ...irFor(SQL),
      name: 'FindBookById_abc12345',
    });
    expect(query.queryName).toBe('FindBookById');
    expect(query.name).toBe('FindBookById_abc12345');
  });

  test('is present with preparedStatements off, where name is undefined', () => {
    // What codegen emits with `preparedStatements: false`: an IR with no
    // `name` field at all. Before `queryName`, such a query carried no public
    // identifier whatsoever.
    const query = new TypedQuery(irFor(SQL));
    expect(query.name).toBeUndefined();
    expect(query.queryName).toBe('FindBookById');
  });

  test('is present for an array spread, which is never granted a name', () => {
    const spread = `
      /*
        @name FindBooksByIds
        @param ids -> (...)
      */
      SELECT * FROM books WHERE id IN :ids;
    `;
    const ir = irFor(spread);
    // Not merely omitted from this IR: the rule that withholds it is the
    // runtime's, so prepared statements being on changes nothing.
    expect(preparedStatementName(ir)).toBeUndefined();
    const query = new TypedQuery<{ ids: number[] }, unknown>(ir);
    expect(query.name).toBeUndefined();
    expect(query.queryName).toBe('FindBooksByIds');
  });

  test('survives an edit to the SQL that renames the statement', () => {
    // The reason a metrics dimension cannot be `name`: its hash suffix is
    // taken over the statement text, so any edit moves it.
    const before = irFor('/* @name GetAccounts */ SELECT id FROM accounts;');
    const after = irFor(
      '/* @name GetAccounts */ SELECT id, contact FROM accounts;',
    );
    const named = (ir: typeof before) =>
      new TypedQuery({ ...ir, name: preparedStatementName(ir) });
    expect(named(before).name).not.toBe(named(after).name);
    expect(named(before).queryName).toBe('GetAccounts');
    expect(named(after).queryName).toBe('GetAccounts');
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
    expect(NAMED().compile({ id: 1 }, { name: 'custom' })).toStrictEqual({
      name: 'custom',
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('an empty name option means unnamed, as node-postgres reads it', () => {
    expect(NAMED().compile({ id: 1 }, { name: '' })).toStrictEqual({
      text: 'SELECT $1',
      values: [1],
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

  // The conditional rest tuple is what replaced overloads and argument
  // sniffing, so its edges are asserted at the type level. `npm run check:test`
  // typechecks this file; each @ts-expect-error fails the build if the error
  // it claims stops happening.
  test('the argument tuple rejects the shapes it is meant to', () => {
    // Declared and never called: these assert what the compiler rejects, and
    // two of them would not throw at runtime. `npm run check:test` typechecks
    // this file, so each @ts-expect-error fails the build if the error it
    // claims stops happening.
    const typeAssertions = (): void => {
      const voidQuery = new TypedQuery<void, unknown>(VOID_IR());
      const paramsQuery = new TypedQuery<{ id: number }, unknown>(PARAMS_IR());
      // A query whose params are `never` cannot be called at all, because
      // QueryArgs<never> is never — the "codegen could not type it" case.
      const impossible = new TypedQuery<never, unknown>(VOID_IR());

      // @ts-expect-error a parameterless query takes no params argument
      voidQuery.compile({ id: 1 });
      // @ts-expect-error options alone cannot stand in for required params
      paramsQuery.compile({ prepared: false });
      // @ts-expect-error QueryArgs<never> is uncallable
      impossible.compile();
    };

    expect(typeof typeAssertions).toBe('function');
    expect(new TypedQuery<void, unknown>(VOID_IR()).compile()).toStrictEqual({
      text: 'SELECT 1',
      values: [],
    });
  });

  // Documents a known limit rather than desired behaviour: a params object
  // whose keys are all valid RunOptions keys cannot be distinguished from
  // options, so it is misread. Only reachable if the generated params type and
  // the generated IR disagree.
  test('still cannot detect a params object that looks exactly like options', () => {
    const wrong = new TypedQuery<{ name: string }, unknown>(VOID_IR());
    // Misread as options, but the value no longer reaches the driver: an
    // unnamed query stays unnamed whatever the options say.
    expect(
      (wrong.compile as (...a: unknown[]) => QueryConfig)({ name: 'Alice' }),
    ).toStrictEqual({ text: 'SELECT 1', values: [] });
  });

  test('a query codegen refused to name cannot be named by options', () => {
    // Codegen withholds a name from any query whose SQL varies per call. If
    // options could supply one, a second call with a longer array would bind
    // against the statement parsed for the first.
    const spread = irFor('/* @name Q @param ids -> (...) */ SELECT :ids');
    const q = new TypedQuery<{ ids: number[] }, unknown>(spread);
    expect(q.name).toBeUndefined();
    expect(q.compile({ ids: [1] }, { name: 'S' })).toStrictEqual({
      text: 'SELECT ($1)',
      values: [1],
    });
    expect(q.compile({ ids: [1, 2] }, { name: 'S' })).toStrictEqual({
      text: 'SELECT ($1,$2)',
      values: [1, 2],
    });
  });

  test('options.name still overrides a name codegen did grant', () => {
    expect(NAMED().compile({ id: 1 }, { name: 'Other' })).toStrictEqual({
      name: 'Other',
      text: 'SELECT $1',
      values: [1],
    });
  });

  test('rejects a non-object in the options slot', () => {
    const noParams = new TypedQuery<void, unknown>(VOID_IR());
    expect(() =>
      (noParams.compile as (...a: unknown[]) => unknown)('oops'),
    ).toThrow(/\(not an object\)/);
  });

  test('rejects null in the options slot, which is an object to typeof', () => {
    const noParams = new TypedQuery<void, unknown>(VOID_IR());
    expect(() =>
      (noParams.compile as (...a: unknown[]) => unknown)(null),
    ).toThrow(/\(not an object\)/);
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
