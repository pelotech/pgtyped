import type { DatabaseConnection, QueryConfig } from './connection.js';
import { unprepared } from './connection.js';
import { parseSqlFile } from './parse-sql-file.js';
import { parseTagged } from './parse-tagged.js';
import { render } from './render.js';
import { sql } from './sql.js';
import {
  derivedStatementName,
  preparedStatementName,
} from './statement-name.js';
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
 * Two front-ends can grant a name: codegen, for a `.sql` file, and
 * `sql.prepared`, for a tag that opts in. Both go through the same
 * `rendersFixedSQL` gate, so both withhold a name from a variable-arity query,
 * and neither uses a name bare — codegen and `sql.prepared('X')` append 8 hex
 * of the hash of the rendered SQL, and `sql.prepared()` derives the whole name
 * from 16 hex of it. A plain `sql` tag is never named at all.
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

describe('what the hash is taken over: the SQL, not the statement text', () => {
  // `ir.statement` is the body alone, `:u` references and all. The header that
  // decides what those references expand to is not in it, so hashing it puts
  // two queries that send different SQL under one name — and node-postgres
  // rejects the second with "Prepared statements must be unique". Hashing the
  // rendered SQL is what separates them.
  const insertWith = (keys: string) =>
    irFor(`/* @name InsertT @param u -> (${keys}) */ INSERT INTO t VALUES :u;`);

  test('two headers over one statement text get two names', () => {
    const two = insertWith('id, val');
    const one = insertWith('id');
    expect(two.statement).toBe(one.statement);
    expect(two.statement).toBe('INSERT INTO t VALUES :u');
    expect(render(two).query).toBe('INSERT INTO t VALUES ($1,$2)');
    expect(render(one).query).toBe('INSERT INTO t VALUES ($1)');
    expect(preparedStatementName(two)).not.toBe(preparedStatementName(one));
    expect(derivedStatementName(two)).not.toBe(derivedStatementName(one));
  });

  // The converse, and the reason this is a hash of the SQL rather than of the
  // IR: two queries that send the server the same text are the same statement,
  // whichever front-end wrote them, so they may share a name.
  test('two front-ends that render the same SQL agree on the name', () => {
    const fromFile = irFor(
      '/* @name GetUsers */ SELECT * FROM books WHERE id = :id;',
    );
    const fromTag = parseTagged(
      'SELECT * FROM books WHERE id = $id',
      'GetUsers',
    );
    expect(fromFile.statement).not.toBe(fromTag.statement);
    expect(render(fromFile).query).toBe(render(fromTag).query);
    expect(preparedStatementName(fromFile)).toBe(
      preparedStatementName(fromTag),
    );
    expect(derivedStatementName(fromFile)).toBe(derivedStatementName(fromTag));
  });

  // The invariant the whole scheme rests on. Hashing the codegen render — the
  // text sent to Describe — is only sound because for every query that may be
  // named, that is also the text sent on every call. `rendersFixedSQL` is what
  // guarantees it, by admitting only `scalar` and `pick_tuple`.
  test('a nameable query renders the same SQL at codegen time and at run time', () => {
    const scalar = FIXED();
    expect(render(scalar).query).toBe(render(scalar, { id: 1 }).query);
    const tuple = insertWith('id, val');
    expect(render(tuple).query).toBe(
      render(tuple, { u: { id: 1, val: 'x' } }).query,
    );
  });

  test('and a variable-arity one does not, which is why it may not be named', () => {
    const spread = irFor(
      '/* @name FindBooksByIds @param ids -> (...) */ SELECT * FROM books WHERE id IN :ids;',
    );
    expect(render(spread, { ids: [1, 2] }).query).not.toBe(
      render(spread).query,
    );
    expect(preparedStatementName(spread)).toBeUndefined();
    expect(derivedStatementName(spread)).toBeUndefined();

    const pickSpread = irFor(
      '/* @name InsertBooks @param books -> ((name)...) */ INSERT INTO books VALUES :books;',
    );
    expect(
      render(pickSpread, { books: [{ name: 'a' }, { name: 'b' }] }).query,
    ).not.toBe(render(pickSpread).query);
    expect(preparedStatementName(pickSpread)).toBeUndefined();
    expect(derivedStatementName(pickSpread)).toBeUndefined();
  });

  // Truncation gives on the prefix, never on the hash — including here, where
  // the hash is over text the query name cannot be read off.
  test('the 63-byte cap still holds, and still keeps the whole hash', () => {
    const long = { ...insertWith('id, val'), queryName: 'B'.repeat(80) };
    const name = preparedStatementName(long)!;
    expect(Buffer.byteLength(name, 'utf8')).toBe(63);
    expect(name).toMatch(/^B{54}_[0-9a-f]{8}$/);
    expect(name.slice(-8)).toBe(
      preparedStatementName(insertWith('id, val'))!.slice(-8),
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

  test('it cannot name a query from a plain sql tag, which never gets a name', () => {
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

describe('a sql.prepared tag with an explicit name', () => {
  // Pinned rather than merely self-consistent: the scheme is
  // `<name>_<first 8 hex of sha256 of the rendered SQL>`, and a change to it
  // renames every statement in every deployed application at once.
  const TEXT = 'SELECT * FROM books WHERE id = $id';
  const HASH = '022dda1d';

  const named = <P>(name: string) =>
    sql.prepared<{ params: P; result: unknown }>(name);

  test('its name is the given name plus a hash of the statement', () => {
    const q = named<{ id: number }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    expect(q.name).toMatch(/^GetUsers_[0-9a-f]{8}$/);
    expect(q.name).toBe(`GetUsers_${HASH}`);
    expect(preparedStatementName(parseTagged(TEXT, 'GetUsers'))).toBe(
      `GetUsers_${HASH}`,
    );
  });

  test('it sends that name, and the name is what reaches the connection', async () => {
    const q = named<{ id: number }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    expect(q.compile({ id: 1 })).toStrictEqual({
      name: `GetUsers_${HASH}`,
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });

    const { calls, connection } = recording();
    await q.run(connection, { id: 1 });
    expect(calls).toStrictEqual([
      {
        name: `GetUsers_${HASH}`,
        text: 'SELECT * FROM books WHERE id = $1',
        values: [1],
      },
    ]);
  });

  // The hash is the whole defence against a long-lived pooled connection
  // executing the statement it already prepared under this name: same text,
  // same name; edited text, different name.
  test('the same text names the same statement twice, an edit renames it', () => {
    const first = named<{ id: number }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    const second = named<{ id: number }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    const edited = named<{ id: number }>(
      'GetUsers',
    )`SELECT name FROM books WHERE id = $id`;
    expect(second.name).toBe(first.name);
    expect(edited.name).toBe('GetUsers_2fef6c9d');
    expect(edited.name).not.toBe(first.name);
  });

  // The load-bearing gate: `$$ids` renders one placeholder per element, so a
  // name would cover two different statement texts. Asking for one does not
  // get one. Removing the `rendersFixedSQL` check in statement-name.ts makes
  // exactly this test fail.
  test('an array-spread param stays unnamed even though a name was supplied', () => {
    const q = named<{ ids: number[] }>(
      'GetUsersByIds',
    )`SELECT * FROM books WHERE id IN $$ids`;
    expect(q.name).toBeUndefined();
    expect(q.compile({ ids: [1] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1)',
      values: [1],
    });
    expect(q.compile({ ids: [1, 2] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1,$2)',
      values: [1, 2],
    });
  });

  test('a pick-array-spread param stays unnamed too', () => {
    const q = named<{ books: { name: string }[] }>(
      'InsertBooks',
    )`INSERT INTO books VALUES $$books(name!)`;
    expect(q.name).toBeUndefined();
  });

  test('a plain sql tag is still unnamed', () => {
    expect(
      sql<{
        params: { id: number };
        result: unknown;
      }>`SELECT * FROM books WHERE id = $id`.name,
    ).toBeUndefined();
  });

  // A name that a .sql file could not have written is a programming error, and
  // it fails at module evaluation rather than reaching the server as something
  // strange.
  test.each([
    '',
    '1Bad',
    'has space',
    'has-dash',
    'drop"; SELECT 1 --',
    'Ünïcode',
  ])('rejects the invalid name %j, naming the value', (bad) => {
    expect(() => sql.prepared(bad)).toThrow(TypeError);
    expect(() => sql.prepared(bad)).toThrow(JSON.stringify(bad));
  });

  test('accepts the same shape a .sql @name accepts', () => {
    expect(
      sql.prepared<{ params: void; result: unknown }>('_Get_1')`SELECT 1 AS n`
        .name,
    ).toBe('_Get_1_4531145a');
  });

  test('prepared: false drops the name it opted into', () => {
    const q = named<{ id: number }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    expect(q.compile({ id: 1 }, { prepared: false })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('unprepared() strips it at the connection', async () => {
    const { calls, connection } = recording();
    const q = named<{ id: number }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    await q.run(unprepared(connection), { id: 1 });
    expect(calls).toStrictEqual([
      { text: 'SELECT * FROM books WHERE id = $1', values: [1] },
    ]);
  });

  // Postgres truncates identifiers at 63 bytes. Truncating a name that already
  // carries its hash would put two different statements under one name again,
  // so the prefix is what gives way.
  test('a long name is truncated to 63 bytes, keeping the whole hash', () => {
    const q = sql.prepared<{ params: { id: number }; result: unknown }>(
      'A'.repeat(80),
    )`SELECT * FROM books WHERE id = $id`;
    expect(Buffer.byteLength(q.name!, 'utf8')).toBe(63);
    expect(q.name).toBe(`${'A'.repeat(54)}_${HASH}`);
  });
});

// A `sql.prepared()` with no argument still gets a canonical name, derived from
// the statement text alone. It is the cheapest way to adopt prepared statements
// — nothing to name, nothing to keep in sync — and it pays for that with an
// identifier that tells you nothing when you meet it in pg_stat_statements.
describe('a sql.prepared tag with no name, which derives one', () => {
  // Pinned, like the named form: the scheme is
  // `pgtyped_<first 16 hex of sha256 of the rendered SQL>`, and changing it
  // renames every derived statement in every deployed application at once.
  const TEXT = 'SELECT * FROM books WHERE id = $id';
  const HASH16 = '022dda1d125f8341';

  const derived = <P>() => sql.prepared<{ params: P; result: unknown }>();

  test('its name is pgtyped_ plus sixteen hex digits of the statement hash', () => {
    const q = derived<{ id: number }>()`SELECT * FROM books WHERE id = $id`;
    expect(q.name).toMatch(/^pgtyped_[0-9a-f]{16}$/);
    expect(q.name).toBe(`pgtyped_${HASH16}`);
    expect(derivedStatementName(parseTagged(TEXT, 'anything at all'))).toBe(
      `pgtyped_${HASH16}`,
    );
  });

  // Sixteen and not eight, because here the hash is the *whole* identifier and
  // has to separate every query in the application. 32 bits collides at ~1.2%
  // across 10,000 queries and a collision runs the wrong SQL; 64 bits takes
  // that to ~3e-12. With a name the prefix already does the separating, so its
  // hash only has to tell successive edits of one query apart.
  test('the derived hash is twice the length of the named one, on the same text', () => {
    const named = sql.prepared<{ params: { id: number }; result: unknown }>(
      'GetUsers',
    )`SELECT * FROM books WHERE id = $id`;
    expect(named.name).toBe('GetUsers_022dda1d');
    expect(`pgtyped_${HASH16}`.startsWith('pgtyped_022dda1d')).toBe(true);
  });

  test('the derived name ignores the variable and the query name entirely', () => {
    expect(derivedStatementName(parseTagged(TEXT, 'GetUsers'))).toBe(
      derivedStatementName(parseTagged(TEXT, 'somethingCompletelyDifferent')),
    );
  });

  test('it sends that name, and the name is what reaches the connection', async () => {
    const q = derived<{ id: number }>()`SELECT * FROM books WHERE id = $id`;
    expect(q.compile({ id: 1 })).toStrictEqual({
      name: `pgtyped_${HASH16}`,
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });

    const { calls, connection } = recording();
    await q.run(connection, { id: 1 });
    expect(calls).toStrictEqual([
      {
        name: `pgtyped_${HASH16}`,
        text: 'SELECT * FROM books WHERE id = $1',
        values: [1],
      },
    ]);
  });

  // Same defence as the named form: same text, same name; edited text,
  // different name. Here it is the only defence, since there is no prefix.
  test('the same text names the same statement twice, an edit renames it', () => {
    const first = derived<{ id: number }>()`SELECT * FROM books WHERE id = $id`;
    const second = derived<{
      id: number;
    }>()`SELECT * FROM books WHERE id = $id`;
    const edited = derived<{
      id: number;
    }>()`SELECT name FROM books WHERE id = $id`;
    expect(second.name).toBe(first.name);
    expect(edited.name).toBe('pgtyped_2fef6c9def9bed2f');
    expect(edited.name).not.toBe(first.name);
  });

  // The load-bearing gate again. Withholding a name is not something the
  // *caller* asked for by naming the query, so it has to hold for the derived
  // form too — removing the `rendersFixedSQL` check in statement-name.ts makes
  // exactly this test fail.
  test('an array-spread param stays unnamed here too', () => {
    const q = derived<{
      ids: number[];
    }>()`SELECT * FROM books WHERE id IN $$ids`;
    expect(q.name).toBeUndefined();
    expect(q.compile({ ids: [1] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1)',
      values: [1],
    });
    expect(q.compile({ ids: [1, 2] })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id IN ($1,$2)',
      values: [1, 2],
    });
  });

  test('a pick-array-spread param stays unnamed too', () => {
    const q = derived<{
      books: { name: string }[];
    }>()`INSERT INTO books VALUES $$books(name!)`;
    expect(q.name).toBeUndefined();
  });

  test('prepared: false drops the derived name', () => {
    const q = derived<{ id: number }>()`SELECT * FROM books WHERE id = $id`;
    expect(q.compile({ id: 1 }, { prepared: false })).toStrictEqual({
      text: 'SELECT * FROM books WHERE id = $1',
      values: [1],
    });
  });

  test('unprepared() strips it at the connection', async () => {
    const { calls, connection } = recording();
    const q = derived<{ id: number }>()`SELECT * FROM books WHERE id = $id`;
    await q.run(unprepared(connection), { id: 1 });
    expect(calls).toStrictEqual([
      { text: 'SELECT * FROM books WHERE id = $1', values: [1] },
    ]);
  });

  // Nothing to truncate: the derived name is a fixed 24 bytes, well inside
  // Postgres' 63-byte identifier limit.
  test('it is always well short of the 63-byte identifier limit', () => {
    const q = derived<{ id: number }>()`SELECT * FROM books WHERE id = $id`;
    expect(q.name).toHaveLength(24);
  });
});
