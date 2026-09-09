---
id: features
title: Features
sidebar_label: Features
---

- **Typesafe SQL** - Automatically generate TS types for parameters/results of SQL queries of any complexity.
- **SQL file support** - Extract queries from both SQL and TS files.
- **Watch mode** - Generate query types as you write them.
- **Interpolation helpers** - Useful parameter interpolation helpers for arrays and objects.
- **Single source of types** - No need to define your DB schema in TypeScript, your running DB is the live source of type data.
- **Prevents SQL injections** - PgTyped doesn't do explicit parameter substitution. Instead, queries and parameters are sent separately to the DB driver, allowing parameter substitution to be safely done by the PostgreSQL server.
- **ESM only** - PgTyped is written in TypeScript and ships as ESM. The runtime and the generated code are ESM too, and the runtime has no dependencies of its own.
- **Prepared statements** - Queries written in `.sql` files are sent as server-side prepared statements by default, so Postgres parses and plans each one once per connection.
