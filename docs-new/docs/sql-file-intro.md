---
id: sql-file-intro
title: Queries in SQL files
sidebar_label: Queries in SQL files
---

Having installed and configured PgTyped it is now time to write some queries.

Lets create our first query in `books/queries.sql`:

```sql title="books/queries.sql"
/* @name FindBookById */
SELECT * FROM books WHERE id = :bookId;
```

Notice the comment above the SQL query. PgTyped uses such comments to give generated query functions meaningful names.

If PgTyped is running in watch mode, it will automatically parse the SQL file on each change, extracting all queries and generating strictly typed TS queries in `books/queries.ts`:

````ts title="books/queries.ts"
/** Types generated for queries found in "src/books/queries.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

//...

/** 'FindBookById' parameters type */
export interface FindBookByIdParams {
  bookId?: number | null | void;
}

/** 'FindBookById' return type */
export interface FindBookByIdResult {
  author_id: number | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookById' query type */
export interface FindBookByIdQuery {
  params: FindBookByIdParams;
  result: FindBookByIdResult;
}

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE id = :bookId
 * ```
 */
export const findBookById = new TypedQuery<
  FindBookByIdParams,
  FindBookByIdResult
>(findBookByIdIR);
````

Query `findBookById` is now statically typed, with types inferred from the PostgreSQL schema.
The connection comes first and the parameters second; a query that takes no parameters is called as `someQuery.run(client)`.

This generated query can be imported and executed as follows:

```ts title="index.ts" {13}
import { Client } from 'pg';
import { findBookById } from './src/books/queries';

export const client = new Client({
  host: 'localhost',
  user: 'test',
  password: 'example',
  database: 'test',
});

async function main() {
  await client.connect();
  const books = await findBookById.run(client, { bookId: 42 });
  console.log(`Book name: ${books[0].name}`);
  await client.end();
}

main();
```

`run` returns the rows. If you also need the row count, use `execute`, which returns `{ rows, rowCount }`:

```ts
const { rows, rowCount } = await findBookById.execute(client, { bookId: 42 });
```

For more information on writing queries in SQL files check out the [Annotated SQL](sql-file) guide.
