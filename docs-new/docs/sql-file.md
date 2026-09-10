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
