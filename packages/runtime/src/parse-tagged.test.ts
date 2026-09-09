// packages/runtime/src/parse-tagged.test.ts
import { parseTagged } from './parse-tagged.js';

describe('parseTagged', () => {
  test('scalar params with required marks', () => {
    const q = parseTagged(
      'SELECT * FROM users WHERE id = $id AND age > $age!',
      'getUser',
    );
    expect(q.queryName).toBe('getUser');
    expect(
      q.params.map((p) => [p.name, p.required, p.transform]),
    ).toStrictEqual([
      ['id', false, { type: 'scalar' }],
      ['age', true, { type: 'scalar' }],
    ]);
  });

  test('$$ is a spread', () => {
    const q = parseTagged('WHERE id IN $$ids', 'q');
    expect(q.params[0].transform).toStrictEqual({ type: 'array_spread' });
  });

  test('inline pick and pick-spread', () => {
    const q = parseTagged(
      'INSERT INTO n VALUES $one(payload!, type), $$many(payload!, type!)',
      'q',
    );
    expect(q.params.map((p) => p.transform)).toStrictEqual([
      {
        type: 'pick_tuple',
        keys: [
          { name: 'payload', required: true },
          { name: 'type', required: false },
        ],
      },
      {
        type: 'pick_array_spread',
        keys: [
          { name: 'payload', required: true },
          { name: 'type', required: true },
        ],
      },
    ]);
  });

  test('the statement keeps the references in place and locs index into it', () => {
    const q = parseTagged('SELECT $a, $b', 'q');
    expect(q.statement).toBe('SELECT $a, $b');
    expect(
      q.statement.slice(q.params[1].locs[0].a, q.params[1].locs[0].b),
    ).toBe('$b');
  });

  test('a leading block comment supplies @column hints', () => {
    const q = parseTagged(
      `
      /* @column total! */
      SELECT count(*) AS total FROM t`,
      'q',
    );
    expect(q.columns).toStrictEqual([{ name: 'total', nullable: false }]);
    expect(q.statement).toBe('SELECT count(*) AS total FROM t');
  });

  test('drops a terminating semicolon, as the .sql front-end does', () => {
    expect(parseTagged('SELECT 1;', 'q').statement).toBe('SELECT 1');
    expect(parseTagged('SELECT 1 ;  ', 'q').statement).toBe('SELECT 1');
    expect(parseTagged('SELECT 1', 'q').statement).toBe('SELECT 1');
  });

  test('a semicolon inside a string is not a terminator', () => {
    expect(parseTagged("SELECT ';'", 'q').statement).toBe("SELECT ';'");
  });

  test('locs still index into the statement after the semicolon is dropped', () => {
    const q = parseTagged('SELECT $a, $b;', 'q');
    expect(q.statement).toBe('SELECT $a, $b');
    for (const p of q.params) {
      expect(q.statement.slice(p.locs[0].a, p.locs[0].b)).toBe(`$${p.name}`);
    }
  });

  test('defaults the name to "query"', () => {
    expect(parseTagged('SELECT 1').queryName).toBe('query');
  });

  test('never sets a canonical statement name', () => {
    expect(parseTagged('SELECT 1', 'q').name).toBeUndefined();
  });

  test('a param used twice with mismatched selections is an error', () => {
    expect(() => parseTagged('SELECT $a(x), $a(y)', 'q')).toThrow(
      /different selections/,
    );
  });
});

// Ported from the old ANTLR-based TS parser's conformance suite
// (packages/parser/src/loader/typescript/query.test.ts), which asserted these
// facts via inclusive-end, file-relative offsets against a different AST
// shape. Here we assert the same facts against the new IR, and offsets are
// checked by slicing the statement instead of comparing raw numbers.
describe('parseTagged: ported from the old TS parser conformance suite', () => {
  test('scalar param', () => {
    const query = 'select * from users where id = $id and title= $title';
    const q = parseTagged(query);
    expect(q.statement).toBe(query);
    expect(
      q.params.map((p) => [p.name, p.required, p.transform]),
    ).toStrictEqual([
      ['id', false, { type: 'scalar' }],
      ['title', false, { type: 'scalar' }],
    ]);
    expect(
      q.statement.slice(q.params[0].locs[0].a, q.params[0].locs[0].b),
    ).toBe('$id');
    expect(
      q.statement.slice(q.params[1].locs[0].a, q.params[1].locs[0].b),
    ).toBe('$title');
  });

  test('pick param', () => {
    const query =
      'select * from users where id in $activeUsers(userOne, userTwo)';
    const q = parseTagged(query);
    expect(q.statement).toBe(query);
    expect(
      q.params.map((p) => [p.name, p.required, p.transform]),
    ).toStrictEqual([
      [
        'activeUsers',
        false,
        {
          type: 'pick_tuple',
          keys: [
            { name: 'userOne', required: false },
            { name: 'userTwo', required: false },
          ],
        },
      ],
    ]);
    expect(
      q.statement.slice(q.params[0].locs[0].a, q.params[0].locs[0].b),
    ).toBe('$activeUsers(userOne, userTwo)');
  });

  test('array param', () => {
    const query = 'select * from users where id in $$ids';
    const q = parseTagged(query);
    expect(q.statement).toBe(query);
    expect(
      q.params.map((p) => [p.name, p.required, p.transform]),
    ).toStrictEqual([['ids', false, { type: 'array_spread' }]]);
    expect(
      q.statement.slice(q.params[0].locs[0].a, q.params[0].locs[0].b),
    ).toBe('$$ids');
  });

  test('array spread param', () => {
    const query = `INSERT INTO customers (customer_name, contact_name, address)
  VALUES $$customers(customerName, contactName, address)`;
    const q = parseTagged(query);
    expect(q.statement).toBe(query);
    expect(
      q.params.map((p) => [p.name, p.required, p.transform]),
    ).toStrictEqual([
      [
        'customers',
        false,
        {
          type: 'pick_array_spread',
          keys: [
            { name: 'customerName', required: false },
            { name: 'contactName', required: false },
            { name: 'address', required: false },
          ],
        },
      ],
    ]);
    expect(
      q.statement.slice(q.params[0].locs[0].a, q.params[0].locs[0].b),
    ).toBe('$$customers(customerName, contactName, address)');
  });
});
