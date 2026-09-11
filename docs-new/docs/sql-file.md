---
id: sql-file
title: Annotated SQL files
sidebar_label: Annotated SQL files
---

PgTyped supports parsing queries from SQL files, allowing developers to write DB queries in their favourite database IDE.
To help PgTyped generate executable queries from these SQL files, they need to be annotated with special comments.

```sql title="example.sql"
/* @name getAllComments */
SELECT * FROM book_comments WHERE id = :commentId;

/*
  @name selectSomeUsers
  @param ages -> (...)
*/
SELECT FROM users WHERE age in :ages;
```

## Annotation format

PgTyped has a number of requirements for SQL file contents:

1. Each query must be preceded with an annotation (comment).
2. An annotation must open with the `@name` tag, which specifies the query name. Only whitespace and the `*` that decorates a multi-line comment may come before it, so a comment that starts with prose — `/* Get all users. @name GetUsers */` — is not read as an annotation at all. Put the prose after the tags, or in a comment of its own above the block.
3. Each query must be a single SQL statement. Statements are separated by semicolons; the last statement in a file may leave its semicolon off.
4. Queries can contain parameters. Parameters should start with a colon, ex. `:paramName`.
5. Annotations can include param expansions if needed using the `@param` tag.
6. Parameters can be forced to be not nullable using an exclamation mark `:paramName!`.
7. Nullability on output columns can be specified in the annotation using the `@column` tag, ex. `@column name!` or `@column name?`.
8. Keys of a `@param` expansion can carry a Postgres type, ex. `@param rows -> ((id::int4, val::text)...)`, which is rendered into the query as a cast. See [Typing the keys of a pick](#typing-the-keys-of-a-pick).

## Parameter expansions

Parameter expansions allow the user to pass arrays and objects as query parameters.
This allows to build more complicated queries, which would be impossible or would look too big if they used only scalar parameters.

For example, with parameter expansions a typical insert query looks like this:

```sql
/*
  @name InsertComment
  @param comments -> ((userId, commentBody)...)
*/
INSERT INTO book_comments (user_id, body)
VALUES :comments;
```

Here `comments -> ((userId, commentBody)...)` is a parameter expansion that instructs pgtyped to expand `comments` into an array of objects with each object having a `userId` and `commentBody` field.

A query can also contain multiple expansions if needed:

```sql
/*
  @name selectSomeUsers
  @param ages -> (...)
  @param names -> (...)
*/
SELECT FROM users WHERE age in :ages or name in :names;
```

At the moment, PgTyped supports three expansion types:

### Array spread

The array spread expansion allows to pass an array of scalars as parameter.

#### Syntax:

```
@param paramName -> (...)
```

#### Example:

```sql title="Query definition:"
/*
  @name selectSomeUsers
  @param ages -> (...)
*/
SELECT FROM users WHERE age in :ages;
```

```ts title="Execution:"
selectSomeUsers.run(connection, { ages: [25, 30, 35] });
```

```sql title="Resulting query:"
-- Parameters: [25, 30, 35]
SELECT FROM users WHERE age in ($1, $2, $3);
```

### Object pick

The object pick expansion allows to pass an object as a parameter.

#### Syntax:

```
@param paramName -> (name, age)
```

#### Example:

```sql title="Query definition:"
/*
  @name insertUsers
  @param user -> (name, age)
*/
INSERT INTO users (name, age) VALUES :user RETURNING id;
```

```ts title="Execution:"
insertUsers.run(connection, { user: { name: 'Rob', age: 56 } });
```

```sql title="Resulting query:"
-- Bindings: ['Rob', 56]
INSERT INTO users (name, age) VALUES ($1, $2) RETURNING id;
```

### Array spread and pick

The array spread-and-pick expansion allows to pass an array of objects as a parameter.

#### Syntax:

```
@param paramName -> ((name, age)...)
```

#### Example:

```sql title="Query definition:"
/*
  @name insertUsers
  @param users -> ((name, age)...)
*/
INSERT INTO users (name, age) VALUES :users RETURNING id;`;
```

```ts title="Execution:"
insertUsers.run(connection, {
  users: [
    { name: 'Rob', age: 56 },
    { name: 'Tom', age: 45 },
  ],
});
```

```sql title="Resulting query:"
-- Bindings: ['Rob', 56, 'Tom', 45]
INSERT INTO users (name, age) VALUES ($1, $2), ($3, $4) RETURNING id;
```

### Typing the keys of a pick

Every expansion above renders bare `$n` placeholders and lets Postgres work out what they are. That
works everywhere the placeholder sits in a position with a known type — an `INSERT` column list, a
comparison against a column — and it does not work in one place: a `VALUES` list inside a
sub-select.

```sql
UPDATE foo f SET val = item.val
FROM (VALUES :foos) AS item(id, val)
WHERE f.id = item.id;
```

Postgres has to give a sub-select's columns concrete types before it typechecks anything downstream,
and a `VALUES` list resolves its columns from its own rows and nothing else. Every row here is an
`unknown` parameter, so the `unknown` → `text` fallback fires and locks in: `item.id` is `text`,
`id` is generated as `string`, and the query fails at run time with
`42883 operator does not exist: integer = text`.

Write a cast on the key to pin it:

```sql title="Query definition:"
/*
  @name UpdateFoos
  @param foos -> ((id!::int4, val!::text)...)
*/
UPDATE foo f SET val = item.val
FROM (VALUES :foos) AS item(id, val)
WHERE f.id = item.id;
```

```ts title="Execution:"
updateFoos.run(connection, {
  foos: [
    { id: 1, val: 'a' },
    { id: 2, val: 'b' },
  ],
});
```

```sql title="Resulting query:"
-- Bindings: [1, 'a', 2, 'b']
UPDATE foo f SET val = item.val
FROM (VALUES ($1::int4,$2::text),($3,$4)) AS item(id, val)
WHERE f.id = item.id;
```

```ts title="Resulting code:"
export interface UpdateFoosParams {
  foos: readonly {
    id: number;
    val: string;
  }[];
}
```

Only the first row carries the casts. Postgres resolves a `VALUES` list column-wise, so a type
pinned in the first row types the whole column — repeating the cast on every row would say the same
thing once per element of your array.

PgTyped does not interpret the type name. It puts the cast in the SQL, the server reports the
resulting OID in its parameter description, and codegen maps that OID exactly as it maps any other.
So the type you write is a **Postgres** type name, not a TypeScript one, and any type the mapping
already knows works.

#### The type grammar

A key type is an identifier, optionally schema-qualified, with any number of `[]` suffixes:
`int4`, `text`, `timestamptz`, `public.my_enum`, `text[]`. Nothing else is accepted, because the
text goes into the SQL verbatim.

That rules out the multi-word spellings and the length modifiers, and neither one costs you
anything: every multi-word type has a single-word alias (`timestamptz`, `varchar`, `float8`,
`numeric`), and a modifier such as `numeric(10,2)` cannot change the OID the server reports. A type
outside the grammar is a parse error naming the query and the offending key, so a typo is never
silently passed through to Postgres.

#### Combining with the `!` marker

`!` comes **before** the cast — `id!::int4`. The marker always sits directly on the name it
qualifies, which is how it already reads on a scalar reference: `:id!::int4` has always been a
required parameter with a cast after it. `id::int4!` is rejected, by name:

```
Cannot parse transform for @param foos: Key "id::int4!" writes "!" after the cast;
a required typed key is "id!::int4", with "!" on the name
```

Key types combine with everything `!` already does: a key without it stays optional in the
generated interface, and one with it is required.

:::note
A plain `INSERT INTO t (a, b) VALUES :rows` never needed this. The columns of the target table give
the placeholders their types directly, so it has always generated correctly. Reach for a key type
when the `VALUES` list is inside a sub-select — `FROM (VALUES :rows) AS t(...)`, a CTE, a
`USING (VALUES :rows)` — which is the only place the fallback bites.
:::

:::caution
Casting **outside** the `VALUES` row does not fix it, and fails silently. Writing
`WHERE f.id = item.id::int4` or `SET val = item.val::text` describes successfully and generates
`id: string` for an integer column — the cast is applied to the already-`text` column of the
sub-select, so the parameter is still `text` and the type PgTyped reports is a true description of
the statement you sent. The cast has to be on the key, inside the row.
:::

#### Alternatives that need no new syntax

Two other shapes solve the same problem and are worth knowing, because for some queries they are the
better answer.

**Parallel arrays through `unnest`.** Pass one array per column, each cast at the call site:

```sql title="Query definition:"
/* @name UpdateFoos */
UPDATE foo f SET val = u.val
FROM unnest(:ids!::int4[], :vals!::text[]) AS u(id, val)
WHERE f.id = u.id;
```

```ts title="Resulting code:"
export interface UpdateFoosParams {
  ids: numberArray;
  vals: stringArray;
}
```

This is clean, correctly typed, and **better than a key type for a large batch**: the whole update
travels as two array parameters however many rows it carries, where a spread-and-pick renders one
placeholder per value and sends `rows × columns` of them. What it costs is the call shape — you
build parallel arrays rather than an array of objects, and it is on you to keep them the same length
and in the same order.

**A literal seed row.** Put one row of literals in front of the parameter to type the columns, then
skip it:

```sql
/*
  @name UpdateFoos
  @param foos -> ((id!, val!)...)
*/
UPDATE foo f SET val = item.val
FROM (VALUES (0, ''), :foos OFFSET 1) AS item(id, val)
WHERE f.id = item.id;
```

The literals give the columns their types, and the array-of-objects call shape is preserved exactly.
It is ugly, it puts a dummy row in your query, and it leans on `OFFSET` without an `ORDER BY` —
which Postgres does not contractually order. A `VALUES` list is emitted in written order in
practice, and this does work, but nothing in the standard or the documentation promises the row
skipped is the seed row. Prefer a key type.

### Enforcing non-nullability for parameters

Sometimes you might want to force pgTyped to use a non-nullable type for a nullable parameter.
This can be done using the exclamation mark modifier `:paramName!`.

#### Example:

```sql title="Query definition:"
/* @name GetAllComments */
SELECT * FROM book_comments WHERE id = :id OR user_id = :id;

/* @name GetAllCommentsStrict */
SELECT * FROM book_comments WHERE id = :id! OR user_id = :id;
```

```ts title="Resulting code:"
export interface GetAllCommentsParams {
  id?: number | null | void;
}

export interface GetAllCommentsStrictParams {
  id: number;
}
```

## Enforcing (non)-nullability on output columns

Sometimes you want to force pgTyped to use a (non-)nullable type for an output column, because Postgres limits how much
information can be automatically discovered. This is common with aggregates, materialized views and function calls.

Write a `@column` line in the query's annotation block. `@column name!` makes the column non-nullable, `@column name?`
makes it nullable, and either one overrides whatever the catalog reported.

#### Example:

```sql title="Query definition:"
/*
  @name CountBooksTotal
  @column total!
*/
SELECT count(*)::int AS total FROM books;

/*
  @name GetUsersAndTheirNames
  @column name?
*/
SELECT id, name FROM users LEFT JOIN names USING (id);
```

```ts title="Resulting code:"
export interface CountBooksTotalResult {
  total: number;
}
export interface GetUsersAndTheirNamesResult {
  id: number;
  name: string | null;
}
```

:::caution
The name in `@column` is the **Postgres result column name**, exactly as the server reports it and **before**
`camelCaseColumnNames` is applied. For `SELECT count(*) AS total_count`, write `@column total_count!`, not
`@column totalCount!`. A hint whose name matches no result column is silently ignored, so a mismatch shows up as a type
that is still nullable rather than as an error.
:::

:::note
In PgTyped 2.x these hints were written as column aliases: `SELECT ... AS "total!"`. The suffix went to Postgres
verbatim, so the server returned a column literally called `total!`, and the runtime stripped the trailing `!` off every
row key on the way back. 3.0 does no such rewriting: write a plain alias and add a `@column` line. An alias left as
`AS "total!"` now really names the column `total!` in the rows.

The generated type depends on `camelCaseColumnNames`. With it **off** the field is `"total!"` as well, so the type
matches the rows and the odd name gives the problem away. With it **on**, `camelCase('total!')` is `'total'`: the type
declares `total`, the rows still arrive under `total!`, and `row.total` is silently `undefined`. Codegen therefore
warns on any result column whose name ends in `!` or `?` — in `.sql` files and in `sql` tags alike — naming the column
and the `@column` line to add; `failOnError` turns the warning into a failed run.
See [Upgrading from 2.x](https://github.com/pelotech/pgtyped/tree/HEAD/packages/runtime/README.md#upgrading-from-2x).
:::

`@column` also works in `sql` tags in TS files, in a leading block comment:

```ts
const countBooksTotal = sql<CountBooksTotalQuery>`
  /* @column total! */
  SELECT count(*)::int AS total FROM books`;
```

:::note
We will be adding more annotation tags and expansion types in the future.  
If you have an idea for a new expansion type, or a new annotation tag, please submit an issue for that so we can consider it.
:::
