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

# Prepared statements

A query written with a plain `sql` tag is sent unnamed, so Postgres parses and plans it on every call. `sql.prepared` opts the query into a server-side prepared statement name — the `@name` a `.sql` query would have carried. It takes the name as an argument, or derives one from the query itself.

```ts
import { sql } from '@pelotech/pgtyped-runtime';
import type {
  GetAllNotificationsQuery,
  CountNotificationsQuery,
} from './notifications.types.js';

// Named: the statement goes out as `GetAllNotifications_2199d77a`.
export const getAllNotifications = sql.prepared<GetAllNotificationsQuery>(
  'GetAllNotifications',
)`
  SELECT * FROM notifications
`;

// Derived: the statement goes out as `pgtyped_f7b4ea6d854099ab`.
export const countNotifications = sql.prepared<CountNotificationsQuery>()`
  SELECT count(*)::int AS total FROM notifications
`;
```

A named statement is the name you passed plus the first eight hex digits of a SHA-256 of the SQL text. A derived one is `pgtyped_` plus the first sixteen. Either way, editing the query changes the hash and so renames the statement, which is what keeps a long-lived pooled connection from executing the text it prepared under the old name during a rolling deploy. `getAllNotifications.name` returns the full name; for a plain `sql` tag it is `undefined`.

## Which form to use

Prefer an explicit name. It is greppable, and it is what you see in `pg_prepared_statements`, in `pg_stat_statements`, and in any error the server raises about the statement — so the identifier leads straight back to the query in your source. The derived form leads back to nothing without hashing candidate statements by hand.

The derived form's advantage is that it costs nothing to adopt: nothing to invent, nothing to keep in sync, no lint to satisfy. It is the cheap way to turn prepared statements on across a file full of existing tags; name the ones that turn out to matter afterwards.

## Why the hashes are different lengths

Eight hex digits with a name, sixteen without. With a name, the name already separates one query from another and the hash only has to separate successive edits of that one query — a handful of versions never approaches 2<sup>32</sup>. With no name, the hash *is* the identifier and has to separate every query in the application: at 32 bits, 10,000 distinct queries collide with probability around 1.2%, and a collision means one query silently executing another's SQL. 64 bits takes that to about 3e-12.

## What codegen checks

Codegen reads an explicit name off the tag rather than off the variable, so the generated types above are `GetAllNotificationsParams`, `GetAllNotificationsResult` and `GetAllNotificationsQuery` however the query is assigned. With no explicit name there is nothing to read, so the types follow the variable, exactly as for a plain `sql` tag.

Because a name and the code around it are easy to get out of step, codegen warns about two kinds of drift. The variable holding a named tag should be `camelCase` of the name:

```
src/notifications/notifications.ts: statement `GetEveryNotification` is held by variable `getAllNotifications`, expected `getEveryNotification`. ...
```

And the tag's type argument should be the `…Query` interface generated for that query — on any tag, prepared or plain, since a stale one still compiles while typing the query as some other query's rows:

```
src/notifications/notifications.ts: query `GetAllNotifications` is typed as `GetNotificationsQuery`, expected `GetAllNotificationsQuery`. ...
```

Writing the pair inline, as `` sql<{ params: …; result: … }>`…` ``, is a supported way to use the tag and has no generated interface to match, so it is not linted.

