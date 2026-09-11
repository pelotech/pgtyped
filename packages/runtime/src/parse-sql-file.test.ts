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
    const { queries, warnings, errors } = parseSqlFile(`
      /* @name A */ SELECT 1;
      /* @name B */ SELECT :b;
    `);
    expect(errors).toStrictEqual([]);
    expect(warnings).toStrictEqual([]);
    // The split points matter as much as the names: each statement starts
    // after its own block and ends at its own `;`, with no block text and no
    // surrounding whitespace, because `statement` is the prepared-statement
    // hash input.
    expect(queries.map((q) => [q.queryName, q.statement])).toStrictEqual([
      ['A', 'SELECT 1'],
      ['B', 'SELECT :b'],
    ]);
    expect(queries[0].params).toStrictEqual([]);
    expect(queries[1].params.map((p) => p.name)).toStrictEqual(['b']);
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
    // Asserted whole, so that the commas in the select list cannot quietly
    // produce a param, a column hint or a diagnostic.
    expect(
      parseSqlFile(`
  /* @name GetAllUsers */
  SELECT id, name FROM users;`),
    ).toStrictEqual({
      queries: [
        {
          queryName: 'GetAllUsers',
          statement: 'SELECT id, name FROM users',
          params: [],
          columns: [],
        },
      ],
      warnings: [],
      errors: [],
    });
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
    expect(p.name).toBe('customers');
    expect(p.transform).toStrictEqual({
      type: 'pick_tuple',
      keys: [
        { name: 'customerName', required: false },
        { name: 'contactName', required: false },
        { name: 'address', required: false },
      ],
    });
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

// Every diagnostic offset is asserted by slicing the source at it, so the
// assertion says what the user would see underlined and cannot pass against an
// offset that merely happens to be in range.
const at = (text: string, offset: number, len: number): string =>
  text.slice(offset, offset + len);

