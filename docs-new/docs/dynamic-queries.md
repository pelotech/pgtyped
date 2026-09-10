---
id: dynamic-queries
title: Dynamic queries
sidebar_label: Dynamic queries
---

PgTyped doesn't support query composition or concatenation, but this doesn't mean you can't create dynamic queries.
Instead of providing non-typesafe query composition, PgTyped forces you to move the dynamic logic into the SQL layer.

:::caution
A parameter is a **value**, never an identifier. PgTyped compiles `:sortColumn` to a placeholder — `$1` — which the
server fills in with a value; by then parsing has already fixed which tables the statement reads and which columns it
names, and no value can change that. So `ORDER BY :sortColumn`, `SELECT :columnName` and `FROM :tableName` do not do
what they look like they do: the first two silently sort by, or select, a constant string, and the third is a syntax
error. There is no setting that changes this. See [Sorting by a dynamic column](#sorting-by-a-dynamic-column) for what
to write instead.
:::

### Dynamic `WHERE` filters

A frequently used pattern is a query with an optional filter that selects all rows by default.
This can be achieved using an `IS NULL` construct.
Here is an example of a query with optional `name` and `age` filters:

```sql
/* @name FindUsers */
SELECT id, user_name, age FROM users
WHERE (:name::TEXT IS NULL OR user_name = :name)
  AND (:ageGt::INTEGER IS NULL OR age > :ageGt)
ORDER BY id;
```

Each filter is skipped when its parameter is `null`, so `findUsers.run(client, { name: null, ageGt: null })` returns
every row, `{ name: null, ageGt: 20 }` returns only users over 20, and `{ name: 'jane67', ageGt: null }` returns only
that user.

The casts are load-bearing. PgTyped sends parameters with no declared type and lets Postgres infer them, and `$1 IS NULL`
gives it nothing to infer from; because inference works left to right, writing the `IS NULL` test first without a cast
fails with `could not determine data type of parameter $1`. Casting the first mention fixes it whatever the order.

This works because the filter is written over a *value*. Everything the query reads — the table, the columns — is still
written out in the SQL.

### Sorting by a dynamic column

Sorting by a column chosen at runtime is the case where the value/identifier distinction bites, because the broken
version looks like it works:

```sql
/* @name FindUsersBrokenSort */
SELECT id, user_name, age FROM users
ORDER BY :sortColumn;
```

That compiles to `ORDER BY $1` and is sent with `$1 = 'age'`. Postgres sorts by the constant string `'age'`, which is
the same for every row, so the rows come back in whatever order the plan produced them — not sorted by `age` at all.
It raises no error and generates a perfectly ordinary `sortColumn?: string | null | void` parameter, so nothing tells
you it is wrong except the rows.

There are two ways to actually do it.

#### Option 1: write one query per sort order

The simplest and most honest option. Each query is a separate statement with the `ORDER BY` written out, so Postgres
plans each one for exactly the sort it performs and uses an index if one exists:

```sql
/* @name FindUsersByName */
SELECT id, user_name, age FROM users ORDER BY user_name ASC;

/* @name FindUsersByAgeAsc */
SELECT id, user_name, age FROM users ORDER BY age ASC;
```

Then pick the query in TypeScript:

```ts
const sorted = sortColumn === 'age' ? findUsersByAgeAsc : findUsersByName;
const users = await sorted.run(client);
```

The results have the same type, so the choice type-checks. This does not scale to a large grid of columns × directions,
but for the two or three orderings most screens actually offer it is the right answer.

#### Option 2: a `CASE` expression per sortable column

To keep it in one query, compare the parameter — a value — against a string literal, and put the *column* in the `THEN`
arm, where it is an identifier written into the SQL as usual:

```sql
/* @name FindUsersSorted */
SELECT id, user_name, age FROM users
ORDER BY
  CASE WHEN :sortColumn::TEXT = 'user_name' THEN user_name END ASC,
  CASE WHEN :sortColumn::TEXT = 'age' THEN age END ASC;
```

`findUsersSorted.run(client, { sortColumn: 'age' })` sorts by age; `{ sortColumn: 'user_name' }` sorts by name. Each
`CASE` yields `NULL` for every row when its column was not the one asked for, so that sort key is a tie and the next one
decides.

Three things to know about this shape:

- **One `CASE` per column, not one `CASE` with many arms.** All arms of a single `CASE` must share a type, so
  `CASE WHEN … THEN age ELSE user_name END` fails to plan with `CASE types text and integer cannot be matched`. Separate
  `ORDER BY` terms have no such constraint. (Columns that *do* share a type can share a `CASE` if you prefer.)
- **An unrecognised value silently sorts by nothing.** `{ sortColumn: 'no_such_column' }` matches no arm, every key is
  `NULL`, and the rows come back unordered. Postgres cannot validate the string for you, so validate it yourself —
  ideally by typing the parameter as a union in your own code before it reaches `run`.
- **The index only survives while the plan is a custom one.** When Postgres plans with the parameter value in hand it
  folds `CASE WHEN $1 = 'age'` down to `age`, and an index on `age` is used exactly as it would be for option 1. When it
  plans generically — the parameter unknown, which is what a cached plan for a named prepared statement can become — the
  fold is impossible and the plan is a sequential scan and a sort. In practice the planner tends to keep the custom plan
  here, because the generic one is so much worse, but that is its judgement to revisit and option 1 does not depend on
  it.

Add a direction the same way — as a value compared against, with a separate term per direction:

```sql
/* @name FindUsersByAge */
SELECT id, user_name, age FROM users
ORDER BY
  CASE WHEN :descending::BOOLEAN THEN age END DESC,
  CASE WHEN NOT :descending::BOOLEAN THEN age END ASC;
```

`{ descending: false }` returns the youngest user first, `{ descending: true }` the oldest. `ASC`/`DESC` is part of the
statement, not a value, so it cannot be a parameter either — hence one term per direction.

### Dynamic table names

There is no equivalent trick for the table. `FROM :tableName` is a syntax error, and no `CASE` can stand in for a table
reference. Write one query per table, or a query over a `UNION ALL` of the tables with a discriminator column you can
filter on.

### Advanced dynamic queries

More complicated dynamic queries can be built similarly to the above.
Note that highly dynamic SQL queries can lead to worse DB execution times — a plan that has to work for every parameter
value is rarely the best plan for any of them — so it is often worth splitting a complex query into multiple independent
ones.
