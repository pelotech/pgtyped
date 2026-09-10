import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  aggregateEmailsAndTest,
  countBooks,
  countBooksTotal,
  findBookByCategory,
  findBookById,
  findBookNameOrRank,
  findBookUnicode,
  getBookCountries,
  getBooks,
  getBooksByAuthorName,
  insertBooks,
  updateBooks,
  updateBooksCustom,
  updateBooksRankNotNull,
} from './books/books.queries.js';
import {
  getAllComments,
  getAllCommentsByIds,
  insertComment,
  selectExistsTest,
} from './comments/comments.queries.js';
import {
  getDriverTypes,
  insertDriverTypes,
  type InsertDriverTypesParams,
  type PgInterval,
  type PgPoint,
} from './driverTypes/driverTypes.queries.js';
import {
  countNotifications,
  getAllNotifications,
  insertNotification,
  insertNotifications,
} from './notifications/notifications.js';
import {
  getNotifications,
  sendNotifications,
  thresholdFrogs,
} from './notifications/notifications.queries.js';
import { getUsersWithComment } from './users/sample.js';
import { Category, type EmailAddress } from './customTypes.js';
import { sql, unprepared } from '@pelotech/pgtyped-runtime';
import type {
  CountBookCommentsTagQuery,
  FindBookByIdTagQuery,
} from './index.test.types.js';

const findBookByIdTag = sql<FindBookByIdTagQuery>`SELECT * FROM books WHERE id = $id`;

// Run by exactly one test, the plain-tag case in `prepared statements` below.
// pg_prepared_statements is per session and this suite shares one client, so a
// query executed by an earlier test would already be in the "before" snapshot
// and the diff would prove nothing.
const countBookCommentsTag = sql<CountBookCommentsTagQuery>`SELECT count(*)::int AS total FROM book_comments`;

const { Client } = pg;

const dbConfig = {
  host: process.env.PGHOST ?? '127.0.0.1',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'password',
  database: process.env.PGDATABASE ?? 'postgres',
  port: (process.env.PGPORT ? Number(process.env.PGPORT) : undefined) ?? 5432,
};

// Connect to the database once before all tests
let client: pg.Client;
beforeAll(async () => {
  // Parse dates as strings for demo and testing purposes
  pg.types.setTypeParser(pg.types.builtins.DATE, function (val) {
    return val;
  });

  pg.types.setTypeParser(pg.types.builtins.INT8, function (val) {
    return BigInt(val);
  });

  // Create a new client and connect to the database
  client = new Client(dbConfig);
  await client.connect();
});

// Disconnect from the database after all tests
afterAll(async () => {
  await client.end();
});

// Run each test in a transaction that is rolled back at the end
beforeEach(() => client.query('BEGIN'));
afterEach(() => client.query('ROLLBACK'));

test('select query with unicode characters', async () => {
  const result = findBookUnicode.run(client);
  await expect(result).resolves.toMatchSnapshot();
});

test('select query with parameters', async () => {
  const comments = await getAllComments.run(client, { id: 1 });
  expect(comments).toMatchSnapshot();
});

test('select query with dynamic or', async () => {
  const result = findBookNameOrRank.run(client, {
    rank: 1,
  });
  await expect(result).resolves.toMatchSnapshot();
});

test('select query with date type override (TS)', async () => {
  const comments = await getUsersWithComment(0, client);
  const dateAsString: string = comments.registration_date;
  expect(typeof dateAsString).toBe('string');
});

test('select query with date type override (SQL)', async () => {
  const notifications = await getNotifications.run(client, {
    userId: 1,
    date: '2000-01-01',
  });
  const dateAsString: string = notifications[0].created_at;
  expect(typeof dateAsString).toBe('string');
});

test('insert query with parameter spread', async () => {
  const [{ book_id: insertedBookId }] = await insertBooks.run(client, {
    books: [
      {
        authorId: 1,
        name: 'A Brief History of Time: From the Big Bang to Black Holes',
        rank: 1,
        categories: [Category.Novel, Category.ScienceFiction],
      },
    ],
  });
  const { 0: insertedBook } = await findBookById.run(client, {
    id: insertedBookId,
  });
  expect(insertedBook.categories).toEqual('{novel,science-fiction}');
});

