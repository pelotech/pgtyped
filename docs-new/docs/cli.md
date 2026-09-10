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
  "preparedStatements": true, // Whether to give each eligible query a server-side prepared statement name
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
| `failOnError?`          | `boolean`                | Whether to fail on a file processing error and abort generation. Also promotes every codegen warning into a failure, whichever kind of file the query lives in: a `sql.prepared` name or type argument that does not match the variable holding it, a result column left with a 2.x nullability suffix, and an `@param` declared in a `.sql` file but never used by the statement. It covers a column or parameter whose Postgres type the mapping does not know (`Postgres type 'record' is not supported by mapping`), which is otherwise reported and generated as `unknown`. **Default:** `false`                                                                                      |
| `dbUrl?`                | `string`                 | A connection string to the database. Example: `postgres://user:password@host/database`. Overrides (merged) with `db` config.                                               |
| `camelCaseColumnNames?` | `boolean`                | Whether to convert column names to camelCase. _Note that this only coverts the types. You need to do this at runtime independently using a library like `pg-camelcase`_.   |
| `nonEmptyArrayParams?`  | `boolean`                | Whether the types for array parameters exclude empty arrays, by typing them `readonly [T, ...T[]]`. A spread renders one placeholder per element, so an empty array has no SQL to render at all: it used to reach the server as `IN ()` and come back as `42601 syntax error at or near ")"`, and now throws before anything is sent, naming the parameter. This option moves the same mistake to compile time — but only for an array literal, since it cannot see the length of one built at runtime. **Default:** `false` |
| `hungarianNotation?`    | `boolean`                | Whether to prefix generated interface names with `I`, so `FindBookByIdResult` becomes `IFindBookByIdResult`. **Default:** `false`                                          |
| `preparedStatements?`   | `boolean`                | Whether to give each eligible query a server-side prepared statement name. See [Prepared statements](#prepared-statements). **Default:** `true`                            |
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

### Prepared statements

With `preparedStatements` enabled (the default), codegen writes a *statement name* into each generated query, for example `FindBookById_ddfa9eb1`. The runtime passes that name to node-postgres, which issues a server-side `Parse` the first time the query runs on a connection and reuses the parsed, planned statement on every later call over that same connection.

The name is the query's `@name` plus a hash of its SQL text, so editing a query renames it. That matters during a rolling deploy: a long-lived connection that already prepared the old text will not have the new text bound to a stale name.

Codegen deliberately withholds a name from two kinds of query:

- Queries with an **array spread** (`@param ids -> (...)`) or an **array spread and pick** (`@param users -> ((name, age)...)`) parameter. These render a different number of placeholders on every call, so one name would have to stand for many statement texts, which Postgres does not allow. Nothing can override this — not a config option, not a per-call one — and it holds for TS tags with `$$ids` or `$$users(name, age)` just the same.
- Queries written with a plain `sql` tag in a TS file. Inline queries are not prepared unless they ask to be. This one is a default rather than a rule: `sql.prepared('GetAllNotifications')` names the tag explicitly, and `sql.prepared()` derives a name from the statement text, after which the query is prepared like any other. See [Prepared statements](ts-file#prepared-statements) in the Typescript files page.

Queries that end up with no name are simply sent unnamed, and `TypedQuery.name` is `undefined` for them.

For a stable identifier — one that is always present and does not move when the SQL is edited — use `TypedQuery.queryName`, which is the `@name` itself. That is the one to label metrics, spans and slow-query logs with; see the [runtime README](https://github.com/pelotech/pgtyped/tree/HEAD/packages/runtime/README.md#queryname-which-is-not-name).

Setting `preparedStatements: false` withholds a name from every query codegen names. It does not reach a `sql.prepared` tag, which computes its name at runtime. You can also disable naming per call or per connection at runtime; see the [runtime README](https://github.com/pelotech/pgtyped/tree/HEAD/packages/runtime/README.md) for `RunOptions` and `unprepared()`, which are what you want under PgBouncer in transaction-pooling mode.

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
