---
id: getting-started
title: Getting Started
sidebar_label: Getting Started
---

### Installation

1. `npm install -D @pelotech/pgtyped-cli`
2. `npm install @pelotech/pgtyped-runtime` (the runtime is the only required runtime dependency for pgtyped, and it has no dependencies of its own)
3. Create a PgTyped `config.json` file.
4. Run `npx pgtyped -w -c config.json` to start PgTyped in watch mode.

`typescript` is an **optional** peer dependency of the CLI, supported at `>=5 <7` and loaded lazily. It is only needed for `ts` mode transforms, which scan `.ts` files for `sql` tags. If all your transforms are `sql` mode, you can leave it out.

Codegen asks your running Postgres to describe each query, so the CLI needs a reachable database with your schema applied. The connection is checked before anything is generated: if the database is unreachable or rejects the credentials, the run fails with a non-zero exit code and no file is written.

### Configuration

PgTyped requires a `config.json` file to run, a basic config file looks like this:

```json title="config.json"
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
    "host": "db",
    "user": "test",
    "dbName": "test",
    "password": "example"
  }
}
```

Refer to the [CLI page](cli) for more info on the config file, available CLI flags and environment variables.

:::caution
Unrecognised config keys are rejected, at every level of the file. If you are upgrading from PgTyped 2.x, a key that was previously ignored — a typo, or a removed option such as `maxWorkerThreads` — will now fail the run with a message naming the key's full path, such as `db.dbname: unrecognized key`, and a non-zero exit code.
:::

:::note
If you are having trouble configuring PgTyped, you can refer to the [example app](https://github.com/pelotech/pgtyped/tree/master/packages/example) for a preconfigured example.  
:::