/**
 * `categories` is the one key of the pick that is not marked `!`, and until
 * #573 was fixed it still had to be written out — as `categories: undefined`,
 * because the generated key was not optional. Omitting it binds NULL, exactly
 * as passing `undefined` does.
 */
test('an optional pick key can be left out of the object', async () => {
  const [{ book_id: insertedBookId }] = await insertBooks.run(client, {
    books: [{ authorId: 1, name: 'A Book With No Categories', rank: 9 }],
  });
  const { 0: insertedBook } = await findBookById.run(client, {
    id: insertedBookId,
  });
  expect(insertedBook.categories).toBeNull();
});

test('update query with a non-null parameter override', async () => {
  await updateBooks.run(client, { id: 2, rank: 12, name: 'Another title' });
});

test('insert query with an inline sql comment', async () => {
  const [result] = await insertComment.run(client, {
    comments: [{ commentBody: 'Just a comment', userId: 1 }],
  });
  expect(result).toMatchSnapshot({
    id: expect.any(Number),
  });
});

test('dynamic update query', async () => {
  await updateBooksCustom.run(client, { id: 2, rank: 13 });
});

test('update query with a multiple non-null parameter overrides', async () => {
  await updateBooksRankNotNull.run(client, {
    id: 2,
    rank: 12,
    name: 'Another title',
  });
});

test('select query with join and a parameter override', async () => {
  const books = await getBooksByAuthorName.run(client, {
    authorName: 'Carl Sagan',
  });
  expect(books).toMatchSnapshot();
});

test('select query with aggregation', async () => {
  const [aggregateData] = await aggregateEmailsAndTest.run(client, {
    testAges: [35, 23, 19],
  });
  expect(aggregateData.agetest).toBe(true);
  expect(aggregateData.emails).toEqual([
    'alex.doe@example.com',
    'jane.holmes@example.com',
    'andrewjackson@example.com',
  ]);
});

test('insert query with an enum field', async () => {
  await sendNotifications.run(client, {
    notifications: [
      {
        user_id: 2,
        payload: { num_frogs: 82 },
        type: 'reminder',
      },
    ],
  });
});

test('multiple insert queries with an enum field', async () => {
  await insertNotifications.run(client, {
    params: [
      {
        user_id: 1,
        payload: { num_frogs: 1002 },
        type: 'reminder',
      },
    ],
  });
  await insertNotification.run(client, {
    notification: {
      user_id: 1,
      payload: { num_frogs: 1002 },
      type: 'reminder',
    },
  });
});

test('select query with json fields and casts', async () => {
  const notifications = await thresholdFrogs.run(client, { numFrogs: 80 });
  expect(notifications).toMatchSnapshot();
});

test('select query nullability override on return field', async () => {
  const result = await getBooks.run(client);
  expect(result).toMatchSnapshot();
});

test('select exists query, testing #472', async () => {
  const result = await selectExistsTest.run(client);
  expect(result).toMatchSnapshot();
});

test('select query with a bigint field', async () => {
  const [row] = await countBooks.run(client);
  expect(typeof row.book_count).toBe('bigint');
  expect(row.book_count).toBe(BigInt(4));
});

test('sql tag query', async () => {
  const books = await findBookByIdTag.run(client, { id: 1 });
  expect(findBookByIdTag.name).toBeUndefined(); // tags are never prepared
  expect(books).toMatchSnapshot();
});

test('@column total! removes null from the generated type and the value is a number', async () => {
  const [row] = await countBooksTotal.run(client);
  const n: number = row.total; // type-level: fails to compile if the hint did not apply
  expect(typeof n).toBe('number');
});

/**
 * The regression test for the six `DefaultTypeMapping` entries that declared a
 * type node-postgres does not return (issue #552). Both halves are load-bearing
 * and neither catches the other's failure:
 *
 * - the `const x: T = row.col` annotations are the *type* assertion. Vitest
 *   strips types without checking them, so these are enforced by
 *   `pnpm --filter @pelotech/pgtyped-example check:test`, which CI runs.
 * - the `expect`s are the *value* assertion, against the live server. Nothing
 *   in codegen consults a real value, so this is the only place the two are
 *   ever compared.
 */