describe('parseSqlFile — an annotation is read whole or reported', () => {
  test('a description line after the last @param does not downgrade it', () => {
    const r = parseSqlFile(`/*
 @name A
 @param ids -> (...)
 Some description here.
*/
SELECT :ids;`);
    expect(r.errors).toStrictEqual([]);
    expect(r.warnings).toStrictEqual([]);
    expect(r.queries[0].params.map((p) => p.transform)).toStrictEqual([
      { type: 'array_spread' },
    ]);
  });

  test('a rule never spans a line to reach a later )', () => {
    const r = parseSqlFile(`/*
 @name A
 @param ids -> (...)
 join on (x)
*/
SELECT :ids;`);
    expect(r.errors).toStrictEqual([]);
    expect(r.queries[0].params.map((p) => p.transform)).toStrictEqual([
      { type: 'array_spread' },
    ]);
  });

  test('a single-line block still holds two annotations', () => {
    const q = one(`/* @name Q @param a -> (...) */ SELECT :a;`);
    expect(q.queryName).toBe('Q');
    expect(q.params.map((p) => p.transform)).toStrictEqual([
      { type: 'array_spread' },
    ]);
  });

  test('a @param that cannot be read is an error, never a silent scalar', () => {
    const text = `/* @name A\n @param ids -> [...] */\nSELECT :ids;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Block @name A declares 1 @param annotations but only 0 could be read',
      'Malformed @param annotation; expected `@param name -> (...)`',
    ]);
    expect(at(text, r.errors[0].offset, 7)).toBe('@name A');
    expect(at(text, r.errors[1].offset, 10)).toBe('@param ids');
  });

  test('a transform may span lines, as it could under the old grammar', () => {
    // The rule ends at its balanced closing paren, not at a newline, so a
    // wrapped transform still parses. The old ANTLR grammar skipped newlines
    // inside comments, so rejecting these would break existing .sql files.
    const q = one(`/*
  @name Insert
  @param books -> ((
    name,
    rank!
  )...)
*/
INSERT INTO books VALUES :books;`);
    expect(q.params[0].transform).toStrictEqual({
      type: 'pick_array_spread',
      keys: [
        { name: 'name', required: false },
        { name: 'rank', required: true },
      ],
    });
  });

  test('a transform whose paren never closes is reported', () => {
    const text = `/* @name A\n @param ids -> (... */\nSELECT :ids;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Block @name A declares 1 @param annotations but only 0 could be read',
      'Malformed @param annotation; expected `@param name -> (...)`',
    ]);
    expect(at(text, r.errors[1].offset, 10)).toBe('@param ids');
  });

  test('a bad transform is reported at its own @param', () => {
    const text = `/* @name A @param i -> (x y) */ SELECT :i;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Cannot parse transform for @param i: (x y)',
    ]);
    expect(at(text, r.errors[0].offset, 8)).toBe('@param i');
  });

  test('an unused @param warns at its declaration, not at the block end', () => {
    const text = `/* @name A @param i -> (...) */${'\n'.repeat(40)}SELECT 1;`;
    const r = parseSqlFile(text);
    expect(r.errors).toStrictEqual([]);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      'Parameter "i" is defined but never used',
    ]);
    expect(r.warnings[0].offset).toBeGreaterThan(0);
    expect(at(text, r.warnings[0].offset, 8)).toBe('@param i');
  });

  test('a trailing comma in a key list does not add an empty key', () => {
    const q = one(`/* @name A @param x -> ((a, b,)...) */ SELECT :x;`);
    expect(q.params[0].transform).toStrictEqual({
      type: 'pick_array_spread',
      keys: [
        { name: 'a', required: false },
        { name: 'b', required: false },
      ],
    });
  });

  test('@column without a sigil is reported and produces no hint', () => {
    const text = `/* @name A @column total */ SELECT 1;`;
    const r = parseSqlFile(text);
    expect(r.queries[0].columns).toStrictEqual([]);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Malformed @column annotation; expected `@column name!` or `@column name?`',
    ]);
    expect(at(text, r.errors[0].offset, 13)).toBe('@column total');
  });

  test('a second @name is reported', () => {
    const text = `/* @name A @name B */ SELECT 1;`;
    const r = parseSqlFile(text);
    expect(r.queries[0].queryName).toBe('A');
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Duplicate @name annotation; the first one wins',
    ]);
    expect(at(text, r.errors[0].offset, 7)).toBe('@name B');
  });

  test('an unrecognised annotation is a warning, not an error', () => {
    const text = `/* @name A @paramx b -> (x) */ SELECT 1;`;
    const r = parseSqlFile(text);
    // It cannot change what is generated, so it must not stop the file from
    // being generated: errors are fatal, warnings are advisory.
    expect(r.errors).toStrictEqual([]);
    expect(r.queries.map((q) => q.queryName)).toStrictEqual(['A']);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      'Unrecognised annotation @paramx',
    ]);
    expect(at(text, r.warnings[0].offset, 7)).toBe('@paramx');
  });

  test('a documentation annotation does not fail the file', () => {
    // Regression: `@deprecated` was reported as an error, and errors are
    // fatal, so documenting a query emitted nothing at all.
    const text = `/* @name GetUsers
   @deprecated use GetPeople instead */
SELECT 1;`;
    const r = parseSqlFile(text);
    expect(r.errors).toStrictEqual([]);
    expect(r.queries.map((q) => [q.queryName, q.statement])).toStrictEqual([
      ['GetUsers', 'SELECT 1'],
    ]);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      'Unrecognised annotation @deprecated',
    ]);
    expect(at(text, r.warnings[0].offset, 11)).toBe('@deprecated');
  });

  test('a misspelled @name still produces a diagnostic', () => {
    // The point of the check is to catch a typo, which the downgrade to a
    // warning must not swallow.
    const text = `/* @name A @nmae B */ SELECT 1;`;
    const r = parseSqlFile(text);
    expect(r.errors).toStrictEqual([]);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      'Unrecognised annotation @nmae',
    ]);
    expect(at(text, r.warnings[0].offset, 5)).toBe('@nmae');
  });

  test('a malformed @param stays an error, not a warning', () => {
    // The severity split is by consequence: this one corrupts the generated
    // query — the param degrades to a scalar — so it has to stay fatal.
    const text = `/* @name A @param ids -> [...] */ SELECT :ids;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Block @name A declares 1 @param annotations but only 0 could be read',
      'Malformed @param annotation; expected `@param name -> (...)`',
    ]);
    expect(r.warnings).toStrictEqual([]);
  });

  test('a duplicate @param is reported', () => {
    const text = `/* @name A @param a -> (...) @param a -> (x) */ SELECT :a;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Duplicate @param a; the last one wins',
    ]);
    expect(text.slice(r.errors[0].offset)).toMatch(/^@param a -> \(x\)/);
  });

  test('an @ in prose is not an annotation', () => {
    const r = parseSqlFile(
      `/* @name A\n mail foo@bar.com, or a bare @ sign */ SELECT 1;`,
    );
    expect(r.errors).toStrictEqual([]);
    expect(r.queries[0].queryName).toBe('A');
  });
});

describe('parseSqlFile — key types on a @param transform', () => {
  test('a pick_tuple carries a type per key', () => {
    const q = one(
      `/* @name Q @param u -> (id::int4, val::text, plain) */ SELECT :u;`,
    );
    expect(q.params[0].transform).toStrictEqual({
      type: 'pick_tuple',
      keys: [
        { name: 'id', required: false, type: 'int4' },
        { name: 'val', required: false, type: 'text' },
        { name: 'plain', required: false },
      ],
    });
  });

  test('so does a pick_array_spread, and `!` combines with a cast', () => {
    const q = one(
      `/* @name Q @param us -> ((id!::int4, val::text[])...) */ SELECT :us;`,
    );
    expect(q.params[0].transform).toStrictEqual({
      type: 'pick_array_spread',
      keys: [
        { name: 'id', required: true, type: 'int4' },
        { name: 'val', required: false, type: 'text[]' },
      ],
    });
  });

  test('a cast survives a transform wrapped across lines', () => {
    const q = one(`/*
  @name Q
  @param us -> ((
    id!::int4,
    val::text
  )...)
*/
SELECT :us;`);
    expect(q.params[0].transform).toStrictEqual({
      type: 'pick_array_spread',
      keys: [
        { name: 'id', required: true, type: 'int4' },
        { name: 'val', required: false, type: 'text' },
      ],
    });
  });

  // A key list this shape is unambiguous, so the diagnostic says what is wrong
  // with the key rather than reprinting the whole rule as unrecognised.
  test('`!` after the cast is reported at its @param, by name', () => {
    const text = `/* @name A @param u -> (id::int4!) */ SELECT :u;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Cannot parse transform for @param u: Key "id::int4!" writes "!" after ' +
        'the cast; a required typed key is "id!::int4", with "!" on the name',
    ]);
    expect(at(text, r.errors[0].offset, 8)).toBe('@param u');
  });

  test('a type that is not an identifier is reported, naming the key', () => {
    const text = `/* @name A @param u -> (id::int4, name::character varying) */ SELECT :u;`;
    const r = parseSqlFile(text);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(
      /^Cannot parse transform for @param u: Key "name" is cast to "character varying"/,
    );
    expect(at(text, r.errors[0].offset, 8)).toBe('@param u');
  });

  test('a type with a length modifier is rejected rather than passed through', () => {
    // `numeric(10,2)` would reach the SQL verbatim if it were accepted, and
    // the modifier cannot change the OID Describe reports anyway.
    const r = parseSqlFile(
      `/* @name A @param u -> (n::numeric(10,2)) */ SELECT :u;`,
    );
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Cannot parse transform for @param u: (n::numeric(10,2))',
    ]);
  });

  test('a param whose transform was rejected is left scalar, so the errors are the result', () => {
    const r = parseSqlFile(`/* @name A @param u -> (id::int4!) */ SELECT :u;`);
    expect(r.errors).toHaveLength(1);
    expect(r.queries[0].params[0].transform).toStrictEqual({ type: 'scalar' });
  });
});

