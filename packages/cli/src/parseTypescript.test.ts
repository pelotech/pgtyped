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
