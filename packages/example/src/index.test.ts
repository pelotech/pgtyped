import pg from 'pg';
import {
  aggregateEmailsAndTest,
  countBooks,
  findBookById,
  findBookNameOrRank,
  findBookUnicode,
  getBooks,
  getBooksByAuthorName,
  insertBooks,
  updateBooks,
  updateBooksCustom,
  updateBooksRankNotNull,
} from './books/books.queries.js';
import {
  getAllComments,
  insertComment,
  selectExistsTest,
} from './comments/comments.queries.js';
import {
  insertNotification,
  insertNotifications,
} from './notifications/notifications.js';
import {
  getNotifications,
  sendNotifications,
  thresholdFrogs,
} from './notifications/notifications.queries.js';
import { getUsersWithComment } from './users/sample.js';
import { Category } from './customTypes.js';
import { sql } from './sql/index.js';

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

test('ts-implicit mode query', async () => {
  const books = await sql(`SELECT * FROM books WHERE id = $id`).run(client, {
    id: 1,
  });
  expect(books).toMatchSnapshot();
});