describe('parseSqlFile — a block or a statement is never lost silently', () => {
  test('a trailing block with no statement is an error', () => {
    const text = `/* @name A */\nSELECT 1;\n/* @name B */\n`;
    const r = parseSqlFile(text);
    expect(r.queries.map((q) => q.queryName)).toStrictEqual(['A']);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Block @name B has no statement',
    ]);
    expect(at(text, r.errors[0].offset, 7)).toBe('@name B');
  });

  test('a block replaced by another before any statement is an error', () => {
    const text = `/* @name A */\n/* @name B */\nSELECT 1;\n`;
    const r = parseSqlFile(text);
    expect(r.queries.map((q) => q.queryName)).toStrictEqual(['B']);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Block @name A has no statement',
    ]);
    expect(at(text, r.errors[0].offset, 7)).toBe('@name A');
  });

  test('a file that is nothing but a block is an error', () => {
    const text = `/* @name A */\n`;
    const r = parseSqlFile(text);
    expect(r.queries).toStrictEqual([]);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Block @name A has no statement',
    ]);
    expect(at(text, r.errors[0].offset, 7)).toBe('@name A');
  });

  test('a comment that mentions @name mid-statement is not a header', () => {
    // Regression: `readBlock` ran on every block comment, so an ordinary
    // comment inside a statement that happened to name `@name` was promoted
    // to a header. That invented `GetUsersById`, cut `GetUsers` short, and
    // reported the cut as a missing `;` — a fatal error, so the file that used
    // to build emitted nothing.
    const r = parseSqlFile(`/* @name GetUsers */
SELECT id FROM users
/* WHERE id = :x  -- see @name GetUsersById */
ORDER BY id;`);
    expect(r.errors).toStrictEqual([]);
    expect(r.queries.map((q) => [q.queryName, q.statement])).toStrictEqual([
      [
        'GetUsers',
        'SELECT id FROM users\n/* WHERE id = :x  -- see @name GetUsersById */\nORDER BY id',
      ],
    ]);
    // The comment is part of the statement, so the `:x` inside it must not
    // become a param.
    expect(r.queries[0].params).toStrictEqual([]);
  });

  test('the decorated multi-line header form is still a header', () => {
    const q = one(`/*
 * @name GetUsers
 */
SELECT 1;`);
    expect(q.queryName).toBe('GetUsers');
    expect(q.statement).toBe('SELECT 1');
  });

  test('a header block with trailing prose after its annotations parses', () => {
    const q = one(`/* @name GetUsers
   Returns every user, oldest first. */
SELECT 1;`);
    expect(q.queryName).toBe('GetUsers');
  });

  test('a statement missing its ; does not swallow the next block', () => {
    const text = `/* @name A */\nSELECT 1\n\n/* @name B */\nSELECT :x;`;
    const r = parseSqlFile(text);
    expect(r.queries.map((q) => [q.queryName, q.statement])).toStrictEqual([
      ['A', 'SELECT 1'],
      ['B', 'SELECT :x'],
    ]);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Statement for @name A is not terminated by ";"',
    ]);
    expect(at(text, r.errors[0].offset, 8)).toBe('SELECT 1');
  });

  test('a statement after a complete query does not inherit its block', () => {
    const text = `/* @name A */ SELECT 1;\nSELECT 2;`;
    const r = parseSqlFile(text);
    expect(r.queries.map((q) => q.queryName)).toStrictEqual(['A']);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Statement has no /* @name ... */ block',
    ]);
    expect(at(text, r.errors[0].offset, 8)).toBe('SELECT 2');
  });

  test('the no-block error points at the statement, not the whitespace', () => {
    const text = `\n\n   SELECT 1;`;
    const r = parseSqlFile(text);
    expect(r.errors.map((e) => e.message)).toStrictEqual([
      'Statement has no /* @name ... */ block',
    ]);
    expect(at(text, r.errors[0].offset, 8)).toBe('SELECT 1');
  });
});

