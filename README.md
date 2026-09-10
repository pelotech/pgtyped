<img width="340" height="150" align="right" src="https://raw.githubusercontent.com/pelotech/pgtyped/HEAD/header.png">

# [PgTyped](https://pgtyped.dev/)

[![Actions Status](https://github.com/pelotech/pgtyped/workflows/CI/badge.svg)](https://github.com/pelotech/pgtyped/actions) [![Join the chat at https://gitter.im/pgtyped/community](https://badges.gitter.im/pgtyped/community.svg)](https://gitter.im/pgtyped/community?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)

PgTyped makes it possible to use raw SQL in TypeScript with guaranteed type-safety.  
No need to map or translate your DB schema to TypeScript, PgTyped automatically generates types and interfaces for your SQL queries by using your running Postgres database as the source of type information.

---

## Features:

1. Automatically generates TS types for parameters/results of SQL queries of any complexity.
2. Supports extracting and typing queries from both SQL and TS files.
3. Generate query types as you write them, using watch mode.
4. Useful parameter interpolation helpers for arrays and objects.
5. No need to define your DB schema in TypeScript, your running DB is the live source of type data.
6. Prevents SQL injections by not doing explicit parameter substitution. Instead, queries and parameters are sent separately to the DB driver, allowing parameter substitution to be safely done by the PostgreSQL server.
7. Native ESM. The runtime and the generated code are ESM-only, and the runtime has no dependencies of its own.

### Documentation

Visit our documentation page at [https://pgtyped.dev/](https://pgtyped.dev/)

### Getting started

1. `npm install -D @pelotech/pgtyped-cli`
2. `npm install @pelotech/pgtyped-runtime` (`@pelotech/pgtyped-runtime` is the only required runtime dependency of pgtyped, and it has no dependencies of its own)
3. Create a PgTyped `config.json` file.
4. Run `npx pgtyped -w -c config.json` to start PgTyped in watch mode.

`typescript` is an optional peer dependency of the CLI, supported at `>=5 <7`. It is loaded lazily and only needed for `ts` mode transforms, which scan `.ts` files for `sql` tags. If all your transforms are `sql` mode, you do not need it.

More info on getting started can be found in the [Getting Started](https://pgtyped.dev/docs/getting-started) page.
You can also refer to the [example app](./packages/example/README.md) for a preconfigured example.

### Example

Lets save some queries in `books.sql`:

```sql
/* @name FindBookById */
SELECT * FROM books WHERE id = :bookId;
```

PgTyped parses the SQL file, extracting all queries and generating strictly typed TS queries in `books.queries.ts`:

````ts
/** Types generated for queries found in "books.sql" */
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
This generated query can be imported and executed as follows:

```ts
import { Client } from 'pg';
import { findBookById } from './books.queries';

export const client = new Client({
  host: 'localhost',
  user: 'test',
  password: 'example',
  database: 'test',
});

async function main() {
  await client.connect();
  const books = await findBookById.run(client, { bookId: 5 });
  console.log(`Book name: ${books[0].name}`);
  await client.end();
}

main();
```

### Resources

1. [Configuring pgTyped](https://pgtyped.dev/docs/cli)
2. [Writing queries in SQL files](https://pgtyped.dev/docs/sql-file-intro)
3. [Advanced queries and parameter expansions in SQL files](https://pgtyped.dev/docs/sql-file)
4. [Writing queries in TS files](https://pgtyped.dev/docs/ts-file-intro)
5. [Advanced queries and parameter expansions in TS files](https://pgtyped.dev/docs/ts-file)

### Project state:

This project is being actively developed and its APIs might change.
All issue reports, feature requests and PRs appreciated.

### License

[MIT](https://github.com/pelotech/pgtyped/tree/HEAD/LICENSE)

Copyright (c) 2019-present, Adel Salakh
