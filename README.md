<img width="340" height="150" align="right" src="https://raw.githubusercontent.com/pelotech/pgtyped/HEAD/header.png">

# PgTyped

[![CI](https://github.com/pelotech/pgtyped/workflows/CI/badge.svg)](https://github.com/pelotech/pgtyped/actions)

Write SQL. Get TypeScript types for it, taken from your real database.

PgTyped reads the queries in your `.sql` files (or `sql` tags in `.ts` files), asks Postgres what each one takes and returns, and writes a typed function for it. Your schema stays where it already is — in the database. There is nothing to keep in sync by hand.

## What you get

- Types for parameters and results, inferred from the live schema. Change a column, regenerate, and the compiler tells you what broke.
- Queries in plain SQL files, or inline `sql` tags in TypeScript. Both are typed the same way.
- Parameters are sent to Postgres separately from the query text, so there is no string substitution and no SQL injection surface.
- Every fixed query is sent as a named prepared statement, so Postgres parses and plans it once per connection.
- A runtime with **no dependencies of its own**.
- Watch mode, so types regenerate as you edit.
- Optional checks that catch problems before runtime: a query the connecting role may not execute, a parameter you forgot to pass, a name that hides a typo.

## Install

The packages are published to **GitHub Packages**, not to npmjs.com. Two things are needed first, and both are easy to miss:

1. Tell npm where the `@pelotech` scope lives. In your project's `.npmrc`:

   ```
   @pelotech:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

2. `GITHUB_TOKEN` must be a token with the `read:packages` scope. GitHub Packages needs one to install even public packages.

Then:

```
npm install -D @pelotech/pgtyped-cli
npm install @pelotech/pgtyped-runtime
```

`@pelotech/pgtyped-runtime` is the only thing your application depends on at runtime. `typescript` (5 or 6) is an optional peer of the CLI, only needed if you use `sql` tags in `.ts` files.

## A first query

Put a query in `books.sql`:

```sql
/* @name FindBookById */
SELECT * FROM books WHERE id = :id;
```

Point PgTyped at a database and a config file:

```
npx pgtyped -c config.json
```

It writes `books.queries.ts`, which looks like this (abbreviated):

```ts
/** 'FindBookById' parameters type */
export interface FindBookByIdParams {
  id?: number | null | void;
}

/** 'FindBookById' return type */
export interface FindBookByIdResult {
  author_id: number | null;
  id: number;
  name: string | null;
  rank: number | null;
}

export const findBookById = new TypedQuery<
  FindBookByIdParams,
  FindBookByIdResult
>(findBookByIdIR);
```

Use it with any `pg` client or pool:

```ts
import { Client } from 'pg';
import { findBookById } from './books.queries.js';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const books = await findBookById.run(client, { id: 5 });
console.log(books[0]?.name);

await client.end();
```

The [example package](./packages/example/README.md) is a small working project with a schema, queries in both styles, and tests.

## Generating without a server

Codegen normally needs a running Postgres. It can also run against an in-process [PGlite](https://pglite.dev/) instance — useful in CI, or in a script that applies migrations in memory and then generates types, with no server anywhere. See [Generating without a server](./docs-new/docs/cli.md#generating-without-a-server) for the flow and its limits.

## Limitations

Worth knowing before you start:

- **Codegen needs a database** — a running Postgres, or PGlite as above. The database is the source of truth, so there is no way to generate types from a schema file alone.
- **GitHub Packages only**, with the registry and token setup above. There is no npmjs.com release.
- **Node 24 or newer, ESM only.** There is no CommonJS build of the runtime or of the generated code.
- **Nullability comes from the catalog.** A column from the outer side of a `LEFT JOIN`, or from a view, is reported as Postgres reports it, which is not always what the query can return. `@column` annotations exist for exactly this; see [typing](./docs-new/docs/typing.md).
- **A parameter is a value, never an identifier.** `ORDER BY :column` cannot be made to work, and PgTyped will not pretend otherwise.
- **`sql` tags are JavaScript strings first.** A backslash in a tag must be written `\\`; `.sql` files have no such rule. See [ts-file](./docs-new/docs/ts-file.md).

Everything else that was checked and found to be a real limit is listed, with reproductions, in [docs/upstream-triage.md](./docs/upstream-triage.md).

## Documentation

- [Getting started](./docs-new/docs/getting-started.md)
- [Configuration and the CLI](./docs-new/docs/cli.md)
- [Queries in SQL files](./docs-new/docs/sql-file.md)
- [Queries in TypeScript files](./docs-new/docs/ts-file.md)
- [How types are chosen](./docs-new/docs/typing.md)
- [Upgrading from 2.x](./packages/runtime/README.md#upgrading-from-2x)

## About this fork

This is a fork of [adelsz/pgtyped](https://github.com/adelsz/pgtyped), which has had no maintainer activity since 2025. Version 3.0 rewrote the parser, the runtime and the codegen, renamed the packages to the `@pelotech` scope, and went through every open issue and pull request upstream to reproduce and fix what could be fixed. The [upgrade guide](./packages/runtime/README.md#upgrading-from-2x) covers the changes that affect existing projects.

It is maintained for pelotech's own use first. Issues and pull requests are welcome, with the understanding that what gets built is what someone here needs.

## License

[MIT](./LICENSE). Copyright (c) 2019 Adel Salakh, for the original project; changes in this fork are under the same license.
