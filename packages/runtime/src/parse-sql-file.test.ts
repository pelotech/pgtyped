// packages/runtime/src/parse-sql-file.test.ts
import { parseSqlFile } from './parse-sql-file.js';

const one = (sql: string) => {
  const r = parseSqlFile(sql);
  expect(r.errors).toStrictEqual([]);
  expect(r.queries).toHaveLength(1);
  return r.queries[0];
};

describe('parseSqlFile', () => {
  test('a single query with a scalar param', () => {
    const q = one(`
      /* @name FindBookById */
      SELECT * FROM books WHERE id = :id;
    `);
    expect(q.queryName).toBe('FindBookById');
    expect(q.statement).toBe('SELECT * FROM books WHERE id = :id');
    expect(q.params).toStrictEqual([
      {
        name: 'id',
        transform: { type: 'scalar' },
        required: false,
        locs: [{ a: 31, b: 34 }],
      },
    ]);
    expect(q.columns).toStrictEqual([]);
    expect(q.name).toBeUndefined();
  });

  test('locs index into statement, not the file', () => {
    const q = one(`/* @name Q */ SELECT :a;`);
    const [{ locs }] = q.params;
    expect(q.statement.slice(locs[0].a, locs[0].b)).toBe(':a');
  });

  test('multiple queries, each with its own block', () => {
    const { queries } = parseSqlFile(`
      /* @name A */ SELECT 1;
      /* @name B */ SELECT 2;
    `);
    expect(queries.map((q) => q.queryName)).toStrictEqual(['A', 'B']);
  });

  test('the four @param transforms', () => {
    const q = one(`
      /*
        @name Insert
        @param ids -> (...)
        @param book -> (name, rank!)
        @param books -> ((name!, rank)...)
      */
      SELECT :ids, :book, :books, :plain;
    `);
    expect(q.params.map((p) => [p.name, p.transform])).toStrictEqual([
      ['ids', { type: 'array_spread' }],
      [
        'book',
        {
          type: 'pick_tuple',
          keys: [
            { name: 'name', required: false },
            { name: 'rank', required: true },
          ],
        },
      ],
      [
        'books',
        {
          type: 'pick_array_spread',
          keys: [
            { name: 'name', required: true },
            { name: 'rank', required: false },
          ],
        },
      ],
      ['plain', { type: 'scalar' }],
    ]);
  });

  test('required comes from the reference, and any required reference wins', () => {
    const q = one(`/* @name Q */ SELECT :id, :id!;`);
    expect(q.params).toHaveLength(1);
    expect(q.params[0].required).toBe(true);
    expect(q.params[0].locs).toHaveLength(2);
  });

  test('@column hints', () => {
    const q = one(`
      /*
        @name Totals
        @column total!
        @column maybe?
      */
      SELECT count(*) AS total, max(x) AS maybe FROM t;
    `);
    expect(q.columns).toStrictEqual([
      { name: 'total', nullable: false },
      { name: 'maybe', nullable: true },
    ]);
  });

  test('a declared but unreferenced @param is a warning, not a param', () => {
    const r = parseSqlFile(`
      /* @name Q
         @param ids -> (...) */
      SELECT 1;
    `);
    expect(r.errors).toStrictEqual([]);
    expect(r.queries[0].params).toStrictEqual([]);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      'Parameter "ids" is defined but never used',
    ]);
  });

  test('a statement with no @name block is an error', () => {
    const r = parseSqlFile(`SELECT 1;`);
    expect(r.queries).toStrictEqual([]);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Statement has no /* @name ... */ block',
    ]);
  });

  test('ignores comments that are not annotation blocks', () => {
    const q = one(`
      /* just a note */
      -- and a line comment with :fake
      /* @name Q */
      SELECT :real;
    `);
    expect(q.params.map((p) => p.name)).toStrictEqual(['real']);
  });

  test('a ; inside a string does not end the statement', () => {
    const q = one(`/* @name Q */ SELECT 'a;b', :x;`);
    expect(q.statement).toBe(`SELECT 'a;b', :x`);
  });

  test('the last statement need not end with ;', () => {
    const q = one(`/* @name Q */ SELECT :x`);
    expect(q.statement).toBe('SELECT :x');
  });
});

