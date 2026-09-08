import type { DatabaseConnection, QueryConfig } from './connection.js';
import { unprepared } from './connection.js';
import { parseSqlFile } from './parse-sql-file.js';
import { sql } from './sql.js';
import { TypedQuery } from './typed-query.js';

/**
 * Characterises which queries may carry a server-side prepared statement name,
 * and what a caller can and cannot do to change that.
 *
 * The rule exists because node-postgres caches parsed statements by name, per
 * connection. A name is therefore a promise that the SQL text under it never
 * changes. Codegen keeps that promise by withholding a name from any query
 * whose text varies per call — every query with an `array_spread` or
 * `pick_array_spread` param. Breaking the promise does not fail loudly at the
 * call that breaks it; it fails at the *next* call, inside the driver, with a
 * message naming neither the query nor the offending option.
 *
 * These tests are the specification for that rule. If one of them starts
 * failing, the question to ask is not "how do I make it pass" but "can a
 * caller now put text under a name that already means something else".
 */

const irFor = (sqlText: string) => {
  const { queries, errors } = parseSqlFile(sqlText);
  expect(errors).toStrictEqual([]);
  return queries[0];
};

/** A fixed-SQL query, the kind codegen is willing to name. */
const FIXED = () =>
  irFor('/* @name FindBookById */ SELECT * FROM books WHERE id = :id;');
const NAMED = () =>
  new TypedQuery<{ id: number }, unknown>({
    ...FIXED(),
    name: 'FindBookById_abc12345',
  });

/** `:ids` expands to one placeholder per element, so the text varies per call. */
const SPREAD = () =>
  new TypedQuery<{ ids: number[] }, unknown>(
    irFor(
      '/* @name FindBooksByIds @param ids -> (...) */ SELECT * FROM books WHERE id IN :ids;',
    ),
  );

/** `:books` expands to one tuple per element. Same problem, different shape. */
const PICK_SPREAD = () =>
  new TypedQuery<{ books: { name: string }[] }, unknown>(
    irFor(
      '/* @name InsertBooks @param books -> ((name)...) */ INSERT INTO books VALUES :books;',
    ),
  );

function recording() {
  const calls: QueryConfig[] = [];
  const connection: DatabaseConnection = {
    query: async (config) => (calls.push(config), { rows: [], rowCount: 0 }),
  };
  return { calls, connection };
}

describe('why a variable-arity query must never be named', () => {
  test('its SQL text changes with the length of the array', () => {
    const q = SPREAD();
    expect(q.compile({ ids: [1] }).text).toBe(
      'SELECT * FROM books WHERE id IN ($1)',
    );
    expect(q.compile({ ids: [1, 2, 3] }).text).toBe(
      'SELECT * FROM books WHERE id IN ($1,$2,$3)',
    );
  });

  test('so codegen gives it no name, and neither compile nor run invents one', async () => {
    const q = SPREAD();
    expect(q.name).toBeUndefined();
    expect(q.compile({ ids: [1] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1)',
      values: [1],
    });

    const { calls, connection } = recording();
    await q.run(connection, { ids: [1, 2] });
    expect(calls).toStrictEqual([
      { text: 'SELECT * FROM books WHERE id IN ($1,$2)', values: [1, 2] },
    ]);
  });

  test('the same holds for a pick-array-spread param', () => {
    const q = PICK_SPREAD();
    expect(q.name).toBeUndefined();
    expect(q.compile({ books: [{ name: 'a' }] }).text).toBe(
      'INSERT INTO books VALUES ($1)',
    );
    expect(q.compile({ books: [{ name: 'a' }, { name: 'b' }] }).text).toBe(
      'INSERT INTO books VALUES ($1),($2)',
    );
  });
});

