## @pelotech/pgtyped-runtime

The runtime half of [PgTyped](https://pgtyped.dev/). It has no dependencies, and it is ESM only.

It provides:

- `TypedQuery`, the class the CLI instantiates in every generated `.queries.ts` file.
- the `sql` tagged template, for writing queries inline in TS files.
- `DatabaseConnection`, the interface a query needs in order to talk to your database.
- `unprepared()`, for connections that cannot support server-side prepared statements.

Install it as a normal dependency; the CLI, which generates the code, is a dev dependency:

```
npm install @pelotech/pgtyped-runtime
```

### Running a query

Queries generated from `.sql` files are exported as `TypedQuery` instances. Queries written inline are built with the `sql` tag, which takes a generic parameter naming the interface PgTyped generated for it:

```ts
import { sql } from '@pelotech/pgtyped-runtime';
import type { GetUsersWithCommentsQuery } from './sample.types.js';

const getUsersWithComments = sql<GetUsersWithCommentsQuery>`
  SELECT u.* FROM users u
  INNER JOIN book_comments bc ON u.id = bc.user_id
  GROUP BY u.id
  HAVING count(bc.id) > $minCommentCount!::int`;
```

Either way you get the same three methods. The connection is always the first argument:

```ts
// Returns the rows.
const users = await getUsersWithComments.run(client, { minCommentCount: 12 });

// Returns { rows, rowCount }. rowCount is the driver's, and is null for
// commands that carry no row count.
const { rows, rowCount } = await getUsersWithComments.execute(client, {
  minCommentCount: 12,
});

// Returns the QueryConfig that run/execute would send, without sending it.
// Useful for logging, tests, and drivers this package does not know about.
const config = getUsersWithComments.compile({ minCommentCount: 12 });
```

A query that declares no parameters has no params slot at all, so it is called with just the connection:

```ts
const books = await getBooks.run(client);
```

### `DatabaseConnection`

The connection you pass is anything with a `query` method that accepts a single `QueryConfig`:

```ts
interface QueryConfig {
  /** Server-side prepared statement name. Omit to send the query unnamed. */
  name?: string;
  text: string;
  values: unknown[];
}

interface QueryResult<T> {
  rows: T[];
  /** node-postgres reports null for commands that carry no row count. */
  rowCount: number | null;
}

interface DatabaseConnection {
  query(config: QueryConfig): Promise<QueryResult<unknown>>;
}
```

node-postgres' `Client` and `Pool` satisfy this as they are, so the usual thing to pass is a `pg` client, a pool, or a client checked out of a pool inside a transaction. Any other driver needs an adapter implementing that one method.

`QueryConfig` is exactly what node-postgres accepts, and node-postgres only issues a server-side `Parse` when `name` is set — which is how prepared statements are turned on and off below.

### Prepared statements

With `preparedStatements` enabled in the CLI config (the default since 3.0), codegen writes a statement name into each eligible query, such as `FindBookById_ddfa9eb1`. The runtime sends that name, and Postgres parses and plans the statement once per connection and reuses it thereafter. `TypedQuery.name` exposes the name, or `undefined` if the query has none.

Codegen deliberately withholds a name from any query whose SQL text varies from call to call — that is, any query with an `array_spread` (`@param ids -> (...)`) or `pick_array_spread` (`@param users -> ((name, age)...)`) parameter, since those render a different number of placeholders each time. Queries built with the `sql` tag never get one either. Those queries are simply sent unnamed, and there is no way to force a name on.

#### `RunOptions`

Every call takes an optional last argument:

```ts
interface RunOptions {
  /** Send this call unnamed regardless of the query's canonical name. */
  prepared?: boolean;
  /** Override the query's canonical statement name for this call. */
  name?: string;
}
```

```ts
await findBookById.run(client, { bookId: 5 }, { prepared: false });
await getBooks.run(client, { prepared: false });
```

`prepared: false` takes precedence over `name`. Setting `prepared: true` is a no-op: it never invents a name for a query that has none.

#### `unprepared()`

Under PgBouncer in transaction-pooling mode, and other poolers that multiplex one server connection across clients, server-side prepared statements are unsafe. `unprepared()` wraps a connection so every query it carries goes out with no statement name, and no per-call option can put one back:

```ts
import { unprepared } from '@pelotech/pgtyped-runtime';

const db = unprepared(pool);
const books = await findBookById.run(db, { bookId: 5 });
```

Wrap every connection you hand to PgTyped, including a client checked out of a pool. The wrapper exposes only `query`, so call `pool.connect()` on the underlying pool and wrap the resulting client in turn:

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await findBookById.run(unprepared(client), { bookId: 5 });
  await client.query('COMMIT');
} finally {
  client.release();
}
```

To disable naming project-wide instead, set `"preparedStatements": false` in the PgTyped config so codegen never assigns a name in the first place.

## Upgrading from 2.x

3.0 changes the shape of nearly every call site. The compiler will find most of it for you; the list below is what to do about each error, plus the changes it cannot catch.

### Swap the argument order

`run` now takes the connection first:

```ts
// 2.x
await findBookById.run({ bookId: 5 }, client);

// 3.0
await findBookById.run(client, { bookId: 5 });
```

For a query with no parameters, delete the params argument entirely. The slot is gone from the type, so the 2.x placeholder does not compile:

```ts
// 2.x
await getBooks.run(undefined, client);

