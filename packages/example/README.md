## @pelotech/pgtyped-example

This is an example app using `pgtyped`.  
Example queries are stored in `src/books/books.sql`, `src/comments/comments.sql`, `src/notifications/notifications.sql` and in `sql` tags in `src/users/sample.ts` and `src/notifications/notifications.ts`.
Try starting PgTyped and editing them to see live query type generation.
`src/index.test.ts` runs every one of them against the live database, so it doubles as a set of working usage examples.

### Usage with your own DB:

1. `pnpm install`
2. Save your config into `config.json`
3. `npx pgtyped -w -c config.json`

### Using the dockerized example setup:

1. Clone the whole pgtyped monorepo into some directory.  
   `git clone git@github.com:pelotech/pgtyped.git pgtyped`
2. `cd pgtyped`
3. `pnpm install`
4. `pnpm build` — from the **repository root**. The example's own `pnpm build` is a
   no-op, and the containers run the CLI out of `packages/cli/lib`, which the root
   build is what produces.
5. `cd packages/example && docker compose run watch`
6. Try editing queries in the SQL and TS files and see how PgTyped handles it.

The dockerized setup isn't required and is included for convenience.  
It creates a PostgreSQL DB, loading it with the schema and seed records defined in `sql/schema.sql`.  
After that it starts PgTyped in a separate container, connecting it to the DB.