describe('what options.name may and may not do', () => {
  // The guard: an override may rename a statement, never create one. Codegen
  // has already decided which queries are safe to name, and a caller reading
  // their own code cannot tell a spread query from a fixed one.
  test('it renames a query codegen already named', () => {
    expect(NAMED().compile({ id: 1 }, { name: 'Other' })).toStrictEqual({
      name: 'Other',
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('it cannot name a spread query, on either call length', () => {
    const q = SPREAD();
    expect(q.compile({ ids: [1] }, { name: 'S' })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1)',
      values: [1],
    });
    expect(q.compile({ ids: [1, 2] }, { name: 'S' })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1,$2)',
      values: [1, 2],
    });
  });

  test('it cannot name a pick-array-spread query either', () => {
    expect(
      PICK_SPREAD().compile({ books: [{ name: 'a' }] }, { name: 'S' }),
    ).toStrictEqual({
      text: 'INSERT INTO books VALUES ($1)',
      values: ['a'],
    });
  });

  test('it cannot name a query from a sql tag, which never gets a name', () => {
    const tagged = sql<{
      params: { id: number };
      result: unknown;
    }>`SELECT * FROM books WHERE id = $id`;
    expect(tagged.name).toBeUndefined();
    expect(tagged.compile({ id: 1 }, { name: 'T' })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('an empty name means unnamed, which is how node-postgres reads it too', () => {
    expect(NAMED().compile({ id: 1 }, { name: '' })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });
});

describe('interaction with prepared and unprepared()', () => {
  test('prepared: false drops a name the query legitimately has', () => {
    expect(NAMED().compile({ id: 1 }, { prepared: false })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('prepared: false beats an explicit name', () => {
    expect(
      NAMED().compile({ id: 1 }, { name: 'Other', prepared: false }),
    ).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('prepared: true is a no-op; it cannot name what codegen would not', () => {
    expect(SPREAD().compile({ ids: [1] }, { prepared: true })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1)',
      values: [1],
    });
  });

  test('unprepared() strips the name at the connection, whatever the options say', async () => {
    const { calls, connection } = recording();
    await NAMED().run(unprepared(connection), { id: 1 }, { name: 'Other' });
    expect(calls).toStrictEqual([
      { text: 'SELECT * FROM books WHERE id = $1', values: [1] },
    ]);
  });
});

describe('the residual hole, pinned so a change to it is deliberate', () => {
  // A params object whose keys all happen to be RunOptions keys is
  // indistinguishable from options. Only reachable when the generated params
  // type and the generated IR disagree.
  test('the misreading only happens on a query that declares no params', () => {
    // With params declared, the first argument is taken as params and never
    // reaches the options path, so nothing can leak into the name.
    const withParams = new TypedQuery<{ name: string }, unknown>(FIXED());
    expect(
      (withParams.compile as (...a: unknown[]) => QueryConfig)({
        name: 'Alice',
      }),
    ).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [undefined],
    });
  });

  test('a misread params object can still rename an already-named query', () => {
    // The one surviving path: parameterless, already named, and the generated
    // params type wrongly says it takes `{ name }`. `Alice` becomes the
    // statement name. Closing this needs the caller to stop lying about the
    // type, not more sniffing here.
    const wrong = new TypedQuery<{ name: string }, unknown>({
      ...irFor('/* @name CountBooks */ SELECT count(*) FROM books;'),
      name: 'CountBooks_abc12345',
    });
    expect(
      (wrong.compile as (...a: unknown[]) => QueryConfig)({ name: 'Alice' }),
    ).toStrictEqual({
      name: 'Alice',
      text: 'SELECT count(*) FROM books',
      values: [],
    });
  });

  test('but it can no longer put an arbitrary string on an unnamed query', () => {
    const wrong = new TypedQuery<{ name: string }, unknown>(
      irFor('/* @name CountBooks */ SELECT count(*) FROM books;'),
    );
    const config = (wrong.compile as (...a: unknown[]) => QueryConfig)({
      name: 'Alice',
    });
    expect(config.name).toBeUndefined();
    expect(config).toStrictEqual({
      text: 'SELECT count(*) FROM books',
      values: [],
    });
  });
});
