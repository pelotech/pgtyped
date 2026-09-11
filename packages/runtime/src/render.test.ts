import { parseSqlFile } from './parse-sql-file.js';
import { parseTagged } from './parse-tagged.js';
import { ParameterTransform, render } from './render.js';

test('(SQL) no params', () => {
  const query = `
  /* @name selectSomeUsers */
  SELECT id, name FROM users;`;

  const parameters = {};

  const expectedResult = {
    query: 'SELECT id, name FROM users',
    mapping: [],
    bindings: [],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedResult);
  expect(mappingResult).toStrictEqual(expectedResult);
});

test('(SQL) two scalar params, one forced as non-null', () => {
  const query = `
  /*
    @name UpdateBooksRankNotNull
  */
  UPDATE books
  SET
      rank = :rank!,
      name = :name
  WHERE id = :id!;`;

  const parameters = {
    rank: 123,
    name: 'name',
    id: 'id',
  };

  const expectedInterpolationResult = {
    query:
      'UPDATE books\n  SET\n      rank = $1,\n      name = $2\n  WHERE id = $3',
    mapping: [],
    bindings: [123, 'name', 'id'],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
});

test('(SQL) two scalar params', () => {
  const query = `
  /* @name selectSomeUsers */
  SELECT id, name from users where id = :id and age > :age;`;

  const parameters = {
    id: '123',
    age: 12,
  };

  const expectedInterpolationResult = {
    query: 'SELECT id, name from users where id = $1 and age > $2',
    mapping: [],
    bindings: ['123', 12],
  };

  const expectedMappingResult = {
    query: 'SELECT id, name from users where id = $1 and age > $2',
    mapping: [
      {
        assignedIndex: 1,
        name: 'id',
        required: false,
        type: ParameterTransform.Scalar,
      },
      {
        assignedIndex: 2,
        name: 'age',
        required: false,
        type: ParameterTransform.Scalar,
      },
    ],
    bindings: [],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) one param used twice', () => {
  const query = `
  /* @name selectUsersAndParents */
  SELECT id, name from users where id = :id or parent_id = :id;`;

  const parameters = {
    id: '123',
  };

  const expectedInterpolationResult = {
    query: 'SELECT id, name from users where id = $1 or parent_id = $1',
    mapping: [],
    bindings: ['123'],
  };

  const expectedMappingResult = {
    query: 'SELECT id, name from users where id = $1 or parent_id = $1',
    mapping: [
      {
        assignedIndex: 1,
        name: 'id',
        required: false,
        type: ParameterTransform.Scalar,
      },
    ],
    bindings: [],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) array param', () => {
  const query = `
  /*
    @name selectSomeUsers
    @param ages -> (...)
  */
  SELECT FROM users WHERE age in :ages;`;

  const parameters = {
    ages: [23, 27, 50],
  };

  const expectedInterpolationResult = {
    query: 'SELECT FROM users WHERE age in ($1,$2,$3)',
    bindings: [23, 27, 50],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'SELECT FROM users WHERE age in ($1)',
    bindings: [],
    mapping: [
      {
        name: 'ages',
        type: ParameterTransform.Spread,
        required: false,
        assignedIndex: 1,
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) array param used twice', () => {
  const query = `
  /*
    @name selectSomeUsers
    @param ages -> (...)
  */
  SELECT FROM users WHERE age in :ages or age in :ages;`;

  const parameters = {
    ages: [23, 27, 50],
  };

  const expectedInterpolationResult = {
    query: 'SELECT FROM users WHERE age in ($1,$2,$3) or age in ($1,$2,$3)',
    bindings: [23, 27, 50],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'SELECT FROM users WHERE age in ($1) or age in ($1)',
    bindings: [],
    mapping: [
      {
        name: 'ages',
        required: false,
        type: ParameterTransform.Spread,
        assignedIndex: 1,
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) array and scalar param', () => {
  const query = `
  /*
    @name selectSomeUsers
    @param ages -> (...)
  */
  SELECT FROM users WHERE age in :ages and id = :userId;`;

  const parameters = {
    ages: [23, 27, 50],
    userId: 'some-id',
  };

  const expectedInterpolationResult = {
    query: 'SELECT FROM users WHERE age in ($1,$2,$3) and id = $4',
    bindings: [23, 27, 50, 'some-id'],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'SELECT FROM users WHERE age in ($1) and id = $2',
    bindings: [],
    mapping: [
      {
        name: 'ages',
        type: ParameterTransform.Spread,
        required: false,
        assignedIndex: 1,
      },
      {
        name: 'userId',
        type: ParameterTransform.Scalar,
        required: false,
        assignedIndex: 2,
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) pick param', () => {
  const query = `
  /*
    @name insertUsers
    @param user -> (name, age)
  */
  INSERT INTO users (name, age) VALUES :user RETURNING id;`;

  const parameters = {
    user: { name: 'Bob', age: 12 },
  };

  const expectedInterpolationResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    bindings: ['Bob', 12],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    bindings: [],
    mapping: [
      {
        name: 'user',
        type: ParameterTransform.Pick,
        dict: {
          name: {
            assignedIndex: 1,
            name: 'name',
            type: ParameterTransform.Scalar,
            required: false,
          },
          age: {
            assignedIndex: 2,
            name: 'age',
            type: ParameterTransform.Scalar,
            required: false,
          },
        },
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);

  const mappingResult = render(queryIR);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) pick param used twice', () => {
  const query = `
  /*
    @name insertUsersTwice
    @param user -> (name, age)
  */
  INSERT INTO users (name, age) VALUES :user, :user RETURNING id;`;

  const parameters = {
    user: { name: 'Bob', age: 12 },
  };

  const expectedInterpolationResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2), ($1,$2) RETURNING id',
    bindings: ['Bob', 12],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2), ($1,$2) RETURNING id',
    bindings: [],
    mapping: [
      {
        name: 'user',
        type: ParameterTransform.Pick,
        dict: {
          name: {
            assignedIndex: 1,
            name: 'name',
            type: ParameterTransform.Scalar,
            required: false,
          },
          age: {
            assignedIndex: 2,
            name: 'age',
            type: ParameterTransform.Scalar,
            required: false,
          },
        },
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);

  const mappingResult = render(queryIR);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) pickSpread param', () => {
  const query = `
  /*
    @name insertUsers
    @param users -> ((name, age)...)
  */
  INSERT INTO users (name, age) VALUES :users RETURNING id;`;

  const parameters = {
    users: [
      { name: 'Bob', age: 12 },
      { name: 'Tom', age: 22 },
    ],
  };

  const expectedInterpolationResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2),($3,$4) RETURNING id',
    bindings: ['Bob', 12, 'Tom', 22],
    mapping: [],
  };

  const expectedMapping = [
    {
      name: 'users',
      type: ParameterTransform.PickSpread,
      dict: {
        name: {
          name: 'name',
          type: ParameterTransform.Scalar,
          required: false,
          assignedIndex: 1,
        },
        age: {
          name: 'age',
          type: ParameterTransform.Scalar,
          required: false,
          assignedIndex: 2,
        },
      },
    },
  ];

  const expectedMappingResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    bindings: [],
    mapping: expectedMapping,
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) pickSpread param used twice', () => {
  const query = `
  /*
    @name insertUsers
    @param users -> ((name, age)...)
  */
  INSERT INTO users (name, age) VALUES :users, :users RETURNING id;`;

  const parameters = {
    users: [
      { name: 'Bob', age: 12 },
      { name: 'Tom', age: 22 },
    ],
  };

  const expectedInterpolationResult = {
    query:
      'INSERT INTO users (name, age) VALUES ($1,$2),($3,$4), ($1,$2),($3,$4) RETURNING id',
    bindings: ['Bob', 12, 'Tom', 22],
    mapping: [],
  };

  const expectedMapping = [
    {
      name: 'users',
      type: ParameterTransform.PickSpread,
      dict: {
        name: {
          name: 'name',
          type: ParameterTransform.Scalar,
          required: false,
          assignedIndex: 1,
        },
        age: {
          name: 'age',
          type: ParameterTransform.Scalar,
          required: false,
          assignedIndex: 2,
        },
      },
    },
  ];

  const expectedMappingResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2), ($1,$2) RETURNING id',
    bindings: [],
    mapping: expectedMapping,
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) scalar param required and optional', () => {
  const query = `
  /* @name selectSomeUsers */
  SELECT id, name from users where id = :id! and user_id = :id;`;

  const parameters = {
    id: '123',
  };

  const expectedInterpolationResult = {
    query: 'SELECT id, name from users where id = $1 and user_id = $1',
    mapping: [],
    bindings: ['123'],
  };

  const expectedMappingResult = {
    query: 'SELECT id, name from users where id = $1 and user_id = $1',
    mapping: [
      {
        assignedIndex: 1,
        name: 'id',
        required: true,
        type: ParameterTransform.Scalar,
      },
    ],
    bindings: [],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) pick param required', () => {
  const query = `
  /*
    @name insertUsers
    @param user -> (name!, age)
  */
  INSERT INTO users (name, age) VALUES :user RETURNING id;`;

  const parameters = {
    user: { name: 'Bob', age: 12 },
  };

  const expectedInterpolationResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    bindings: ['Bob', 12],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    bindings: [],
    mapping: [
      {
        name: 'user',
        type: ParameterTransform.Pick,
        dict: {
          name: {
            assignedIndex: 1,
            name: 'name',
            type: ParameterTransform.Scalar,
            required: true,
          },
          age: {
            assignedIndex: 2,
            name: 'age',
            type: ParameterTransform.Scalar,
            required: false,
          },
        },
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);

  const mappingResult = render(queryIR);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('(SQL) array param required', () => {
  const query = `
  /*
    @name selectSomeUsers
    @param ages -> (...)
  */
  SELECT FROM users WHERE age in :ages!;`;

  const parameters = {
    ages: [23, 27, 50],
  };

  const expectedInterpolationResult = {
    query: 'SELECT FROM users WHERE age in ($1,$2,$3)',
    bindings: [23, 27, 50],
    mapping: [],
  };

  const expectedMappingResult = {
    query: 'SELECT FROM users WHERE age in ($1)',
    bindings: [],
    mapping: [
      {
        name: 'ages',
        type: ParameterTransform.Spread,
        required: true,
        assignedIndex: 1,
      },
    ],
  };

  const queryIR = parseSqlFile(query).queries[0];
  const interpolationResult = render(queryIR, parameters);
  const mappingResult = render(queryIR);

  expect(interpolationResult).toStrictEqual(expectedInterpolationResult);
  expect(mappingResult).toStrictEqual(expectedMappingResult);
});

test('renders a param used twice as the same placeholder', () => {
  const ir = parseSqlFile('/* @name Q */ SELECT :a, :a').queries[0];
  expect(render(ir, { a: 1 })).toMatchObject({
    query: 'SELECT $1, $1',
    bindings: [1],
  });
});

test('renders tag-style $ references identically', () => {
  const ir = parseTagged('SELECT $a, $$b', 'q');
  expect(render(ir, { a: 1, b: [2, 3] })).toMatchObject({
    query: 'SELECT $1, ($2,$3)',
    bindings: [1, 2, 3],
  });
});

/**
 * An empty array used to render `IN ()` — or `VALUES ()` from a pick spread —
 * and the first thing the caller heard about it was `42601 syntax error at or
 * near ")"` from the server, pointing at a paren in SQL they never wrote
 * (upstream #221, #314, #273). What is thrown here names the call site
 * instead. It deliberately does *not* invent a rendering: there is no text
 * that means "zero rows" in every position.
 */
describe('an empty array in a spread', () => {
  const spread = `
  /*
    @name selectSomeUsers
    @param ids -> (...)
  */
  SELECT id, name FROM books WHERE id IN :ids;`;

  const pickSpread = `
  /*
    @name insertUsers
    @param users -> ((name, age)...)
  */
  INSERT INTO users (name, age) VALUES :users RETURNING id;`;

  test('(array_spread) throws before the SQL is built', () => {
    const queryIR = parseSqlFile(spread).queries[0];
    expect(() => render(queryIR, { ids: [] })).toThrow(
      `Query selectSomeUsers was passed an empty array for parameter "ids" (array_spread): ` +
        `a spread renders one placeholder per element, and there is no SQL for zero of them — ` +
        `"IN ()" is a syntax error, and no substitute is correct in every position. Check the ` +
        `array is non-empty before running the query. The nonEmptyArrayParams codegen option ` +
        `makes a statically empty array a compile error, but cannot see the length of one built ` +
        `at runtime.`,
    );
  });

  // The two render through different branches, and this is the shape #221
  // reported: `INSERT INTO jt (id, doc) VALUES ()`.
  test('(pick_array_spread) throws before the SQL is built', () => {
    const queryIR = parseSqlFile(pickSpread).queries[0];
    expect(() => render(queryIR, { users: [] })).toThrow(
      /empty array for parameter "users" \(pick_array_spread\)/,
    );
  });

  test('(tag) a $$ spread throws the same way', () => {
    const queryIR = parseTagged(
      'SELECT id, name FROM books WHERE id IN $$ids',
      'selectSomeUsers',
    );
    expect(() => render(queryIR, { ids: [] })).toThrow(
      /empty array for parameter "ids" \(array_spread\)/,
    );
  });

  test('one element still renders, and so does the mapping form', () => {
    const spreadIR = parseSqlFile(spread).queries[0];
    expect(render(spreadIR, { ids: [1] }).query).toBe(
      'SELECT id, name FROM books WHERE id IN ($1)',
    );
    // The no-params form describes the shape of the query rather than one
    // call, so it has no array to be empty.
    expect(render(spreadIR).query).toBe(
      'SELECT id, name FROM books WHERE id IN ($1)',
    );

    const pickIR = parseSqlFile(pickSpread).queries[0];
    expect(render(pickIR, { users: [{ name: 'Bob', age: 12 }] }).query).toBe(
      'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    );
    expect(render(pickIR).query).toBe(
      'INSERT INTO users (name, age) VALUES ($1,$2) RETURNING id',
    );
  });
});

/**
 * The construct all three of upstream #498, #517 and #630 report:
 * `FROM (VALUES :rows) AS t(a, b)`. Postgres has to give a sub-select's columns
 * concrete types before it typechecks anything downstream, and a `VALUES` list
 * resolves its columns from its own rows alone — so with every row an `unknown`
 * parameter, the `unknown` → `text` fallback fires and locks in, and the query
 * fails with `42804` or `42883` further down. A cast in the rendered row is
 * what pins it, and nothing else here changes: the server then reports the real
 * OID in `ParameterDescription` and codegen reads its type off that.
 */
describe('key types render as casts', () => {
  test('(SQL) a pick_tuple casts each typed key, in both render forms', () => {
    const ir = parseSqlFile(
      `/* @name Q @param u -> (id::int4, val::text, note) */
       UPDATE t SET x = 1 FROM (VALUES :u) AS item(id, val, note);`,
    ).queries[0];
    const expected =
      'UPDATE t SET x = 1 FROM (VALUES ($1::int4,$2::text,$3)) AS item(id, val, note)';
    expect(render(ir).query).toBe(expected);
    expect(render(ir, { u: { id: 1, val: 'a', note: null } })).toMatchObject({
      query: expected,
      bindings: [1, 'a', null],
    });
  });

  test('(SQL) a pick_array_spread casts the first row only', () => {
    // Verified against a live server: `VALUES ($1::int4,$2::text),($3,$4)`
    // prepares as `{integer,text,integer,text}`, so the first row is enough to
    // type the whole column and repeating the cast per row would only grow the
    // SQL with the batch.
    const ir = parseSqlFile(
      `/* @name Q @param us -> ((id::int4, val::text)...) */
       UPDATE t SET x = 1 FROM (VALUES :us) AS item(id, val);`,
    ).queries[0];
    expect(
      render(ir, {
        us: [
          { id: 1, val: 'a' },
          { id: 2, val: 'b' },
          { id: 3, val: 'c' },
        ],
      }),
    ).toMatchObject({
      query:
        'UPDATE t SET x = 1 FROM (VALUES ($1::int4,$2::text),($3,$4),($5,$6)) AS item(id, val)',
      bindings: [1, 'a', 2, 'b', 3, 'c'],
    });
    // The mapping form renders one row, which is the text sent to Describe.
    expect(render(ir).query).toBe(
      'UPDATE t SET x = 1 FROM (VALUES ($1::int4,$2::text)) AS item(id, val)',
    );
  });

  test('(TS) a tag renders the same casts', () => {
    const ir = parseTagged(
      'UPDATE t SET x = 1 FROM (VALUES $$us(id::int4, val::text)) AS item(id, val)',
      'Q',
    );
    expect(
      render(ir, {
        us: [
          { id: 1, val: 'a' },
          { id: 2, val: 'b' },
        ],
      }).query,
    ).toBe(
      'UPDATE t SET x = 1 FROM (VALUES ($1::int4,$2::text),($3,$4)) AS item(id, val)',
    );
  });

  test('a cast does not disturb the mapping, and `!` still reaches it', () => {
    const ir = parseSqlFile(
      `/* @name Q @param u -> (id!::int4, val::text) */ INSERT INTO t VALUES :u;`,
    ).queries[0];
    expect(render(ir).mapping).toStrictEqual([
      {
        name: 'u',
        type: ParameterTransform.Pick,
        dict: {
          id: {
            name: 'id',
            required: true,
            type: ParameterTransform.Scalar,
            assignedIndex: 1,
          },
          val: {
            name: 'val',
            required: false,
            type: ParameterTransform.Scalar,
            assignedIndex: 2,
          },
        },
      },
    ]);
  });

  test('an untyped key list renders exactly as it did', () => {
    const ir = parseSqlFile(
      `/* @name Q @param us -> ((name, age)...) */ INSERT INTO t VALUES :us;`,
    ).queries[0];
    expect(
      render(ir, {
        us: [
          { name: 'a', age: 1 },
          { name: 'b', age: 2 },
        ],
      }).query,
    ).toBe('INSERT INTO t VALUES ($1,$2),($3,$4)');
  });
});
