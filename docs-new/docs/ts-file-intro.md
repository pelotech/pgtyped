---
id: ts-file-intro
title: SQL-in-TS
sidebar_label: Queries in TS files
---

It sometimes makes sense to inline your queries instead of collecting them in separate SQL files.
PgTyped supports inlined queries using the `sql` template literal.
To see how that works lets write some queries in `users/queries.ts`:

```ts title="users/queries.ts"
import { sql } from '@pelotech/pgtyped-runtime';

export const selectUserIds = sql`select id, age from users where id = $id and age = $age`;
```

PgTyped parses your TS files, scanning them for `sql` queries and generating corresponding TS interfaces in `users/queries.types.ts`:

```ts title="users/queries.types.ts"
/** Types generated for queries found in "users/queries.ts" */

/** 'selectUserIds' parameters type */
export interface SelectUserIdsParams {
  id?: string | null | void;
  age?: number | null | void;
}

/** 'selectUserIds' return type */
export interface SelectUserIdsResult {
  id: string;
  /** Age (in years) */
  age: number | null;
}

/** 'selectUserIds' query type */
export interface SelectUserIdsQuery {
  params: SelectUserIdsParams;
  result: SelectUserIdsResult;
}
```

We can now pass the `SelectUserIdsQuery` as a generic parameter to our query in `users/queries.ts`:

```ts title="users/queries.ts"
import { sql } from '@pelotech/pgtyped-runtime';
import { SelectUserIdsQuery } from './queries.types.js';

export const selectUserIds = sql<SelectUserIdsQuery>`select id, age from users where id = $id and age = $age`;

const users = await selectUserIds.run(connection, {
  id: 'some-user-id',
  age: 34,
});

console.log(users[0]);
```

The connection is the first argument and the parameters the second.

Note that for the `age` column in the result PgTyped has also translated a [Postgres column comment](https://www.postgresql.org/docs/current/sql-comment.html) (`COMMENT ON COLUMN`) to a [TSDoc](https://tsdoc.org/)-style comment. This will appear as a tooltip in your editor if you inspect the relevant property.

For more information on writing queries in TS files checkout the [SQL-in-TS](ts-file) guide.