The types are still correct in both cases, so these are only warnings — unless [`failOnError`](cli#configuration-file-format) is set, which turns them into a failed run.

:::caution
A query with a spread parameter (`$$ids`, `$$users(name, age)`) renders a different number of placeholders on every call, so a single name would have to stand for many different statement texts. Such a query stays unnamed even when you write `sql.prepared`, in either form, exactly as codegen leaves the equivalent `.sql` query unnamed. See [Prepared statements](cli#prepared-statements).
:::

The CLI's `preparedStatements` option does not reach a tag: it gates the names codegen writes into `.sql` queries, while `sql.prepared` computes its name at runtime. To send a prepared tag unnamed, pass `{ prepared: false }` to the call or wrap the connection in `unprepared()`.

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

### Typing the keys of a pick

A pick renders bare `$n` placeholders and lets Postgres work out what they are, which works
everywhere except one place: a `VALUES` list inside a sub-select. Postgres gives a sub-select's
columns concrete types before it typechecks anything downstream, and a `VALUES` list resolves its
columns from its own rows alone — so with every row a parameter, every column falls back to `text`,
`id` is generated as `string`, and the query fails at run time with
`42883 operator does not exist: integer = text`.

Write a cast on the key to pin it. `!` comes before the cast, so a required typed key is
`id!::int4`:

#### Syntax:

```
$$foos(id::int4, val::text)
```

#### Example:

```ts title="Query code:"
const updateFoos = sql<UpdateFoosQuery>`UPDATE foo f SET val = item.val FROM (VALUES $$foos(id!::int4, val!::text)) AS item(id, val) WHERE f.id = item.id`;

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
WHERE f.id = item.id
```

Only the first row carries the casts: Postgres resolves a `VALUES` list column-wise, so a type
pinned in the first row types the whole column.

The type is a **Postgres** type name, not a TypeScript one — PgTyped puts the cast in the SQL and
reads the resulting OID back off the server's parameter description. It must be an identifier,
optionally schema-qualified, with any number of `[]` suffixes; anything else is a parse error naming
the tag and the offending key. The rules, the caveats and the two alternative query shapes are the
same as for `.sql` files and are written out in full under
[Typing the keys of a pick](sql-file#typing-the-keys-of-a-pick).

## Parameter type reference

| Expansion             | Syntax                       | Parameter Type                                             |
| --------------------- | ---------------------------- | ---------------------------------------------------------- |
| Scalar parameter      | `$paramName`                 | `paramName: ParamType`                                     |
| Object pick           | `$paramName(name, author)`   | `paramName: { name: NameType, author: AuthorType }`        |
| Array spread          | `$$paramName`                | `paramName: Array<ParamType>`                              |
| Array pick and spread | `$$paramName(name, author)`  | `paramName: Array<{ name: NameType, author: AuthorType }>` |
| Typed pick key        | `$paramName(id!::int4)`      | `paramName: { id: number }`                                |

## Substitution reference

| Expansion             | Query in TS                     | Query with substituted parameter  |
|-----------------------|---------------------------------|-----------------------------------|
| Simple parameter      | `$parameter`                    | `$1`                              |
| Object pick           | `$object(prop1, prop2)`         | `($1, $2)`                        |
| Array spread          | `$$array`                       | `($1, $2, $3)`                    |
| Array pick and spread | `$$objectArray(prop1, prop2)`   | `($1, $2), ($3, $4), ($5, $6)`    |
| Typed pick key        | `$$objectArray(prop1::int4)`    | `($1::int4), ($2)`                |

## Backslashes: a tag is cooked by JavaScript before Postgres sees it

A template literal is processed by JavaScript first. Every backslash in a tag is a JavaScript escape, and what reaches Postgres is the result — not what you typed:

```ts
// Sends `LIKE 'The_%'`: `\_` cooked to `_`, which is a LIKE wildcard.
const wrong = sql`SELECT * FROM books WHERE name LIKE 'The\_%'`;

// Sends `LIKE 'The\_%'`: an escaped underscore, matching a literal `_`.
const right = sql`SELECT * FROM books WHERE name LIKE 'The\\_%'`;
```

So a backslash meant for Postgres has to be doubled. `\d` must be written `\\d`, or the regex matches the letter `d`; `regexp_replace(name, '\.', '!')` must be written `'\\.'`, or it replaces every character. `'{"p":"x\\y"}'::jsonb` needs four backslashes in the tag to reach the server as the two that JSON wants.

An escape JavaScript does not define is worse than wrong, because such a template has no cooked text at all. `E'\101'` is valid Postgres octal and not a valid JavaScript escape, so the tag throws a `TypeError` as the module is imported. Codegen reports it by name rather than letting it get that far. Double the backslash here too: `E'\\101'`.

Escapes that mean the same thing on both sides are harmless — `E'\n'` is a newline either way, and `E'\x41'` is `A` either way — but the rule is easier to follow than the exceptions.

A `.sql` file has no such rule. Its bytes are read verbatim and handed to Postgres unchanged, so `\d` there is `\d`.

## Limitations

Inside an `sql` tag, `$` is the parameter sigil and `$$` introduces a spread parameter, so a [dollar-quoted string](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING) cannot be written in a tag. There is no dollar-quote handling in the tag parser at all:

```ts
// Does not work: `$$SELECT` is read as a spread parameter named `SELECT`.
const createFn = sql`CREATE FUNCTION f() RETURNS int AS $$SELECT 1$$ LANGUAGE sql`;
```

A body that happens to begin with whitespace (`AS $$ SELECT 1 $$`) survives by accident, because the parameter pattern needs an identifier right after the `$$`. Do not rely on that.

Put statements with a dollar-quoted body in a `.sql` file instead. There the parameter sigil is `:`, and `$$ ... $$` is recognised as a quoted string, including any `;` inside it. A `:name` written inside that body is literal text to Postgres and generates no parameter; codegen warns when it finds one, and [Dollar-quoted bodies](sql-file.md#dollar-quoted-bodies) explains why.