describe('generated types describe what the driver really returns', () => {
  test('the return direction', async () => {
    const [row] = await getDriverTypes.run(client);

    // `interval` was `string`. It is an object, and only the fields the
    // interval actually uses are set — hence every field being optional.
    const duration: PgInterval = row.duration;
    expect(duration).toEqual({
      years: 1,
      months: 2,
      days: 3,
      hours: 4,
      minutes: 5,
      seconds: 6,
      milliseconds: 789,
    });
    expect(duration.toPostgres()).toBe(
      '6.789 seconds 5 minutes 4 hours 3 days 2 months 1 years',
    );
    expect(duration.toISO()).toBe('P1Y2M3DT4H5M6.789S');
    expect(duration.toISOString()).toBe('P1Y2M3DT4H5M6.789S');

    // `time` and `timetz` were `Date`. They are the server's own text.
    const startTime: string = row.start_time;
    expect(startTime).toBe('01:02:03');
    const startTimeTz: string = row.start_time_tz;
    expect(startTimeTz).toBe('01:02:03+00');

    // `bit` was `boolean`. It is the digits.
    const flags: string = row.flags;
    expect(flags).toBe('101');

    // `numeric[]` was `(string)[]`, inherited from scalar `numeric`. The
    // elements are parsed with parseFloat even though the scalar is not.
    const amounts: number[] = row.amounts;
    expect(amounts).toEqual([1.5, 2.5]);
    expect(amounts.map((a) => typeof a)).toEqual(['number', 'number']);

    // `point` was `(number)[]`.
    const location: PgPoint = row.location;
    expect(location).toEqual({ x: 1, y: 2 });

    // No range type was in the mapping at all, so this column generated
    // `unknown` and logged `Postgres type 'tstzrange' is not supported by
    // mapping` (issue #213). node-postgres registers no parser for a range, so
    // the value is the server's own literal.
    const period: string = row.period;
    expect(period).toBe('["2020-01-01 00:00:00+00","2020-02-01 00:00:00+00")');

    // Controls. These two were right all along and must not move with the six
    // above: a lone `numeric` really is a string, and `timestamptz` a `Date`.
    const amount: string = row.amount;
    expect(amount).toBe('2.5');
    const recordedAt: Date = row.recorded_at;
    expect(recordedAt).toEqual(new Date('2020-01-01T00:00:00Z'));

    // A domain column. Postgres reports a domain-typed result column as its
    // base type, so the `email_address` entry in config.json's typesOverrides
    // never fired and this was a bare `string` (#503, #594). `EmailAddress` is
    // narrower than `string`, so this annotation stops compiling if the domain
    // is ever flattened again.
    const contact: EmailAddress = row.contact;
    expect(contact).toBe('alex.doe@example.com');
  });

  const insertParams: InsertDriverTypesParams = {
    duration: '2 hours 30 minutes',
    startTime: '07:08:09',
    startTimeTz: '07:08:09+00',
    flags: '011',
    // Both members of the union the parameter type allows.
    amounts: [3.5, '4.5'],
    amount: 5.5,
    location: '(3,4)',
    period: '["2021-01-01 00:00:00+00","2021-02-01 00:00:00+00")',
    recordedAt: new Date('2021-02-03T04:05:06Z'),
    contact: 'jane.holmes@example.com',
  };

  test('the parameter direction round-trips', async () => {
    // The same domain in the parameter direction. Postgres does report the
    // domain itself for an INSERT parameter, so this half was already right;
    // pinning it keeps the two directions from drifting apart, and catches the
    // parameter becoming `unknown` — which no argument would ever reject,
    // since everything is assignable to it.
    const contact: EmailAddress = insertParams.contact;
    expect(contact).toBe('jane.holmes@example.com');

    const [{ id }] = await insertDriverTypes.run(client, insertParams);

    const inserted = (await getDriverTypes.run(client)).find(
      (r) => r.id === id,
    );
    expect(inserted).toMatchObject({
      duration: { hours: 2, minutes: 30 },
      start_time: '07:08:09',
      start_time_tz: '07:08:09+00',
      flags: '011',
      amounts: [3.5, 4.5],
      amount: '5.5',
      location: { x: 3, y: 4 },
      period: '["2021-01-01 00:00:00+00","2021-02-01 00:00:00+00")',
      contact: 'jane.holmes@example.com',
    });
  });

  /**
   * Why `time`, `timetz` and `interval` take a `string` rather than the
   * `Date | string` they used to: node-postgres serialises a `Date` to a full
   * ISO timestamp, which none of the three can parse. The declaration that
   * allowed it turned a compile error into a query that fails in production.
   */
  test('a Date is not a valid time input, which the old parameter type allowed', async () => {
    await expect(
      insertDriverTypes.run(client, {
        ...insertParams,
        startTime: new Date('2020-01-01T01:02:03Z') as unknown as string,
      }),
    ).rejects.toThrow(/invalid input syntax for type time/);
  });
});

