---
id: ts-file
title: Typescript files
sidebar_label: Typescript files
---

PgTyped also supports parsing queries from TS files.
Such queries must be tagged with an `sql` template literal, imported from `@pelotech/pgtyped-runtime`:

```ts
import { sql } from '@pelotech/pgtyped-runtime';

const getUsersWithComments = sql`
  SELECT u.* FROM users u
  INNER JOIN book_comments bc ON u.id = bc.user_id
  GROUP BY u.id
  HAVING count(bc.id) > $minCommentCount`;
```

:::note
The import is required. PgTyped 2.x had a `ts-implicit` transform mode that injected the tag for you; it was removed in 3.0, and a config that still declares it fails to parse. Use `"mode": "ts"` and import `sql` yourself.
:::

PgTyped will then scan your project for such `sql` tags and generate types for each query, saving the types in a `filename.types.ts` file.
Once the type files have been generated you can import them to type your query:

```ts
import { sql } from '@pelotech/pgtyped-runtime';
import { GetUsersWithCommentsQuery } from './sample.types.js';

const getUsersWithComments = sql<GetUsersWithCommentsQuery>`
  SELECT u.* FROM users u
  INNER JOIN book_comments bc ON u.id = bc.user_id
  GROUP BY u.id
  HAVING count(bc.id) > $minCommentCount!::int`;

const result = await getUsersWithComments.run(client, { minCommentCount: 12 });
```

The connection comes first and the parameters second. A query that declares no parameters has no params slot at all, so it is called as `someQuery.run(client)`; the 2.x shape `someQuery.run(undefined, client)` no longer compiles.

:::caution
Queries built with the `sql` tag are never given a prepared statement name, because only `.sql` files carry the `@name` that codegen builds a canonical name from. If you want a query sent as a server-side prepared statement, put it in a `.sql` file. See [Prepared statements](cli#prepared-statements).
:::

# Expansions

Template literals also support parameter expansions.
Here is how a typical insert query looks like using SQL-in-TS syntax:

```ts
const query = sql`INSERT INTO users (name, age) VALUES $$users(name, age) RETURNING id`;
```

Here `$$users(name, age)` is a parameter expansion.

## Expansions in SQL-in-TS queries

### Array spread

The array spread expansion allows to pass an array of scalars as parameter.

#### Syntax:

```ts
$$paramName;
```

#### Example:

```ts title="Query code:"
const query = sql<QueryType>`SELECT FROM users where age in $$ages`;

query.run(connection, { ages: [25, 30, 35] });
```

```sql title="Resulting query:"
-- Bindings: [25, 30, 35]
SELECT FROM users WHERE age in ($1, $2, $3);
```

### Object pick

The object pick expansion allows to pass an object as a parameter.

#### Syntax:

```
$user(name, age)
```

#### Example:

```ts title="Query code:"
const query = sql<QueryType>`INSERT INTO users (name, age) VALUES $user(name, age) RETURNING id`;

query.run(connection, { user: { name: 'Rob', age: 56 } });
```

```sql title="Resulting query:"
-- Bindings: ['Rob', 56]
INSERT INTO users (name, age) VALUES ($1, $2) RETURNING id;
```

### Array spread and pick

The array spread-and-pick expansion allows to pass an array of objects as a parameter.

#### Syntax:

```
$$user(name, age)
```

#### Example:

```ts
const query = sql`INSERT INTO users (name, age) VALUES $$users(name, age) RETURNING id`;

query.run(connection, {
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

## Parameter type reference

| Expansion             | Syntax                      | Parameter Type                                             |
| --------------------- | --------------------------- | ---------------------------------------------------------- |
| Scalar parameter      | `$paramName`                | `paramName: ParamType`                                     |
| Object pick           | `$paramName(name, author)`  | `paramName: { name: NameType, author: AuthorType }`        |
| Array spread          | `$$paramName`               | `paramName: Array<ParamType>`                              |
| Array pick and spread | `$$paramName(name, author)` | `paramName: Array<{ name: NameType, author: AuthorType }>` |

## Substitution reference

| Expansion             | Query in TS                  | Query with substituted parameter  |
|-----------------------|------------------------------|-----------------------------------|
| Simple parameter      | `$parameter`                 | `$1`                              |
| Object pick           | `$object(prop1, prop2)`      | `($1, $2)`                        |
| Array spread          | `$$array`                    | `($1, $2, $3)`                    |
| Array pick and spread | `$$objectArray(prop1, prop2)`| `($1, $2), ($3, $4), ($5, $6)`    |

## Limitations

Inside an `sql` tag, `$` is the parameter sigil and `$$` introduces a spread parameter, so a [dollar-quoted string](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING) cannot be written in a tag. There is no dollar-quote handling in the tag parser at all:

```ts
// Does not work: `$$SELECT` is read as a spread parameter named `SELECT`.
const createFn = sql`CREATE FUNCTION f() RETURNS int AS $$SELECT 1$$ LANGUAGE sql`;
```

A body that happens to begin with whitespace (`AS $$ SELECT 1 $$`) survives by accident, because the parameter pattern needs an identifier right after the `$$`. Do not rely on that.

Put statements with a dollar-quoted body in a `.sql` file instead. There the parameter sigil is `:`, and `$$ ... $$` is recognised as a quoted string, including any `;` inside it.