/**
 * Issue #549. `DO $$ … :name … $$` generated `Params = void` and said nothing
 * about it. Reading the body as a string is what Postgres does and it stays;
 * what was missing is any sign that the `:name` in it was never a parameter.
 */
describe('parseSqlFile — a param sigil inside a dollar-quoted body', () => {
  const warnings = (sql: string) => {
    const r = parseSqlFile(sql);
    expect(r.errors).toStrictEqual([]);
    return r.warnings.map((w) => w.message);
  };

  test('the reported case warns, and still takes no params', () => {
    const text = `/* @name CreateSeq */
DO $$ BEGIN EXECUTE 'CREATE SEQUENCE ' || :name; END $$;`;
    const r = parseSqlFile(text);

    expect(r.errors).toStrictEqual([]);
    // The behaviour is unchanged: the body is a string, so there is no param.
    expect(r.queries[0].params).toStrictEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toBe(
      `Parameter ":name" in @name CreateSeq is inside a dollar-quoted string ` +
        `($$ … $$), so Postgres reads it as literal text: no parameter is generated ` +
        `for it and the sigil reaches the server as written. A dollar-quoted body ` +
        `cannot take parameters — if it was meant as one, the reference has to move ` +
        `outside the quotes.`,
    );
    expect(at(text, r.warnings[0].offset, 5)).toBe(':name');
  });

  test('a tagged dollar quote warns, and names its tag', () => {
    expect(
      warnings(`/* @name Do */\nDO $body$ SELECT :name $body$;`),
    ).toStrictEqual([
      expect.stringContaining('a dollar-quoted string ($body$ … $body$)'),
    ]);
  });

  test('a nested dollar quote is still a dollar quote', () => {
    expect(
      warnings(`/* @name Do */\nDO $o$ EXECUTE $i$ SELECT :name $i$; $o$;`),
    ).toStrictEqual([
      expect.stringContaining('a dollar-quoted string ($i$ … $i$)'),
    ]);
  });

  test('the marked form is quoted back as written', () => {
    expect(warnings(`/* @name Do */\nDO $$ SELECT :name! $$;`)).toStrictEqual([
      expect.stringContaining('Parameter ":name!"'),
    ]);
  });

  /**
   * The point of the diagnostic is that it fires on a mistake, not on
   * PL/pgSQL. Every one of these is a colon a `DO` block is expected to
   * contain, and a warning on any of them would train the user to stop
   * reading warnings — which costs more than the silence it replaced.
   */
  describe('does not warn on the colons ordinary PL/pgSQL is made of', () => {
    const cases: [string, string][] = [
      ['an assignment', `DO $$ DECLARE x int; BEGIN x := 1; END $$;`],
      ['a cast', `DO $$ BEGIN PERFORM val::int4; END $$;`],
      ['a numeric slice', `DO $$ BEGIN PERFORM arr[1:2]; END $$;`],
      ['a colon in a string', `DO $$ BEGIN RAISE NOTICE 'bad:thing'; END $$;`],
      ['a colon in a comment', `DO $$ BEGIN -- see :name\n END $$;`],
      ['a named cast of a param', `DO $$ SELECT x::text FROM t $$;`],
    ];
    cases.forEach(([label, body]) => {
      test(label, () => {
        expect(warnings(`/* @name Do */\n${body}`)).toStrictEqual([]);
      });
    });
  });

  test('a param outside any dollar quote is unaffected', () => {
    const r = parseSqlFile(
      `/* @name Q */\nSELECT * FROM t WHERE id = :id AND x = (SELECT $$lit$$);`,
    );
    expect(r.warnings).toStrictEqual([]);
    expect(r.queries[0].params.map((p) => p.name)).toStrictEqual(['id']);
  });

  test('a real param and a quoted one in the same statement', () => {
    const r = parseSqlFile(
      `/* @name Q */\nSELECT :real, (SELECT $$ :fake $$) AS lit;`,
    );
    expect(r.queries[0].params.map((p) => p.name)).toStrictEqual(['real']);
    expect(r.warnings.map((w) => w.message)).toStrictEqual([
      expect.stringContaining('Parameter ":fake"'),
    ]);
  });
});