// 3.0
await getBooks.run(client);
```

What follows the connection for such a query is `RunOptions`, so `run(client, { prepared: false })` is a valid call and `run(client, { bookId: 5 })` is not.

### Rename the types you import

- `IDatabaseConnection` is now `DatabaseConnection`, and its `query` method takes a single `QueryConfig` object rather than `(text, values)`. If you wrote a custom adapter, rewrite it against the interface above.
- `PreparedQuery` is now `TypedQuery`. The deprecated `PreparedQuery` alias has been removed, so there is no transition period.
- `TaggedQuery` is gone. The `sql` tag returns a plain `TypedQuery`, so both kinds of query now have one type and one set of methods.
- Generated type names no longer carry the `I` prefix: `IFindBookByIdResult` is now `FindBookByIdResult`. If you would rather not touch every import at once, set `"hungarianNotation": true` in the config to keep the old names.

### Replace `runWithCounts`, `stream` and `ICursor`

`runWithCounts` is now `execute`. Note that the rows come back under `rows`, where 2.x called them `result`:

```ts
// 2.x
const { result, rowCount } = await q.runWithCounts(params, client);

// 3.0
const { rows, rowCount } = await q.execute(client, params);
```

`rowCount` is now `number | null`, matching what node-postgres actually reports: it is `null` for commands that carry no row count.

`stream()` and `ICursor` are removed with no replacement in this package. Use [`pg-cursor`](https://www.npmjs.com/package/pg-cursor) or `pg-query-stream` directly, driving them with `query.compile(params)`, which hands you the `{ name?, text, values }` the query would have sent.

### Move nullability hints from aliases to `@column`

This is the change the compiler cannot find for you, and the one most likely to change your runtime behaviour.

In 2.x you marked a result column non-null or nullable by putting the suffix in the alias. That suffix went to Postgres verbatim, so the server returned a column literally called `total!`, and the runtime stripped the trailing `!` off every row key on the way back so that your code could read `row.total`.

3.0 does no such rewriting. The alias is left alone and the hint moves to a `@column` line in the annotation block:

```sql
-- 2.x
/* @name CountBooksTotal */
SELECT count(*)::int AS "total!" FROM books;

-- 3.0
/*
  @name CountBooksTotal
  @column total!
*/
SELECT count(*)::int AS total FROM books;
```

`!` means never null; `?` means nullable. Either overrides what the catalog reported.

Two things to watch:

- **The name is the Postgres result column name, before `camelCaseColumnNames` is applied.** With camelCasing on, a column selected as `total_count` is still `@column total_count!`, never `@column totalCount!`. A hint that matches no result column is ignored silently, so a mistake shows up as a type that is still nullable rather than as an error.
- **A column you leave as `AS "total!"` now really is named `total!`**, in the generated result type and in the rows coming back — `row['total!']`, not `row.total`. The runtime no longer strips the suffix. Nothing warns about this, so grep your `.sql` files and `sql` tags for quoted aliases ending in `!` or `?` and convert every one.

Hints work in `sql` tags too, in a leading block comment:

```ts
const countBooksTotal = sql<CountBooksTotalQuery>`
  /* @column total! */
  SELECT count(*)::int AS total FROM books`;
```

### Update the config file

- **Unrecognised keys are now errors.** A 2.x config with a typo, or with a removed option, fails to parse instead of being quietly ignored. Read the error; it names the key.
- **`maxWorkerThreads` is removed.** Delete it.
- **`ts-implicit` transform mode is removed.** Use `"mode": "ts"` and `import { sql } from '@pelotech/pgtyped-runtime'` in the files that hold your tags.
- **`preparedStatements` now defaults to `true`.** Queries from `.sql` files are sent as named server-side prepared statements. If you connect through PgBouncer in transaction-pooling mode, set it to `false`, or wrap your connections in `unprepared()`.
- **`hungarianNotation` now defaults to `false`.** Set it to `true` to keep the `I`-prefixed generated type names.

### Drop the packages that no longer exist

`@pelotech/pgtyped-parser`, `@pelotech/pgtyped-query` and `@pelotech/pgtyped-wire` are gone. Nothing they exported was public API, so remove them from your `package.json` and delete any imports; everything you need is in `@pelotech/pgtyped-runtime`.

`typescript` is now an **optional** peer dependency of the CLI, supported at `>=5 <7` and loaded lazily. If all your transforms are `sql` mode, you no longer need it installed for PgTyped's sake.

### Two smaller behaviour changes

- **Mid-statement block comments are kept in the statement text** rather than blanked out. Because a query's prepared statement name is a hash of its text, editing a comment inside a query renames its statement. That is harmless — it just means a fresh `Parse` — but it is why an unrelated-looking comment edit changes generated output.
- **In `sql` tags, `$$` introduces a spread parameter**, and the tag parser does no dollar-quote handling, so a dollar-quoted body cannot be written in a tag: `AS $$SELECT 1$$` is read as a spread parameter named `SELECT`. (A body starting with whitespace, `AS $$ SELECT 1 $$`, survives by accident; do not rely on it.) Move such statements into a `.sql` file, where the parameter sigil is `:` and `$$ ... $$` is recognised as a quoted string.

---

This package is part of the PgTyped project.  
Refer to the root [README](https://github.com/pelotech/pgtyped) for details.