describe('prepared statements', () => {
  const prepared = async () =>
    (
      await client.query<{ name: string }>(
        'SELECT name FROM pg_prepared_statements',
      )
    ).rows.map((r) => r.name);

  test('a named query is prepared server-side once and reused', async () => {
    const before = await prepared();
    await getBookCountries.run(client);
    await getBookCountries.run(client);
    const added = (await prepared()).filter((n) => !before.includes(n));
    expect(added).toStrictEqual([getBookCountries.name]);
    expect(getBookCountries.name).toMatch(/^GetBookCountries_[0-9a-f]{8}$/);
  });

  test('an array-spread query is never named and survives differing lengths', async () => {
    expect(getAllCommentsByIds.name).toBeUndefined();
    await getAllCommentsByIds.run(client, { ids: [1, 2] });
    await getAllCommentsByIds.run(client, { ids: [1, 2, 3] });
  });

  test('unprepared() sends the query with no statement name', async () => {
    expect(findBookByCategory.name).toBeDefined();
    await findBookByCategory.run(unprepared(client), { category: 'novel' });
    expect(await prepared()).not.toContain(findBookByCategory.name);
  });

  test('a named sql.prepared tag is prepared server-side once and reused', async () => {
    const before = await prepared();
    await getAllNotifications.run(client);
    await getAllNotifications.run(client);
    const added = (await prepared()).filter((n) => !before.includes(n));
    expect(added).toStrictEqual([getAllNotifications.name]);
    expect(getAllNotifications.name).toMatch(
      /^GetAllNotifications_[0-9a-f]{8}$/,
    );
  });

  // The no-argument form. `countNotifications` is run by this test and no
  // other, so the before/after diff is meaningful: pg_prepared_statements is
  // per session, the suite shares one client, and the per-test ROLLBACK does
  // not deallocate anything.
  test('an unnamed sql.prepared tag is prepared under a derived name', async () => {
    const before = await prepared();
    expect(countNotifications.name).toMatch(/^pgtyped_[0-9a-f]{16}$/);
    await countNotifications.run(client);
    await countNotifications.run(client);
    const added = (await prepared()).filter((n) => !before.includes(n));
    expect(added).toStrictEqual([countNotifications.name]);
  });

  test('a plain sql tag is unnamed and prepares nothing', async () => {
    const before = await prepared();
    expect(countBookCommentsTag.name).toBeUndefined();
    await countBookCommentsTag.run(client);
    expect(await prepared()).toStrictEqual(before);
  });
});

/**
 * The CLI's own suite can prove that a failed run exits non-zero, but not that
 * a successful one exits 0: since 3.0 codegen verifies the connection before
 * it touches a file, so the success path needs a real database. This package
 * has one.
 */
