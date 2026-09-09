import { parseCode } from './parseTypescript.js';

test('parser finds string template in correct file', () => {
  const fileContent = `
    const sql : any = null;

    const query = sql\`
      select id, name, age from users;
    \`;
  `;

  const result = parseCode(fileContent);
  expect(result).toMatchSnapshot();
});

test('parser finds string template in incorrect file', () => {
  const fileContent = `
    const sql  ny =/ null;

    const query = sql\`
      select id, name, age from users;
    \`;
  `;

  const result = parseCode(fileContent);
  expect(result).toMatchSnapshot();
});

// parseTagged rejects a param whose inline selections disagree between uses.
// The tag is named in the message so a file with several is actionable.
test('reports a malformed tag without aborting the file', () => {
  const fileContent = `
    const good = sql\`select id from users where id = $id\`;
    const bad = sql\`insert into users $u(name) select $u(name, age)\`;
  `;

  const result = parseCode(fileContent, 'queries.ts');
  expect(result.queries.map((q) => q.queryName)).toEqual(['good']);
  expect(result.errors).toEqual([
    'queries.ts: Parameter "u" is used with different selections',
  ]);
});

describe('a sql.named tag, which carries its own statement name', () => {
  test('is found, and the explicit name beats the variable', () => {
    const result = parseCode(
      `const getUsers = sql.named<GetUsersQuery>('GetUsers')\`select id from users\`;`,
      'queries.ts',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.queries.map((q) => q.queryName)).toEqual(['GetUsers']);
  });

  // The tag text of `sql.named<T>('X')` is the whole call expression, type
  // argument included, so a getText() comparison never matches it.
  test('is matched through its type argument and any formatting', () => {
    const result = parseCode(
      `const getUsers = sql
         .named  <GetUsersQuery>  (
           "GetUsers",
         )\`select id from users\`;`,
      'queries.ts',
    );

    expect(result.errors).toEqual([]);
    expect(result.queries.map((q) => q.queryName)).toEqual(['GetUsers']);
  });

  test('shares a file with plain tags, and both are found', () => {
    const result = parseCode(
      `
      const getUsers = sql.named<GetUsersQuery>('GetUsers')\`select id from users\`;
      const books = sql\`select id from books\`;
      `,
      'queries.ts',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.queries.map((q) => q.queryName)).toEqual([
      'GetUsers',
      'books',
    ]);
  });

  test('leaves a plain tag named after its variable', () => {
    const result = parseCode(
      `const getUsers = sql\`select id from users where id = $id\`;`,
      'queries.ts',
    );

    expect(result).toMatchObject({
      errors: [],
      warnings: [],
      queries: [{ queryName: 'getUsers' }],
    });
  });
});

// A statement name is only useful if it leads back to the code, so codegen
// says so when the variable holding it says something else.
describe('the statement name is linted against the variable', () => {
  test('a matching variable is quiet', () => {
    const result = parseCode(
      `const getUsers = sql.named<Q>('GetUsers')\`select id from users\`;`,
      'queries.ts',
    );

    expect(result.warnings).toEqual([]);
  });

  test('a mismatched variable warns, naming both sides', () => {
    const result = parseCode(
      `const users = sql.named<Q>('GetUsers')\`select id from users\`;`,
      'queries.ts',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('queries.ts:');
    expect(result.warnings[0]).toContain('GetUsers');
    expect(result.warnings[0]).toContain('`users`');
    expect(result.warnings[0]).toContain('`getUsers`');
    expect(result.warnings[0]).toContain('pg_stat_statements');
    // A warning is advisory: the query is still generated, under its name.
    expect(result.queries.map((q) => q.queryName)).toEqual(['GetUsers']);
  });

  // Nothing to compare against, so nothing to warn about.
  test('a tag with no variable to compare is skipped by the lint', () => {
    const result = parseCode(
      `
      await run(sql.named<Q>('GetUsers')\`select id from users\`);
      const queries = { users: sql.named<Q>('GetUsers')\`select id from users\` };
      `,
      'queries.ts',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.queries.map((q) => q.queryName)).toEqual([
      'GetUsers',
      'GetUsers',
    ]);
  });
});

// Without a readable name codegen would have to guess what the generated
// types are called, so the file fails rather than silently dropping the query.
describe('a sql.named name codegen cannot read', () => {
  test.each([
    ['a variable', `sql.named<Q>(name)`, 'name'],
    ['an interpolation', 'sql.named<Q>(`Get${x}`)', 'Get${x}'],
    ['a concatenation', `sql.named<Q>('Get' + 'Users')`, `'Get' + 'Users'`],
    ['an empty string', `sql.named<Q>('')`, `''`],
  ])('%s is an error, not a silent skip', (_label, tag, quoted) => {
    const result = parseCode(
      `const getUsers = ${tag}\`select id from users\`;`,
      'queries.ts',
    );

    expect(result.queries).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('queries.ts:');
    expect(result.errors[0]).toContain('string literal');
    expect(result.errors[0]).toContain(quoted);
  });

  test('a missing name is an error too', () => {
    const result = parseCode(
      `const getUsers = sql.named<Q>()\`select id from users\`;`,
      'queries.ts',
    );

    expect(result.queries).toEqual([]);
    expect(result.errors).toEqual([
      'queries.ts: `sql.named` was called without a statement name',
    ]);
  });
});