// Ported from packages/parser/src/loader/sql/index.test.ts, the conformance
// suite for the old ANTLR grammar. Facts (names, transforms, required flags,
// statement text, warnings) are checked against the old parser's snapshots;
// offsets are checked by slicing rather than by exact index, since the new
// IR's offsets are half-open and relative to `statement`, not the file.
describe('parseSqlFile — conformance ported from the old ANTLR parser', () => {
  test('Named query', () => {
    const q = one(`
  /* @name GetAllUsers */
  SELECT * FROM users;`);
    expect(q.queryName).toBe('GetAllUsers');
    expect(q.statement).toBe('SELECT * FROM users');
    expect(q.params).toStrictEqual([]);
  });

  test('Named query selects some fields', () => {
    const q = one(`
  /* @name GetAllUsers */
  SELECT id, name FROM users;`);
    expect(q.queryName).toBe('GetAllUsers');
    expect(q.statement).toBe('SELECT id, name FROM users');
    expect(q.params).toStrictEqual([]);
  });

  test('Named query with an inferred param', () => {
    const q = one(`
  /* @name GetUserById */
  SELECT * FROM users WHERE userId = :userId;`);
    expect(q.statement).toBe('SELECT * FROM users WHERE userId = :userId');
    expect(q.params).toHaveLength(1);
    const [p] = q.params;
    expect(p.name).toBe('userId');
    expect(p.transform).toStrictEqual({ type: 'scalar' });
    expect(p.required).toBe(false);
    expect(p.locs).toHaveLength(1);
    expect(q.statement.slice(p.locs[0].a, p.locs[0].b)).toBe(':userId');
  });

  test('Named query with two inferred params', () => {
    const q = one(`
  /* @name GetUserById */
  SELECT * FROM users WHERE userId = :userId or parentId = :userId;`);
    expect(q.statement).toBe(
      'SELECT * FROM users WHERE userId = :userId or parentId = :userId',
    );
    expect(q.params).toHaveLength(1);
    const [p] = q.params;
    expect(p.name).toBe('userId');
    expect(p.required).toBe(false);
    expect(p.locs).toHaveLength(2);
    for (const loc of p.locs)
      expect(q.statement.slice(loc.a, loc.b)).toBe(':userId');
  });

  test('Named query with a valid param', () => {
    const q = one(`
  /*
    @name CreateCustomer
    @param customers -> (customerName, contactName, address)
  */
  INSERT INTO customers (customer_name, contact_name, address)
  VALUES :customers;`);
    expect(q.statement).toBe(
      'INSERT INTO customers (customer_name, contact_name, address)\n  VALUES :customers',
    );
    expect(q.params).toHaveLength(1);
    const [p] = q.params;
    expect(p.name).toBe('customers');
    expect(p.required).toBe(false);
    expect(p.transform).toStrictEqual({
      type: 'pick_tuple',
      keys: [
        { name: 'customerName', required: false },
        { name: 'contactName', required: false },
        { name: 'address', required: false },
      ],
    });
    expect(p.locs).toHaveLength(1);
    expect(q.statement.slice(p.locs[0].a, p.locs[0].b)).toBe(':customers');
  });

  test('Named query with pick param used twice', () => {
    const q = one(`
  /*
    @name CreateCustomer
    @param customers -> (customerName, contactName, address)
  */
  INSERT INTO customers (customer_name, contact_name, address)
  VALUES :customers, :customers;`);
    expect(q.statement).toBe(
      'INSERT INTO customers (customer_name, contact_name, address)\n  VALUES :customers, :customers',
    );
    expect(q.params).toHaveLength(1);
    const [p] = q.params;
    expect(p.locs).toHaveLength(2);
    for (const loc of p.locs)
      expect(q.statement.slice(loc.a, loc.b)).toBe(':customers');
  });

  test('Unused parameters produce warnings', () => {
    const r = parseSqlFile(`
  /*
    @name GetAllUsers
    @param userNames -> (...)
    @param users -> ((name,time)...)
  */
  SELECT * FROM users;`);
    expect(r.errors).toStrictEqual([]);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0].statement).toBe('SELECT * FROM users');
    expect(r.queries[0].params).toStrictEqual([]);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      'Parameter "userNames" is defined but never used',
      'Parameter "users" is defined but never used',
    ]);
  });

  test('Another test', () => {
    const q = one(`
    /* @name GetBooksByAuthorName */
    SELECT b.* FROM books b
    INNER JOIN authors a ON a.id = b.author_id
    WHERE a.first_name || ' ' || a.last_name = :authorName;`);
    expect(q.queryName).toBe('GetBooksByAuthorName');
    expect(q.statement).toBe(
      "SELECT b.* FROM books b\n    INNER JOIN authors a ON a.id = b.author_id\n    WHERE a.first_name || ' ' || a.last_name = :authorName",
    );
    expect(q.params).toHaveLength(1);
    expect(q.params[0].name).toBe('authorName');
  });

  test('Double and single quotes are supported', () => {
    const q = one(`
  /* @name GetAllUsers */
  SELECT u."rank" FROM users u where name = 'some-name';`);
    expect(q.statement).toBe(
      `SELECT u."rank" FROM users u where name = 'some-name'`,
    );
    expect(q.params).toStrictEqual([]);
  });

  test('Postgres cast operator is correctly parsed', () => {
    const q = one(`
  /* @name GetAllUsers */
  SELECT u."rank" FROM users u where name = :name::text;`);
    expect(q.statement).toBe(
      `SELECT u."rank" FROM users u where name = :name::text`,
    );
    expect(q.params).toHaveLength(1);
    const [p] = q.params;
    expect(p.name).toBe('name');
    expect(p.locs).toHaveLength(1);
    expect(q.statement.slice(p.locs[0].a, p.locs[0].b)).toBe(':name');
  });

  // NOTE: the old parser blanked embedded `/* ... */` comments inside a
  // statement body to same-length whitespace; see the discrepancy called out
  // in the task report. The new front-end leaves opaque spans untouched, so
  // the comment survives verbatim in `statement`.
  test('Ignore multi-line comments in queries', () => {
    const q = one(`
  /* @name UpdateBooks */
  UPDATE books
  /* ignored comment foo: bar's */
  SET name = :name, rank = :rank WHERE id = :id;
`);
    expect(q.statement).toBe(
      "UPDATE books\n  /* ignored comment foo: bar's */\n  SET name = :name, rank = :rank WHERE id = :id",
    );
    expect(q.params.map((p) => p.name)).toStrictEqual(['name', 'rank', 'id']);
  });

  test('Ignore params in inline single-line comments in queries', () => {
    const q = one(`
  /* @name UpdateBooks */
  UPDATE books
  -- ignored comment foo: bar's
  SET name = :name, rank = :rank WHERE id = :id;
`);
    expect(q.statement).toBe(
      "UPDATE books\n  -- ignored comment foo: bar's\n  SET name = :name, rank = :rank WHERE id = :id",
    );
    expect(q.params.map((p) => p.name)).toStrictEqual(['name', 'rank', 'id']);
  });

  test('Include inline single-line comments in statement body', () => {
    const q = one(`
  /* @name UpdateBooks */
  -- Inline comment 1
  UPDATE books
  -- Inline comment 2:
  SET name = :name, rank = :rank WHERE id = :id
  -- Inline comment 3
  ;
`);
    expect(q.statement).toBe(
      '-- Inline comment 1\n  UPDATE books\n  -- Inline comment 2:\n  SET name = :name, rank = :rank WHERE id = :id\n  -- Inline comment 3',
    );
    expect(q.params.map((p) => p.name)).toStrictEqual(['name', 'rank', 'id']);
  });

  test('Comment starts in strings are ignored', () => {
    const q = one(`
  /* @name UpdateBooks */
  UPDATE books
  SET name = '-- /*', rank = :rank WHERE id = :id
  ;
`);
    expect(q.statement).toBe(
      "UPDATE books\n  SET name = '-- /*', rank = :rank WHERE id = :id",
    );
    expect(q.params.map((p) => p.name)).toStrictEqual(['rank', 'id']);
  });

  test('Dollar quoted strings are supported', () => {
    const q = one(`
  /* @name CreateUpdatedAtFunction */
  CREATE FUNCTION UpdatedAt()
  RETURNS TRIGGER AS $$
      BEGIN
          NEW.updatedAt = NOW();
          RETURN NEW;
      END;
  $$ LANGUAGE plpgsql;`);
    expect(q.statement).toBe(
      'CREATE FUNCTION UpdatedAt()\n  RETURNS TRIGGER AS $$\n      BEGIN\n          NEW.updatedAt = NOW();\n          RETURN NEW;\n      END;\n  $$ LANGUAGE plpgsql',
    );
    expect(q.params).toStrictEqual([]);
  });

  test('Query with a PG range', () => {
    const q = one(`
  /* @name TestRange */
  select (ARRAY[1,2,3,4])[2:3] as arr;`);
    expect(q.queryName).toBe('TestRange');
    expect(q.statement).toBe('select (ARRAY[1,2,3,4])[2:3] as arr');
    expect(q.params).toStrictEqual([]);
  });
});
