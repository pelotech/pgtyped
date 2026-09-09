import { parseSqlFile, type QueryIR } from '@pelotech/pgtyped-runtime/internal';
import { ParsedConfig } from './config.js';
import { attachPreparedStatementName } from './preparedStatementName.js';

const enabled = { preparedStatements: true } as ParsedConfig;
const disabled = { preparedStatements: false } as ParsedConfig;

function parse(sql: string): QueryIR {
  const { queries, errors } = parseSqlFile(sql);
  expect(errors).toEqual([]);
  return queries[0];
}

function nameFor(sql: string, config: ParsedConfig = enabled) {
  return attachPreparedStatementName(parse(sql), config).name;
}

const SCALAR_QUERY = `
  /* @name FindBookById */
  SELECT * FROM books WHERE id = :id;
`;

describe('attachPreparedStatementName', () => {
  test('names a fixed-arity query as <declaredName>_<8 hex digits>', () => {
    expect(nameFor(SCALAR_QUERY)).toMatch(/^FindBookById_[0-9a-f]{8}$/);
  });

  test('omits the name when prepared statements are disabled', () => {
    expect(nameFor(SCALAR_QUERY, disabled)).toBeUndefined();
  });

  test('leaves the rest of the IR untouched', () => {
    const ir = parse(SCALAR_QUERY);
    const result = attachPreparedStatementName(ir, enabled);
    expect(result.queryName).toEqual(ir.queryName);
    expect(result.statement).toEqual(ir.statement);
    expect(result.params).toEqual(ir.params);
    expect(result.columns).toEqual(ir.columns);
  });

  // An array-spread param renders a different number of placeholders per call
  // (`IN ($1,$2)` vs `IN ($1,$2,$3)`), so one name would map to many statement
  // texts. node-postgres rejects that at runtime with "Prepared statements must
  // be unique", so these queries must never be named.
  test('omits the name for an array-spread param', () => {
    expect(
      nameFor(`
        /*
          @name FindBooksByIds
          @param ids -> (...)
        */
        SELECT * FROM books WHERE id IN :ids;
      `),
    ).toBeUndefined();
  });

  test('omits the name for a pick-array-spread param', () => {
    expect(
      nameFor(`
        /*
          @name InsertBooks
          @param books -> ((name, rank)...)
        */
        INSERT INTO books (name, rank) VALUES :books;
      `),
    ).toBeUndefined();
  });

  test('names a pick-tuple param, whose arity is fixed at codegen', () => {
    expect(
      nameFor(`
        /*
          @name InsertBook
          @param book -> (name, rank)
        */
        INSERT INTO books (name, rank) VALUES :book;
      `),
    ).toMatch(/^InsertBook_[0-9a-f]{8}$/);
  });

  // A declared-but-unused array-spread param is not in the IR at all — it is
  // reported as a warning instead — so the query has zero params and is
  // trivially nameable. It could not vary the rendered text either way.
  test('names a query whose array-spread param is declared but unused', () => {
    const sql = `
        /*
          @name CountBooks
          @param ids -> (...)
        */
        SELECT count(*) FROM books;
      `;
    expect(parse(sql).params).toEqual([]);
    expect(nameFor(sql)).toMatch(/^CountBooks_[0-9a-f]{8}$/);
  });

  test('is deterministic for identical SQL', () => {
    expect(nameFor(SCALAR_QUERY)).toEqual(nameFor(SCALAR_QUERY));
  });

  // The hash is what defends against a stale server-side statement surviving a
  // deploy on a long-lived connection: edit the SQL, get a different name.
  test('changes the name when the statement text changes', () => {
    const before = nameFor(`
      /* @name FindBookById */
      SELECT * FROM books WHERE id = :id;
    `);
    const after = nameFor(`
      /* @name FindBookById */
      SELECT name FROM books WHERE id = :id;
    `);
    expect(before).not.toEqual(after);
  });

  // Postgres truncates identifiers at 63 bytes; truncating a name that already
  // carries its hash would reintroduce collisions.
  test('caps the name at 63 bytes, keeping the hash suffix', () => {
    const longName = 'A'.repeat(80);
    const name = nameFor(`
      /* @name ${longName} */
      SELECT * FROM books WHERE id = :id;
    `);
    expect(name).toBeDefined();
    expect(Buffer.byteLength(name!, 'utf8')).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^A+_[0-9a-f]{8}$/);
  });

  test('keeps distinct names for two long names sharing a 63-byte prefix', () => {
    const prefix = 'B'.repeat(70);
    const first = nameFor(`
      /* @name ${prefix}One */
      SELECT * FROM books WHERE id = :id;
    `);
    const second = nameFor(`
      /* @name ${prefix}Two */
      SELECT name FROM books WHERE id = :id;
    `);
    expect(first).not.toEqual(second);
  });
});
