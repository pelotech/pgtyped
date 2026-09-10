---
id: faq
title: FAQ
sidebar_label: FAQ
---

### Does PgTyped need a running database?

Yes. It is not a static analyser: it asks Postgres to describe each query, and the schema it describes
against is the one it is connected to. See [CLI Usage and Configuration](cli).

### Is PgTyped an ORM or a query builder?

No. You write SQL; PgTyped generates the TypeScript types for it and nothing else. Queries are sent to
the server exactly as you wrote them, with `:params` replaced by numbered placeholders.

### Do I need `typescript` installed to use the CLI?

Only for `ts` mode transforms, which scan `.ts` files for `sql` tags. It is an optional peer dependency
(`>=5 <7`), loaded on demand: a project whose transforms are all `sql` mode can leave it out.

### Why is one of my columns typed `unknown`?

Its Postgres type is not in PgTyped's mapping, and codegen logs
`Postgres type 'x' is not supported by mapping`. Composite types, user-defined ranges and `record` are
the usual cases. Map it yourself with `typesOverrides`:

```json
"typesOverrides": { "my_type": "string" }
```

See [Type mapping](typing).

### What do generated files import?

`@pelotech/pgtyped-runtime`, and — for a `bytea` column — `node:buffer`. Everything else is declared in
the generated file itself, including the object shapes for `interval` and `point`. Nothing else is
pulled in, so generated code runs anywhere the runtime does.

### Why does an empty array parameter fail at runtime?

A spread parameter renders one placeholder per element, so an empty array renders nothing between the
parens — `IN ()`, or `VALUES ()` for a spread-and-pick — which is a syntax error. There is no SQL
that means "zero rows" in every position (`IN (NULL)` is right for `IN` and wrong for `VALUES`, where
it would insert a row), so PgTyped cannot rewrite it for you.

It does refuse it early. `run`, `execute` and `compile` throw before anything is sent, naming the
query, the parameter and its transform:

```
Query selectSomeUsers was passed an empty array for parameter "ids" (array_spread): a spread renders
one placeholder per element, and there is no SQL for zero of them …
```

That replaces the server's `42601 syntax error at or near ")"`, which pointed at a paren in SQL you
never wrote. Branch on `length` before running the query. Set `nonEmptyArrayParams: true` to type
such parameters as `readonly [T, ...T[]]` and catch the empty *literal* at compile time — an array
whose length is only known at runtime is still caught by the throw.

### How do I generate types against a non-default schema?

Set `PGOPTIONS`, which node-postgres forwards to the server:

```shell script
PGOPTIONS='-c search_path=tenant1' npx pgtyped -c config.json
```

Set it for your application's connections too — nothing checks that the application connects the same
way codegen did. See [`PGOPTIONS`, and setting a `search_path`](cli#pgoptions-and-setting-a-search_path).

### Why does my `srcDir` match nothing when I run the CLI from another directory?

`srcDir` is resolved against the working directory, not against the config file, so an absolute
`--config` path pointing at a project elsewhere still looks for query files under wherever you happen
to be. PgTyped warns when a transform's glob matches no files. Run the CLI from the directory the
config's `srcDir` is written relative to.

### I upgraded from 2.x and my column names or types changed. What moved?

Nullability hints moved from column aliases (`AS "total!"`) to `@column` annotations, six type mappings
were corrected to what node-postgres actually returns, and the argument order of `run` changed. The
full list, with the migration for each, is in the
[Upgrading from 2.x](https://github.com/pelotech/pgtyped/blob/HEAD/packages/runtime/README.md#upgrading-from-2x)
section of the runtime's README.
