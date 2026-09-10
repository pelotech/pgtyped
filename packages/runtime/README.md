## @pelotech/pgtyped-runtime

The runtime half of [PgTyped](https://pgtyped.dev/). It has no dependencies, and it is ESM only.

It provides:

- `TypedQuery`, the class the CLI instantiates in every generated `.queries.ts` file.
- the `sql` tagged template, for writing queries inline in TS files, and `sql.prepared`, its variant that carries a prepared statement name.
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

### `sql.prepared`

A query written with a plain `sql` tag is sent unnamed, so Postgres parses and plans it on every call. `sql.prepared` gives it a server-side prepared statement name, the same thing codegen gives a `.sql` file's `@name`. It comes in two forms.

**With a name**, which is the one to reach for by default:

```ts
import { sql } from '@pelotech/pgtyped-runtime';
import type { GetAllNotificationsQuery } from './notifications.types.js';

export const getAllNotifications = sql.prepared<GetAllNotificationsQuery>(
  'GetAllNotifications',
)`
  SELECT * FROM notifications
`;

const notifications = await getAllNotifications.run(client);
```

The name you pass is only the prefix. The statement is sent as `<name>_<first 8 hex digits of the SHA-256 of its SQL text>`, for example `GetAllNotifications_2199d77a`, exactly as codegen names a `.sql` query; `TypedQuery.name` returns the whole thing. A name longer than Postgres' 63-byte identifier limit is truncated on the prefix, never on the hash.

The name must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, the shape a `.sql` file's `@name` allows. Anything else throws a `TypeError` while the module is being evaluated, rather than reaching the server as something strange.

**With no name**, the name is derived from the statement text alone:

```ts
export const countNotifications = sql.prepared<CountNotificationsQuery>()`
  SELECT count(*)::int AS total FROM notifications
`;

countNotifications.name; // 'pgtyped_f7b4ea6d854099ab'
```

#### Which form to use

An explicit name is worth the few characters it costs. It is greppable: the identifier you see in `pg_prepared_statements`, `pg_stat_statements`, or a `Prepared statements must be unique` error leads straight back to the query in your source, and codegen [warns](https://pgtyped.dev/docs/ts-file#prepared-statements) if the variable holding it drifts away from the name. The derived form gives you `pgtyped_f7b4ea6d854099ab`, which identifies the query only if you are willing to go and hash candidate statements.

What the derived form has going for it is that it costs nothing to adopt. There is nothing to invent, nothing to keep in sync, and no lint to satisfy — useful when turning on prepared statements across a large file of existing tags in one pass, and you can name the ones that turn out to matter afterwards.

#### Why the two hashes are different lengths

The named form keeps 8 hex digits of the hash; the derived form keeps 16. The asymmetry follows from what the hash has to separate.

With a name, the name already separates one query from another. The hash only has to separate successive _edits of that one query_, so that a redeploy cannot bind new text to the name a long-lived pooled connection already prepared — which would otherwise leave that connection executing the old text. A handful of versions of a single statement never approaches 2^32.

With no name, the hash _is_ the identifier, and it has to separate every query in the application from every other. 32 bits is not enough for that: by the birthday bound, 10,000 distinct queries collide with probability around 1.2%, and a collision here means one query silently executing another's SQL. 64 bits takes the same population to about 3e-12.

#### What neither form changes

- A query with a spread parameter stays unnamed in both forms; see [Prepared statements](#prepared-statements) below.
- The CLI's `preparedStatements` option does not reach a tag. It gates the names codegen writes into `.sql` queries, and `sql.prepared` computes its name at runtime. To send a prepared tag unnamed, use `prepared: false` or `unprepared()`.

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

With `preparedStatements` enabled in the CLI config (the default since 3.0), codegen writes a statement name into each eligible query, such as `FindBookById_022dda1d`. The runtime sends that name, and Postgres parses and plans the statement once per connection and reuses it thereafter. `TypedQuery.name` exposes the name, or `undefined` if the query has none.

Two kinds of query carry no name, for two different reasons.

A query whose SQL text varies from call to call **cannot** be named. That is any query with an `array_spread` (`@param ids -> (...)`, `$$ids`) or `pick_array_spread` (`@param users -> ((name, age)...)`, `$$users(name, age)`) parameter: each renders a different number of placeholders per call, so one name would have to stand for many statement texts. node-postgres caches parsed statements by name, per connection, so a second call with a longer array would bind against the statement parsed for the first. Codegen withholds a name from these, `sql.prepared` withholds it too — whether a name was supplied or would have been derived — and no per-call option can put one back.

A query written with a plain `sql` tag **is not** named, which is a default rather than a rule. Inline queries have never been prepared, so the tag stays as it was; [`sql.prepared`](#sqlprepared) opts in, with or without a name, and the query is then named like any other.

Queries with no name are simply sent unnamed, and `TypedQuery.name` is `undefined` for them.

#### `queryName`, which is not `name`

A query object carries two identifiers, and they answer different questions:

```ts
findBookById.queryName; // 'FindBookById'
findBookById.name; // 'FindBookById_022dda1d', or undefined
```

`queryName` is the query's own name — a `.sql` file's `@name`, or the name passed to `sql.prepared`. It is a `string`, never `undefined`, and it does not move: editing the SQL leaves it alone. That makes it the thing to key a metrics label, an OpenTelemetry span name or a slow-query log on:

```ts
const started = performance.now();
const rows = await findBookById.run(client, { bookId: 5 });
metrics.histogram('db.query.duration', performance.now() - started, {
  query: findBookById.queryName,
});
```

`name` is the prepared statement name, which is the identifier the _server_ knows — what you see in `pg_prepared_statements` and in a `Prepared statements must be unique` error. It is `undefined` for the three cases above (`preparedStatements: false`, a plain `sql` tag, a query with a spread parameter), and where it is set its `_022dda1d` suffix is a hash of the SQL text, so it changes every time the query is edited. Both properties make it unusable as a stable identifier for anything you aggregate over time.

One case to know about: a tag has no name of its own at runtime unless you give it one. Codegen derives a tag's name from the variable it is assigned to, but that happens while generating types and never reaches the query object, so a plain `sql` tag and a `sql.prepared()` called with no name both report `queryName` as the placeholder `'query'`. Pass a name to `sql.prepared` for any tag you intend to measure.

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

To disable naming project-wide instead, set `"preparedStatements": false` in the PgTyped config so codegen never assigns a name in the first place. That option only reaches queries codegen names, so a `sql.prepared` tag keeps its name; drop those back to a plain `sql` tag, or wrap the connection in `unprepared()`.

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
- **A column you leave as `AS "total!"` now really is named `total!`** in the rows coming back — `row['total!']`, not `row.total`. The runtime no longer strips the suffix. What the generated result type says depends on `camelCaseColumnNames`:
  - **off** (the default): the field is `"total!"` too, so the type matches the rows. Reading `row.total` is a compile error, and the odd field name is the hint that the alias never got migrated.
  - **on**: `camelCase('total!')` is `'total'`, so the generated field is `total` while the row key is still `total!`. The type compiles, `row.total` is `undefined` at runtime, and nothing in the generated file looks wrong. This is the dangerous case.

  Codegen warns on any result column whose name ends in `!` or `?`, naming the column and the `@column` line to add, in both `sql` files and `sql` tags. With `failOnError` set, the warning fails the run. Still, grep your `.sql` files and `sql` tags for quoted aliases ending in `!` or `?` and convert every one.

Hints work in `sql` tags too, in a leading block comment:

```ts
const countBooksTotal = sql<CountBooksTotalQuery>`
  /* @column total! */
  SELECT count(*)::int AS total FROM books`;
```

### Check that every annotation block opens with `@name`

A `.sql` annotation block must now _start_ with `@name`. Only whitespace and the `*` that decorates a multi-line comment may come before it, so a comment that opens with prose is no longer a header at all:

```sql
-- no longer a header: reports `Statement has no /* @name ... */ block`
/* Get all users. @name GetUsers */
SELECT * FROM users;
```

The same goes for prose on its own line above the tag inside the block. Mentioning `@name` used to be enough, which meant an ordinary comment written _inside_ a statement — `/* WHERE id = :x, see @name GetUsersById */` — was promoted to a header, inventing a query and cutting the statement it was written in half. Requiring the tag to come first tells the two apart.

Any of these keeps the prose:

```sql
/*
  @name GetUsers
  Get all users.
*/
SELECT * FROM users;

-- Get all users.
/* @name GetUsers */
SELECT * FROM users;
```

This is an error rather than a warning, so codegen will tell you; grep your `.sql` files for a `/*` that is followed by anything other than `@name` if you would rather find them first.

### `search_path` finally has an answer: `PGOPTIONS`

There is still no `search_path` config option, and there does not need to be one. 3.0 connects through node-postgres, which reads `PGOPTIONS` from the environment and forwards it to the server, so:

```shell
PGOPTIONS='-c search_path=tenant1' npx pgtyped -c config.json
```

resolves the queries — and generates their types — against `tenant1`. It works for any `-c name=value` the server accepts, and it applies to your application's connections too, since it is node-postgres reading it rather than PgTyped. Set it in both places if your queries depend on a non-default `search_path`; nothing checks that the application connects the same way codegen did.

### Update the config file

- **Unrecognised keys are now errors, at every level of the file.** A 2.x config with a typo, or with a removed option, fails to parse instead of being quietly ignored. Read the error; it names the full path to the key, such as `db.dbname: unrecognized key`.

  Strictness inside the nested objects — `db`, each entry of `transforms`, and each `typesOverrides` entry — is newer than the rest of 3.0, so a config that survived an earlier 3.0 pre-release may still fail here. It is worth the noise: `db: { dbname: 'x' }` used to be dropped silently, leaving PgTyped connected to the default `postgres` database and generating types from whatever schema it found there. The one object still permissive is `db.ssl`, which is handed to node's TLS stack verbatim.

- **`failOnError` now promotes warnings from `.sql` files, not just from `sql` tags.** It always failed the run on a tag lint; the `sql` file front-end printed its warnings and carried on. One option now means one thing whichever kind of file a query lives in.

  The warning this reaches in practice is `Parameter "x" is defined but never used` — an `@param` declaration for a parameter the statement never mentions. If you set `failOnError` and have one, the run now fails. Either delete the stale `@param`, or — if leaving the parameter out of the statement was the mistake — put it in.

- **`failOnError` now catches a type the mapping does not know.** `Postgres type 'record' is not supported by mapping` was logged and then ignored: the column was generated as `unknown` and the run exited **0**, even with `failOnError: true`. It now fails the run, naming the query and the file. Nothing changes on the default path — the error is still advisory, and the column is still `unknown`, which is what forces a caller to narrow it before use.

  If you set `failOnError` and a query selects a type PgTyped has no mapping for — a composite type, `record`, a user-defined range, a multirange — the run now fails where it used to pass. Give each one a [`typesOverrides`](https://pgtyped.dev/docs/cli#configuration-file-format) entry naming the Postgres type.

- **A `typesOverrides` key containing a dot is rejected.** `typesOverrides` is keyed by Postgres type name; a column-shaped key such as `"lobbies.status"` passed validation and then did nothing at all, with no warning. It is now a parse error naming the key. Column-scoped overrides are not supported and are not planned: a _parameter_ cannot be traced back to a column — the protocol says only what type `$1` is, never that it has anything to do with `lobbies.status` — so the feature could only ever have covered half of a query. To type one column differently, give it a domain and override the domain's name, which works in both directions:

  ```sql
  CREATE DOMAIN lobby_status AS text;
  ALTER TABLE lobbies ALTER COLUMN status TYPE lobby_status;
  ```

  ```json
  "typesOverrides": { "lobby_status": "./x.js#MyStatus" }
  ```

- **`maxWorkerThreads` is removed.** Delete it.
- **`ts-implicit` transform mode is removed.** Use `"mode": "ts"` and `import { sql } from '@pelotech/pgtyped-runtime'` in the files that hold your tags.
- **`preparedStatements` now defaults to `true`.** Queries from `.sql` files are sent as named server-side prepared statements. If you connect through PgBouncer in transaction-pooling mode, set it to `false`, or wrap your connections in `unprepared()`.
- **`hungarianNotation` now defaults to `false`.** Set it to `true` to keep the `I`-prefixed generated type names.

### Drop the packages that no longer exist

`@pelotech/pgtyped-parser`, `@pelotech/pgtyped-query` and `@pelotech/pgtyped-wire` are gone. Nothing they exported was public API, so remove them from your `package.json` and delete any imports; everything you need is in `@pelotech/pgtyped-runtime`.

`typescript` is now an **optional** peer dependency of the CLI, supported at `>=5 <7` and loaded lazily. If all your transforms are `sql` mode, you no longer need it installed for PgTyped's sake.

### Regenerate: six types were declared as something the driver never returns

Six entries in the built-in type mapping disagreed with what node-postgres actually hands back, for as long as PgTyped has existed. They are corrected in 3.0, which changes generated output — **regenerate, then compile.** The compiler will find the affected code, because every one of these is a type change rather than a rename.

| Postgres type | was          | is now       | what you actually get |
| ------------- | ------------ | ------------ | --------------------- |
| `interval`    | `string`     | `PgInterval` | `{ hours: 1 }`        |
| `time`        | `Date`       | `string`     | `'01:02:03'`          |
| `timetz`      | `Date`       | `string`     | `'01:02:03+00'`       |
| `bit`         | `boolean`    | `string`     | `'101'`               |
| `numeric[]`   | `(string)[]` | `(number)[]` | `[1.5]`               |
| `point`       | `(number)[]` | `PgPoint`    | `{ x: 1, y: 2 }`      |

A lone `numeric` is unchanged: it really is a `string`, and stays one. Only the array form differs, because pg-types keeps the full precision of a scalar `numeric` but parses the elements of a `numeric[]` with `parseFloat`. `date`, `timestamp` and `timestamptz` are unchanged too, and really are `Date`s.

`PgInterval` and `PgPoint` are emitted into the generated file itself, like `Json` and `DateOrString`, so nothing new is added to your dependencies:

```ts
export type PgPoint = { x: number; y: number };

export type PgInterval = {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
  toPostgres(): string;
  toISO(): string;
  toISOString(): string;
};
```

`PgInterval` is the shape of the `PostgresInterval` that node-postgres returns. **Every field is optional**, because the parser sets only the ones the interval uses — `'1 hour'` parses to `{ hours: 1 }`, and `'0 seconds'` to `{}`. So test the field, do not assume it is `0`:

```ts
// wrong: `hours` is absent, not zero, for an interval of '3 days'
const h = row.duration.hours + 1; // TS error, and NaN if you cast past it

// right
const h = (row.duration.hours ?? 0) + 1;
```

Code that treated an `interval` as a string needs rewriting rather than adjusting — the old declaration was never true, so `row.duration.trim()` was already a runtime error, and `` `${row.duration}` `` still produces `'[object Object]'`. Use `toISO()` for a machine-readable form, or `toPostgres()` for something the server will take back.

**Parameters changed too, and this is the half most likely to be hiding a live bug.** `time`, `timetz` and `interval` used to accept `Date | string`, `bit` a `boolean`, and `point` a `number[]`. None of those non-string forms ever worked: node-postgres serialises a `Date` to a full ISO timestamp, which none of the three time types can parse, and the other two fare no better. All five now take a `string`:

```ts
await insertShift.run(client, {
  startTime: '07:08:09', // was `Date | string`; a Date is `invalid input syntax for type time`
  duration: '2 hours', // ditto
  flags: '011', // was boolean; a boolean arrives as 't', not a binary digit
  location: '(3,4)', // was number[]; neither [3, 4] nor { x: 3, y: 4 } is valid input
});
```

If any of those call sites passed the non-string form, it was failing against the server already and the generated type was hiding it; the narrowed parameter turns it into a compile error. To pass an interval you have read back from another query, call `toPostgres()` on it.

`numeric[]` parameters are unchanged — the server takes numbers or strings either way.

### Three more changes to generated output

The last two are widening, so regenerated files still compile against code written for 2.x. The first only moves a type where you had already asked it to and been ignored. All three change the output, and a diff of your generated files will show them.

- **A domain is typed by its own name, not by its base type.** Postgres reports a domain-typed result column as the type the domain is built over, so `"typesOverrides": { "email": "./types#Email" }` silently did nothing for `SELECT contact FROM accounts` — you got `contact: string`, no import, and no warning. The domain is now recovered from the catalog, so that entry fires, in both the result and the parameter direction. **A domain you have not overridden generates exactly what it generated before**: `contact` stays `string`, and a domain over an enum stays that enum's union. One case gets better on its own: an `INSERT` into a domain column used to log `Postgres type 'email' is not supported by mapping` and generate `unknown` for the parameter, and is now the base type. Two cases are unchanged and cannot be fixed from the protocol — a domain-typed _expression_ (`upper(contact)`, or an explicit cast) and a parameter the server resolves for you (`WHERE contact = :contact!`) are reported as the base type with no column attached, so neither can find the domain.
- **The six built-in range types are mapped.** `int4range`, `int8range`, `numrange`, `tsrange`, `tstzrange` and `daterange` used to generate `unknown` and log `Postgres type 'tstzrange' is not supported by mapping`; they are now `string` in both directions, which is what node-postgres sends and receives for them. If you worked around this with a `typesOverrides` entry, that entry still wins and nothing changes for you.
- **A pick expansion's optional keys are optional.** For `@param address -> (line1!, line2)`, the generated `line2` used to be a required member typed `string | null | void`, so omitting it meant writing `line2: undefined` by hand. It is now `line2?: string | null | void`. An absent key and an explicit `undefined` reach the server as the same NULL, so this only removes the ceremony.

### Three CLI changes to check in your build scripts

- **The bin moved from `lib/index.js` to `lib/cli.js`.** `npx pgtyped` and the `pgtyped` bin name are unaffected, but anything that invokes the CLI by path — a Dockerfile, a CI step, a `node ./node_modules/@pelotech/pgtyped-cli/lib/index.js` invocation — needs updating. The old path was both the bin _and_ the package's only export, so importing anything from the package ran the CLI's argument parsing in the importing process; `lib/index.js` is now the library entry point and exports `main`.
- **Environment variables that set CLI flags need a `PGTYPED_` prefix.** `CONFIG`, `WATCH`, `URI` and `FILE` become `PGTYPED_CONFIG`, `PGTYPED_WATCH`, `PGTYPED_URI` and `PGTYPED_FILE`. Unprefixed, an ambient `FILE` — common enough in a Makefile — set `--file` and the run quietly generated nothing. The `PG*` variables that configure the database connection are unchanged.
- **`--file` exits non-zero when it matches no transform**, rather than printing "file was not found in provided transforms" and exiting 0. It also now accepts any spelling of the path: `src/q.sql`, `./src/q.sql` and an absolute path all name the same file, where before only the one glob happened to produce did.

### Failures that used to be silent

Cases PgTyped handled quietly and now reports. None of them changes what a working project generates or runs.

- **Two result columns landing on the same field are an error.** `SELECT a.id, b."aId" AS id` generated an interface declaring `id` twice — TS2300, from a file you did not write, after a codegen run that exited 0. The query is now reported on stderr and its `Result` and `Params` are emitted as `never`, which is what PgTyped already did for a query whose result shape it cannot express; the rest of the file still generates, and `failOnError` fails the run. There is no dedup to opt into: two distinct columns cannot share one key, so alias one of them. Watch for this if you have `camelCaseColumnNames` on — it is the setting most likely to create the collision, out of columns that are spelled differently in the SQL (`"userName"` and `user_name` are both the field `userName`), and the message names the source columns when that is the cause.

- **An empty array in a spread parameter throws instead of reaching the server.** `run(client, { ids: [] })` on a query with `@param ids -> (...)` used to render `... IN ()` and come back as `42601 syntax error at or near ")"` — an error pointing at a paren in SQL you never wrote. `compile`, `execute` and `run` now throw a `TypeError` first, naming the query, the parameter and its transform. The rendering is unchanged for every non-empty array, and PgTyped still does not invent SQL for the empty one: there is no text that means "zero rows" in every position, since `IN (NULL)` is right for `IN` and would insert a row for `VALUES`. Branch on the array being empty before calling, and set [`nonEmptyArrayParams`](https://pgtyped.dev/docs/cli#configuration-file-format) if you want the empty _literal_ caught at compile time as well — its default has not changed.

- **An ambient `PG*` variable that displaces an explicit config value is reported.** `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGPORT`, `PGURI` and `DATABASE_URL` still take precedence over the config file — that has not changed, and nothing that worked stops working. What changed is that it is no longer silent: a shell with `PGDATABASE=prod` exported used to replace an explicit `dbUrl` and generate types against the wrong schema without a word. A variable that fills in something the config left unset, or that agrees with it, stays quiet. If a `PG*` variable overriding the config is deliberate — a container whose database is not where the config file says — pass the connection as `--uri`, or `PGTYPED_URI`, which takes precedence over both and says so.

### Two smaller behaviour changes

- **Mid-statement block comments are kept in the statement text** rather than blanked out. Because a query's prepared statement name is a hash of its text, editing a comment inside a query renames its statement. That is harmless — it just means a fresh `Parse` — but it is why an unrelated-looking comment edit changes generated output.
- **In `sql` tags, `$$` introduces a spread parameter**, and the tag parser does no dollar-quote handling, so a dollar-quoted body cannot be written in a tag: `AS $$SELECT 1$$` is read as a spread parameter named `SELECT`. (A body starting with whitespace, `AS $$ SELECT 1 $$`, survives by accident; do not rely on it.) Move such statements into a `.sql` file, where the parameter sigil is `:` and `$$ ... $$` is recognised as a quoted string.

---

This package is part of the PgTyped project.  
Refer to the root [README](https://github.com/pelotech/pgtyped) for details.
