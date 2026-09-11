---
id: cli
title: CLI Usage and Configuration
sidebar_label: CLI Usage and Configuration
---

`pgtyped` CLI can be launched in build or watch mode.
Watch mode is most useful for a local development workflow,
while build mode can be used for generating types when running CI.

:::note
Codegen connects to your database through [node-postgres](https://github.com/brianc/node-postgres) and asks Postgres to describe each query, so the CLI needs a reachable database with your schema applied. It is not a static analyser: without a database it cannot run.
:::

### Flags

The CLI supports a number of flags:

- `--config config_file_path.json` to pass the config file path.
- `--watch` to start in watch mode.
- `--file file_path.ts` if you only want to process one file (which can be useful when working on a big project). Incompatible with watch mode. Uses transforms defined in the config file to determine the mode and emit template, so a file path that doesn't fit the include glob patterns will not be processed, and the run exits non-zero. The path is resolved against the working directory, so any spelling of it works: `src/q.sql`, `./src/q.sql` and an absolute path are the same file.
- `--uri` to specify a PG connection URI (overriding the config value).
- `--help` for a quick flag reference.
- `--version` to show the version number.

```shell script title="Example:"
npx pgtyped -w -c config.json
```

### Exit codes

The CLI exits `0` only when the run succeeded, so CI can rely on it:

| Situation                                                              | Exit code |
|------------------------------------------------------------------------|-----------|
| Codegen completed                                                        | `0`       |
| Watch mode ended because the config file changed (restart it to pick the change up) | `0`       |
| The config file is missing, unparseable, or has an unrecognised key     | `1`       |
| The database could not be reached, or refused the credentials            | `1`       |
| A file or query failed and `failOnError` is set                          | `1`       |
| `--file` named a path no transform covers                                | `1`       |

Every failure is reported on stderr.

The database connection is verified once, before any file is processed. If it fails, no file is written: a query PgTyped cannot describe is normally emitted as the `never` type, and without this check an unreachable database would replace correct generated output with `never` for every query.

### Environment variables

PgTyped supports common PostgreSQL environment variables:

- `PGHOST`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`
- `PGPORT`
- `PGURI` or `DATABASE_URL`

These variables will override values provided in `config.json`.

That precedence is deliberate and is not changing, but it is no longer silent. When one of them
displaces a value the config file set **explicitly**, PgTyped says so, naming the variable and the
field it replaced:

```
Warning: environment variable PGDATABASE overrides dbName from the config file: "prod" replaces
"app_dev", set by dbUrl. Environment variables take precedence over the config file, so that is what
PgTyped will connect with — unset PGDATABASE if it is not what you meant.
```

The case worth catching is a *valid but wrong* value — a shell with `PGDATABASE=prod` exported
generates types against the wrong schema and connects perfectly happily while doing it. Only a
genuine conflict is reported: a variable that fills in something the config left unset is the
intended way to configure PgTyped from the environment and stays quiet, as does one that agrees with
the config. `--uri` still beats both, and naming the connection there is the way to say that
overriding the config is deliberate.

Every CLI flag can also be set from an environment variable, named after the flag with a `PGTYPED_` prefix: `PGTYPED_CONFIG`, `PGTYPED_WATCH`, `PGTYPED_URI` and `PGTYPED_FILE`.

:::caution
The prefix is new in 3.0. Before it, the variables were unprefixed — so an ambient `FILE` (or `CONFIG`, or `URI`) set the corresponding flag, and a run could quietly generate nothing because something unrelated in the environment happened to use that name. If you were relying on the unprefixed form, add the prefix.
:::

#### `PGOPTIONS`, and setting a `search_path`

There is no `search_path` config option, but as of 3.0 you do not need one. The connection is made by node-postgres,
which reads `PGOPTIONS` and forwards it to the server as libpq does, so command-line options set there apply to the
session codegen runs its `DESCRIBE` calls on:

```shell script
PGOPTIONS='-c search_path=tenant1' npx pgtyped -c config.json
```

With that set, a query written as `SELECT id, label FROM widgets` resolves against `tenant1.widgets` and gets types from
it; without it the same query fails with `relation "widgets" does not exist`. Any other `-c name=value` option works the
same way — `PGOPTIONS='-c search_path=tenant1 -c statement_timeout=5000'` sets both.

`PGOPTIONS` is read by node-postgres rather than by PgTyped, so it applies to your application's connections too, not
just to codegen. Set it in both places if your queries depend on a non-default `search_path`: the types are generated
against whatever schema codegen saw, and nothing checks that the application later connects the same way.

### Using other environment variables

The variables above are the only ones PgTyped reads by name. To take a connection field from a
variable of your own — `MYAPP_DB_HOST`, or whatever your CI already exports — write the config as a
CommonJS module instead of JSON. `parseConfig` loads it with `require`, so any module that exports a
config object works:

```js title="pgtyped.config.cjs"
module.exports = {
  transforms: [
    { mode: 'sql', include: '**/*.sql', emitTemplate: '{{dir}}/{{name}}.queries.ts' },
  ],
  srcDir: './src/',
  db: {
    host: process.env.MYAPP_DB_HOST ?? 'localhost',
    port: Number(process.env.MYAPP_DB_PORT ?? 5432),
    user: process.env.MYAPP_DB_USER,
    password: process.env.MYAPP_DB_PASSWORD,
    dbName: process.env.MYAPP_DB_NAME,
  },
};
```

Then `pgtyped -c pgtyped.config.cjs`.

This is deliberately not a templating syntax. A JavaScript config gives you defaults, string
composition, a `Number()` for the port, a different branch per environment, and reading a value out
of a mounted secrets file — none of which a `{{VAR}}` placeholder in JSON could express.

**Use the `.cjs` extension.** A `.js` config works only in a package that is not `"type": "module"`;
in an ESM package it fails to load as CommonJS and surfaces as a confusing validation error about
missing fields rather than a module-format one. `.cjs` is unambiguous and works either way.

The precedence above still applies: a `PG*` variable overrides a field the config set, whether the
config is JSON or JavaScript, and warns when it does.

### Example configuration file

Below is an example configuration file, with comments explaining each field.  
For a full list of options, see the [Configuration file format](#configuration-file-format) section.  

```js title="config.json"
{
  // You can specify as many transforms as you want
  // Only TS and SQL files (modes) are supported at the moment
  "transforms": [
    {
      "mode": "sql", // SQL mode
      "include": "**/*.sql", // SQL files pattern to scan for queries
      "emitTemplate": "{{dir}}/{{name}}.queries.ts" // File name template to save generated files
    },
    {
      "mode": "ts", // TS mode
      "include": "**/action.ts", // TS file pattern to scan for queries
      "emitTemplate": "{{dir}}/{{name}}.types.ts" // File name template to save generated files
    }
  ],
  "srcDir": "./src/", // Directory to scan or watch for query files (relative to the working directory, not to this file)
  "failOnError": false, // Whether to fail on a file processing error and abort generation (can be omitted - default is false)
  "camelCaseColumnNames": false, // convert to camelCase column names of result interface
  "hungarianNotation": false, // Whether to prefix generated interface names with "I"
  "nonEmptyArrayParams": false, // Whether the type for an array parameter should exclude empty arrays (an empty array has no SQL to render, and throws)
  "optionalNullParams": true, // Whether a parameter that is not marked "!" is an optional member of the params type, so leaving it out is a silent NULL; false makes it a required member that still accepts null
  "preparedStatements": true, // Whether to give each eligible query a server-side prepared statement name
  "checkPrivileges": false, // Whether to also check that the connecting role is allowed to execute each query (costs one round trip per query)
  "sharedTypesFile": "pgtyped-shared.ts", // Where the type aliases every generated file shares are declared, relative to srcDir; false to declare them in each file instead
  "dbUrl": "postgres://user:password@host/database", // DB URL (optional - will be merged with db if provided)
  "db": {
    "dbName": "testdb", // DB name
    "user": "user", // DB username
    "password": "password", // DB password (optional)
    "host": "127.0.0.1", // DB host (optional)
    "port": 5432, // DB port (optional)
    "ssl": false // Whether or not to connect to DB with SSL (optional)
  },
  "typesOverrides": { // Override default Postgres => TypeScript mapping
    "date": "string", 
    "timestamptz": "string", 
    "numeric": "number", 
    "my_enum": "./path/to/enums#MyEnum" // Will import MyEnum from ./path/to/enums
  }
}
```

:::note
Configuration file can be also be written in CommonJS format and default exported as an object. If your project is of ESM type then you will need to give the config file a `.cjs` extension instead of `.js`.
:::

:::caution
Unrecognised config keys are an error, at every level of the file. A key that PgTyped does not know about used to be ignored silently; since 3.0 it fails the run, so a typo such as `camelCaseColumNames`, or `db.dbname` for `db.dbName`, is reported instead of being quietly dropped. The error names the full path to the key. The one exception is `db.ssl`, whose contents are passed to node's TLS stack untouched.
:::

### Configuration file format

| Name                    | Type                     | Description                                                                                                                                                                |
|-------------------------|--------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `transforms`            | `Transform[]`            | An array of transforms to apply to the files.                                                                                                                              |
| `srcDir`                | `string`                 | Directory to scan or watch for query files. A relative path is resolved against the working directory the CLI was started in, **not** against the location of the config file — so running the CLI from elsewhere with an absolute `--config` path will look in the wrong place. PgTyped warns when a transform's glob matches no files. |
| `db`                    | `DatabaseConfig`         | A database config.                                                                                                                                                         |
| `failOnError?`          | `boolean`                | Whether to fail on a file processing error and abort generation. Also promotes every codegen warning into a failure, whichever kind of file the query lives in: a `sql.prepared` name or type argument that does not match the variable holding it, a result column left with a 2.x nullability suffix, an `@param` declared in a `.sql` file but never used by the statement, a `:name` written inside a dollar-quoted body, where Postgres reads it as literal text and no parameter is generated, and — with `checkPrivileges` on — a query the connecting role may not execute. It covers a column or parameter whose Postgres type the mapping does not know (`Postgres type 'record' is not supported by mapping`), which is otherwise reported and generated as `unknown`. **Default:** `false`                                                                                      |
| `dbUrl?`                | `string`                 | A connection string to the database. Example: `postgres://user:password@host/database`. Overrides (merged) with `db` config.                                               |
| `camelCaseColumnNames?` | `boolean`                | Whether to convert column names to camelCase. _Note that this only coverts the types. You need to do this at runtime independently using a library like `pg-camelcase`_.   |
| `nonEmptyArrayParams?`  | `boolean`                | Whether the types for array parameters exclude empty arrays, by typing them `readonly [T, ...T[]]`. A spread renders one placeholder per element, so an empty array has no SQL to render at all: it used to reach the server as `IN ()` and come back as `42601 syntax error at or near ")"`, and now throws before anything is sent, naming the parameter. This option moves the same mistake to compile time — but only for an array literal, since it cannot see the length of one built at runtime. **Default:** `false` |
| `optionalNullParams?`   | `boolean`                | Whether a parameter that is not marked `!` is emitted as an *optional* member of the params type. On the default, `id?: string \| null \| void`: forgetting to pass `id` compiles, and the query runs with `id` bound to NULL. Set to `false` and the same parameter becomes `id: string \| null` — still nullable, but the caller has to say so, and an omitted parameter is a compile error. The `\| void` goes with the `?`: it only ever existed so the key could be left out. It governs pick keys the same way, so `(line1!, line2)` emits `line2?: string \| null \| void` or `line2: string \| null` to match; an array parameter's element type is unaffected either way, since an element is not a key anyone can omit. The trade-off is that `false` is not a free switch — every params object that relied on omitting a parameter has to be updated. Also answers upstream issue #556. **Default:** `true` |
| `hungarianNotation?`    | `boolean`                | Whether to prefix generated interface names with `I`, so `FindBookByIdResult` becomes `IFindBookByIdResult`. **Default:** `false`                                          |
| `preparedStatements?`   | `boolean`                | Whether to give each eligible query a server-side prepared statement name. See [Prepared statements](#prepared-statements). **Default:** `true`                            |
| `checkPrivileges?`      | `boolean`                | Whether to check that the connecting role is allowed to *execute* each query, not merely to describe it. See [Checking privileges](#checking-privileges). **Default:** `false` |
| `sharedTypesFile?`      | `string` or `false`      | Where the type aliases every generated file shares — enum unions, array aliases, driver types such as `PgInterval`, and the imports `typesOverrides` produces — are declared. A path relative to `srcDir`, or `false` to have each generated file declare its own copy of every alias it needs, as PgTyped did before 3.0. See [Shared types](#shared-types). **Default:** `"pgtyped-shared.ts"` |
| `typesOverrides?`       | `Record<string, string>` | A map of type overrides, **keyed by Postgres type name** — including a domain's name, which is why `CREATE DOMAIN` is the way to give one column a type of its own. A key containing a dot (`"lobbies.status"`) is rejected: column-scoped overrides are not supported, and used to be accepted and then ignored. Similarly to `camelCaseColumnNames`, this only affects the types. _You need to do this at runtime independently using a library like `pg-types`._ |

Fields marked with `?` are optional.

#### Transform

| Name           | Type     | Description                                                                                                                             |
|----------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `mode`         | `string` | The mode to use. Can be `sql` or `ts`.                                                                                                  |
| `include`      | `string` | A glob pattern to match files to process. Example: `"**/*.sql"`.                                                                        |
| `emitTemplate` | `string` | A template to use for the output file name. See [Customizing generated file paths](#customizing-generated-file-paths) for more details. |

#### DatabaseConfig

| Name        | Type                                | Description                                                                                                                                                                                                                                                                                |
|-------------|-------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `host?`     | `string`                            | The database host. Defaults to `127.0.0.1`.                                                                                                                                                                                                                                                |
| `port?`     | `number`                            | The database port. Defaults to `5432`.                                                                                                                                                                                                                                                     |
| `user?`     | `string`                            | The database user. Defaults to `postgres`.                                                                                                                                                                                                                                                 |
| `dbName?`   | `string`                            | The database name. Defaults to `postgres`.                                                                                                                                                                                                                                                 |
| `password?` | `string`                            | The database password. Defaults to empty string.                                                                                                                                                                                                                                           |
| `ssl?`      | `boolean` or `TLSConnectionOptions` | Determines whether to use SSL to connect to the database. Also accepts a TLS connection options object as defined in the Node.js [socket method](https://nodejs.org/api/tls.html#new-tlstlssocketsocket-options). More details on this in the [Configuring SSL](#configuring-ssl) section. |

### Checking privileges

Postgres checks table and column privileges when a statement is **executed**, not when it is parsed or described. Codegen only ever describes: it asks the server for a statement's parameter and result types and never runs it. So a query the connecting role is not allowed to run is typed perfectly well, generates cleanly, and exits 0 —

```sql
/* @name GetSecrets */
SELECT id, value FROM secrets;
```

```ts
export interface GetSecretsResult {
  id: number;
  value: string;
}
```

— and then fails in production with `42501 permission denied for table secrets`. Column-level grants are invisible the same way: with `GRANT INSERT (a, b)` and `GRANT UPDATE (b)`, an `INSERT` that also writes `c`, or an `UPDATE` that also sets `a`, describes without complaint.

`checkPrivileges: true` closes that gap. After describing a query, codegen asks the server to **plan** it as well — `EXPLAIN` without `ANALYZE`, which applies every privilege check and executes nothing. Nothing is written, no sequence advances, and an `INSERT … RETURNING`, `UPDATE` or `DELETE` is as safe to check as a `SELECT`. A `42501` is reported against the query and the file it came from:

```
Query 'GetSecrets' in src/secrets.sql was described successfully, but the role codegen
connected as may not execute it: permission denied for table secrets. Types were still
generated — …
```

The types are still generated, and the run still exits 0. That is deliberate: the SQL is valid and its types are an accurate description of it, so replacing them with `never` — which is what codegen does for a query it cannot describe — would break every call site over something only a `GRANT` can fix. Under [`failOnError`](#configuration-file-format) the same finding fails the run instead, and nothing is written.

#### Why it is off by default

- **It is the wrong question for most projects.** Codegen very often connects as the schema owner or a migration role, while the application connects as a restricted one. Checking the owner's privileges tells you nothing about the application's, and the check would be reassuring for exactly the queries it should not be. Turn it on only when codegen connects as the role that will run the queries in production.
- **It costs a round trip per query,** plus one `SHOW server_version_num` for the run. That is a real cost on a large project against a remote database, and it buys nothing at all in the case above.

#### What it needs, and what it misses

On **PostgreSQL 16 and later** the statement is planned with `EXPLAIN (GENERIC_PLAN)`, which plans `$1` as a parameter rather than as a value. No parameter value is invented, so no query can be reported for a plan that a made-up value produced.

**Before PostgreSQL 16** there is no such option: the only way to plan a parameterised statement is to give it values, so `NULL` is bound for each one. That is still safe and still catches the cases above, but it under-reports one shape — a table reachable only through a branch the planner can fold away, such as `WHERE id = $1 AND EXISTS (SELECT 1 FROM secrets)`, is dropped from the plan along with its privilege check.

The check reports `42501` and nothing else. A statement `EXPLAIN` cannot plan at all — `TRUNCATE`, `CALL`, `SET`, DDL — is passed over in silence rather than reported as a permissions problem; it has already been described successfully, so it is known to be valid SQL. Row-level security is not covered either: an `RLS` policy filters rows at execute time and is not a privilege error.

### Prepared statements

With `preparedStatements` enabled (the default), codegen writes a *statement name* into each generated query, for example `FindBookById_022dda1d`. The runtime passes that name to node-postgres, which issues a server-side `Parse` the first time the query runs on a connection and reuses the parsed, planned statement on every later call over that same connection.

The name is the query's `@name` plus a hash of its SQL text, so editing a query renames it. That matters during a rolling deploy: a long-lived connection that already prepared the old text will not have the new text bound to a stale name.

Codegen deliberately withholds a name from two kinds of query:

- Queries with an **array spread** (`@param ids -> (...)`) or an **array spread and pick** (`@param users -> ((name, age)...)`) parameter. These render a different number of placeholders on every call, so one name would have to stand for many statement texts, which Postgres does not allow. Nothing can override this — not a config option, not a per-call one — and it holds for TS tags with `$$ids` or `$$users(name, age)` just the same.
- Queries written with a plain `sql` tag in a TS file. Inline queries are not prepared unless they ask to be. This one is a default rather than a rule: `sql.prepared('GetAllNotifications')` names the tag explicitly, and `sql.prepared()` derives a name from the statement text, after which the query is prepared like any other. See [Prepared statements](ts-file#prepared-statements) in the Typescript files page.

Queries that end up with no name are simply sent unnamed, and `TypedQuery.name` is `undefined` for them.

For a stable identifier — one that is always present and does not move when the SQL is edited — use `TypedQuery.queryName`, which is the `@name` itself. That is the one to label metrics, spans and slow-query logs with; see the [runtime README](https://github.com/pelotech/pgtyped/tree/HEAD/packages/runtime/README.md#queryname-which-is-not-name).

Setting `preparedStatements: false` withholds a name from every query codegen names. It does not reach a `sql.prepared` tag, which computes its name at runtime. You can also disable naming per call or per connection at runtime; see the [runtime README](https://github.com/pelotech/pgtyped/tree/HEAD/packages/runtime/README.md) for `RunOptions` and `unprepared()`, which are what you want under PgBouncer in transaction-pooling mode.

### Shared types

Most of what a generated file declares belongs to the query above it: `FindBookByIdParams`,
`FindBookByIdResult`. A handful of declarations do not. An enum's string union, an array alias such
as `nullableStringArray`, a driver type such as `PgInterval` or `Json`, and the type a
`typesOverrides` entry imports are all properties of the *schema*, and every query that touches them
needs the same one.

Every generated file used to declare its own copy. Two of them re-exported from one barrel is then a
compile error, because the same name arrives twice:

```ts
export * from './books/books.queries.js';
export * from './notifications/notifications.queries.js';
// error TS2308: Module './books/books.queries.js' has already exported a member named 'Json'.
```

They are declared once instead, in the file `sharedTypesFile` names — `<srcDir>/pgtyped-shared.ts`
by default — and each generated file imports the ones it uses:

```ts title="src/books/books.queries.ts"
/** Types generated for queries found in "src/books/books.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

import type { category, nullableCategoryArray } from '../pgtyped-shared.js';
```

```ts title="src/pgtyped-shared.ts"
/** Types shared by every file PgTyped generates. */
export type category = 'novel' | 'science-fiction' | 'thriller';

export type nullableCategoryArray = (category | null)[];
```

The file is written to `srcDir`, so the import is a relative specifier from wherever the generated
file sits, however deep that is. It is generated output: commit it alongside the rest, and do not
edit it. If nothing in the project needs a shared type at all, no file is written.

:::caution
This changed in 3.0. Code that imported one of these aliases **from a generated file** has to import
it from the shared file instead:

```ts
- import type { PgInterval } from './driverTypes/driverTypes.queries.js';
+ import type { PgInterval } from './pgtyped-shared.js';
```

Per-query types are unaffected — `FindBookByIdParams` and `FindBookByIdResult` are still declared and
exported by the file generated for the query. Setting `sharedTypesFile: false` restores the old
output exactly.
:::

#### When two files disagree

One name can only stand for one definition in the shared file. If two generated files would declare
the same name differently — two schemas with an enum of the same name, say, reached through
different `search_path`s — PgTyped says so rather than silently picking one:

```
Two generated files define the shared type "lobby_status" differently, and
src/pgtyped-shared.ts can only declare one of them:
  export type lobby_status = 'playing' | 'waiting';  (from src/a.queries.ts)
  export type lobby_status = 'closed' | 'open';  (from src/b.queries.ts)
```

The first is what is emitted, chosen by file path so that regeneration stays byte-identical. Under
[`failOnError`](#configuration-file-format) the disagreement fails the run instead. The fix is to
give one of them a name of its own — a `typesOverrides` entry, or a `CREATE DOMAIN` — or to set
`sharedTypesFile: false`.

#### Watch mode, and `--file`

In `--watch`, the shared file is kept in step with the whole session, not just the file in front of
it. An alias survives as long as any watched file still needs it, disappears when the last one stops,
and is released when a query file is **deleted** — along with the declaration file generated from it,
which could not stand on its own once its imports are gone.

`--file` is the one case where the shared file is left alone. That run only describes the file it was
given, so it does not know what the rest of the project still shares and would truncate the union to
one file's worth. If a targeted regeneration introduces a shared type the file does not yet declare,
run codegen without `--file`.

### Customizing generated file paths

By default, PgTyped saves generated files in the same folder as the source files it parses.
This behavior can be customized using the `emitTemplate` config parameter.
In that template, six parameters are available for interpolation: `root`, `dir`, `dir_base` (the last segment of `dir`), `base`, `name` and `ext`.
For example, when parsing source/query file `/home/user/dir/file.sql`, these parameters are assigned the following values:

```
┌─────────────────────┬────────────┐
│          dir        │    base    │
├──────┬              ├──────┬─────┤
│ root │              │ name │ ext │
"  /    home/user/dir / file  .sql "
└──────┴──────────────┴──────┴─────┘
(All spaces in the "" line should be ignored. They are purely for formatting.)
```

### Configuring SSL

By default, if enabled it will attempt to verify the SSL connection with the local certificates on the machine.

Options can also be provided to customize the certificate used or to ignore SSL errors. More information about options can be found [here](https://nodejs.org/api/tls.html#tls_new_tls_tlssocket_socket_options).

Sample configuration files have been provided below.

```js title="custom_ca.json"
{
  "transforms": [
    {
      "mode": "sql",
      "include": "**/*.sql",
      "emitTemplate": "{{dir}}/{{name}}.queries.ts"
    }
  ],
  "srcDir": "./src/",
  "failOnError": false,
  "camelCaseColumnNames": false,
  "db": {
    "dbName": "testdb",
    "user": "user",
    "host": "someremote.host.com",
    "ssl": {
      "host": "someremote.host.com",
      "port": 5432,
      "ca": ["insert CA here"]
    }
  }
}
```

```js title="ignore_ssl.json"
{
  "transforms": [
    {
      "mode": "sql",
      "include": "**/*.sql",
      "emitTemplate": "{{dir}}/{{name}}.queries.ts"
    }
  ],
  "srcDir": "./src/",
  "failOnError": false,
  "camelCaseColumnNames": false,
  "db": {
    "dbName": "testdb",
    "user": "user",
    "host": "someremote.host.com",
    "ssl": {
      "rejectUnauthorized": false
    }
  }
}
```