describe('codegen exit code', () => {
  const exampleDir = fileURLToPath(new URL('..', import.meta.url));
  const cliEntry = fileURLToPath(
    new URL('../../cli/lib/cli.js', import.meta.url),
  );

  /**
   * The queries are already generated and committed, so none of these rewrite
   * anything; it is the exit code, and which files get processed, that are
   * under test.
   */
  const codegen = (...args: string[]) =>
    spawnSync(process.execPath, [cliEntry, '-c', 'config.json', ...args], {
      cwd: exampleDir,
      encoding: 'utf-8',
      timeout: 120_000,
    });

  test('a successful run exits 0', () => {
    const { status, stdout } = codegen();

    expect(stdout).toContain('Processing');
    expect(status).toBe(0);
  }, 120_000);

  /**
   * `--file` was compared to glob output with raw string equality, so only the
   * spelling glob happens to produce worked; every other one printed
   * "file was not found in provided transforms" and exited 0. Upstream #579.
   */
  describe('--file', () => {
    const relative = 'src/books/books.sql';
    const absolute = fileURLToPath(new URL('books/books.sql', import.meta.url));

    test.each([
      ['as glob spells it', relative],
      ['with a leading ./', `./${relative}`],
      ['as an absolute path', absolute],
    ])(
      'is found when written %s',
      (_label, spelling) => {
        const { status, stdout } = codegen('-f', spelling);

        expect(stdout).toContain(`Processing ${relative}`);
        expect(stdout).not.toContain('was not found in provided transforms');
        // Only that one file: the other transforms are not run.
        expect(stdout).not.toContain('src/comments/comments.sql');
        expect(status).toBe(0);
      },
      120_000,
    );

    test('a file that matches nothing fails the run', () => {
      const { status, stderr } = codegen('-f', 'src/books/no-such-file.sql');

      expect(stderr).toContain(
        'File override specified, but file was not found in provided transforms',
      );
      // It used to exit 0, so a targeted regeneration step could do nothing
      // at all and still report success.
      expect(status).not.toBe(0);
    }, 120_000);
  });

  /**
   * The opt-in privilege check, against a real role with a real REVOKE.
   *
   * Postgres checks table and column privileges at *execute* time, so
   * Parse/Describe reports a perfectly good result type for a query the role
   * cannot run: clean codegen, exit 0, and `42501 permission denied` in
   * production. Nothing short of a live server with a restricted role proves
   * the check catches that, and the column-level `INSERT (a, b)` / `UPDATE (b)`
   * grants below are invisible to every other part of the pipeline.
   */
  describe('the pre-flight privilege check', () => {
    const role = 'pgtyped_privcheck';

    /**
     * Its own connection, not the suite's: the objects have to be committed
     * before another process can connect as the role and see them, and the
     * shared client spends every test inside a transaction that is rolled back.
     */
    const asOwner = async (statements: string[]) => {
      const owner = new Client(dbConfig);
      await owner.connect();
      try {
        for (const statement of statements) {
          await owner.query(statement);
        }
      } finally {
        await owner.end();
      }
    };

    const drop = [
      'DROP TABLE IF EXISTS privcheck_items',
      'DROP TABLE IF EXISTS privcheck_secrets',
      `DROP OWNED BY ${role}`,
      `DROP ROLE IF EXISTS ${role}`,
    ];

    beforeAll(async () => {
      await asOwner([
        'DROP TABLE IF EXISTS privcheck_items',
        'DROP TABLE IF EXISTS privcheck_secrets',
        `DO $$ BEGIN
           IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
             EXECUTE 'DROP OWNED BY ${role}';
             EXECUTE 'DROP ROLE ${role}';
           END IF;
         END $$`,
        `CREATE ROLE ${role} LOGIN PASSWORD 'privcheck'`,
        `CREATE TABLE privcheck_secrets (
           id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           value text NOT NULL
         )`,
        `CREATE TABLE privcheck_items (
           id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
           a text NOT NULL,
           b text NOT NULL,
           c text
         )`,
        `GRANT USAGE ON SCHEMA public TO ${role}`,
        // privcheck_secrets: nothing at all.
        // privcheck_items: column-level grants only.
        `GRANT SELECT (id) ON privcheck_items TO ${role}`,
        `GRANT INSERT (a, b) ON privcheck_items TO ${role}`,
        `GRANT UPDATE (b) ON privcheck_items TO ${role}`,
      ]);
    }, 120_000);

    afterAll(async () => {
      await asOwner(drop);
    }, 120_000);

    const scratch = (config: Record<string, unknown>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgtyped-privcheck-'));
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'q.sql'),
        [
          '/* @name GetSecrets */',
          'SELECT id, value FROM privcheck_secrets;',
          '',
          '/* @name InsertItem */',
          'INSERT INTO privcheck_items (a, b, c) VALUES (:a!, :b!, :c!);',
          '',
          '/* @name UpdateItemB */',
          'UPDATE privcheck_items SET b = :b! WHERE id = :id!;',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          transforms: [{ mode: 'sql', include: '**/*.sql' }],
          srcDir: './src/',
          ...config,
        }),
      );
      return dir;
    };

    /**
     * The connection is spelled out in the environment rather than in the
     * config file, because the environment is what wins: `PGUSER` and
     * `PGPASSWORD` displace both `dbUrl` and `--uri`, and the compose network
     * sets them (along with `PGTYPED_URI`) for every service. Overriding them
     * here is the only way to make the run connect as the restricted role in
     * the container and on a developer's host alike.
     */
    const runAs = (dir: string) =>
      spawnSync(process.execPath, [cliEntry, '-c', 'config.json'], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          ...process.env,
          PGTYPED_URI: undefined,
          PGURI: undefined,
          DATABASE_URL: undefined,
          PGHOST: dbConfig.host,
          PGPORT: String(dbConfig.port),
          PGDATABASE: dbConfig.database,
          PGUSER: role,
          PGPASSWORD: 'privcheck',
        },
      });

    test('is off by default: the revoked query generates cleanly and exits 0', () => {
      const dir = scratch({});
      try {
        const { status, stdout, stderr } = runAs(dir);
        const generated = fs.readFileSync(
          path.join(dir, 'src', 'q.ts'),
          'utf-8',
        );

        // The whole defect: types for a query that cannot be executed.
        expect(generated).toContain('GetSecretsResult');
        expect(generated).toContain('value: string');
        expect(stdout + stderr).not.toContain('permission denied');
        expect(status).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);

    test('reports the revoked table and the ungranted column, and still generates', () => {
      const dir = scratch({ checkPrivileges: true });
      try {
        const { status, stdout, stderr } = runAs(dir);
        const output = stdout + stderr;
        const generated = fs.readFileSync(
          path.join(dir, 'src', 'q.ts'),
          'utf-8',
        );

        // A table the role has no privileges on at all.
        expect(output).toContain('GetSecrets');
        expect(output).toContain(
          'permission denied for table privcheck_secrets',
        );
        // The case the check is really for: `c` is not in the INSERT grant, and
        // nothing in Parse or Describe can see that.
        expect(output).toContain('InsertItem');
        expect(output).toContain('permission denied for table privcheck_items');
        // The UPDATE only touches the column the role was granted, so it is
        // not reported — the check is not just "warn about every DML".
        expect(output).not.toContain('UpdateItemB');

        // Advisory: the types are right, so they are still written.
        expect(generated).toContain('value: string');
        expect(generated).not.toContain('GetSecretsResult = never');
        expect(status).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);

    test('fails the run under failOnError, and writes nothing', () => {
      const dir = scratch({ checkPrivileges: true, failOnError: true });
      try {
        const { status, stderr } = runAs(dir);

        expect(stderr).toContain('permission denied');
        expect(fs.existsSync(path.join(dir, 'src', 'q.ts'))).toBe(false);
        expect(status).not.toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });

  /**
   * Issue #317. A type the mapping does not know is reported and emitted as
   * `unknown`; with `failOnError: true` the run used to say so and exit **0**
   * anyway, writing the file. This one needs its own project, because the
   * example's own queries all map cleanly.
   */
  describe('a type the mapping does not support', () => {
    const scratch = (failOnError: boolean) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgtyped-317-'));
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'record.sql'),
        '/* @name GetRecord */\nSELECT ROW(1,2) AS r;\n',
      );
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          transforms: [{ mode: 'sql', include: '**/*.sql' }],
          srcDir: './src/',
          failOnError,
          // What a run on the host uses. In the compose network PGTYPED_URI
          // is set and takes precedence over it, which is how the same config
          // reaches the database in both places.
          dbUrl: 'postgres://postgres:password@localhost/postgres',
        }),
      );
      return dir;
    };

    const run = (dir: string) =>
      spawnSync(process.execPath, [cliEntry, '-c', 'config.json'], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 120_000,
      });

    test('is reported, generated as unknown, and exits 0 by default', () => {
      const dir = scratch(false);
      try {
        const { status, stdout } = run(dir);

        expect(stdout).toContain(
          "Postgres type 'record' is not supported by mapping",
        );
        expect(
          fs.readFileSync(path.join(dir, 'src', 'record.ts'), 'utf-8'),
        ).toContain('r: unknown');
        expect(status).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);

    test('fails the run under failOnError, and writes nothing', () => {
      const dir = scratch(true);
      try {
        const { status, stderr } = run(dir);

        expect(stderr).toContain('uses types the mapping does not support');
        expect(fs.existsSync(path.join(dir, 'src', 'record.ts'))).toBe(false);
        // It used to exit 0: the error was logged and then ignored.
        expect(status).not.toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
