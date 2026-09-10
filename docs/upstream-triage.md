# Upstream triage: every open issue and PR on `adelsz/pgtyped`, checked against 3.0

This is the consolidated result of triaging **70 open issues and 27 open pull requests** on the
upstream repository (`adelsz/pgtyped`) against this fork's 3.0 rewrite.

Read it to answer three questions:

1. **What is still broken here, and how expensive is it to fix?** → [Bugs we still have](#bugs-we-still-have)
2. **What should we take from upstream?** → [Worth adopting from upstream](#worth-adopting-from-upstream)
3. **Is this old report still relevant?** → [Fixed in this fork](#fixed-in-this-fork) and [Not applicable](#not-applicable)

## How this was produced

Every classification below was **reproduced by running it**, not inferred from reading diffs. The
reproductions are kept inline because they are the evidence: inputs, actual outputs, and the traced
root cause. Where something could not be run, it is marked **Unverified** and stays marked.

- Codegen was driven by the built CLI (`packages/cli/lib/index.js`) after `pnpm build`, against live
  PostgreSQL 17 and 16 containers, from scratch projects outside the repo. `packages/example` was
  not modified for any reproduction.
- Runtime behaviour was driven by the built runtime (`packages/runtime/lib`) through `pg`.
- "Regression" and "parity" claims against 2.x were measured by installing upstream
  `@pgtyped/parser@2.4.2` and `@pgtyped/runtime@2.4.2` side by side and diffing old against new on
  the same input — except where noted otherwise.
- Reproductions span commits `2c0bb0a` … `bcc4b07` on `master`. Anything that `bcc4b07`
  ("correct defects found triaging upstream issues against 3.0") subsequently fixed has been moved
  into [Fixed in this fork](#fixed-in-this-fork) and says so.

**A trap worth recording for anyone repeating this:** a native Postgres on the host occupies
`127.0.0.1:5432` and shadows the compose `db` service's published port, so
`dbUrl: …@localhost/postgres` silently talks to the wrong server. Every reproduction here used a
dedicated container on a non-default port.

## Deduplication

Several issues and PRs describe one underlying defect. They are merged into a single entry that
names every source:

| One bug                                          | Reported as                |
| ------------------------------------------------ | -------------------------- |
| Domain types flattened to their base type        | issues #503, #594; PR #637 |
| Non-watch runs watch the config file             | issue #609; PR #616        |
| Type errors name neither file nor query          | issue #526; PR #584        |
| Empty array in a spread renders `IN ()`          | issues #221, #314, #273    |
| No way to type the keys of a `VALUES :rows` pick | issues #498, #517, #630    |
| Array elements typed as non-nullable             | issues #613, #460; PR #614 |
| Bind parameters cannot name a column             | issues #170, #446          |
| `interval` (and five more) mis-mapped            | issue #552; PR #553        |
| Query name not reachable at runtime              | issue #522; PR #580        |

---

# Bugs we still have

## Fixed on this branch

Three of the cheap ones were taken as part of writing this document, and the mis-mapped types were
taken straight after it. They are listed first so nobody re-opens them, with the reproduction that
justified each.

### Non-watch runs watched the config file — issue #609, PR #616 — **FIXED**

`packages/cli/src/index.ts` called `chokidar.watch(configPath, {})` **unconditionally**, before
`parseConfig` even ran, and the handler did `console.log('Config file changed. Exiting.')` followed
by `process.exit(0)`. So a one-shot codegen run that overlapped a config write exited **successfully
having written nothing**.

Reproduced with 400 generated `.sql` files, with codegen stalled by holding `ACCESS EXCLUSIVE` on
the table so the race window was wide:

```
$ (psql ... -c "BEGIN; LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20);") &
$ node packages/cli/lib/index.js -c config.json > run.log 2>&1 &
$ sleep 4 && <rewrite config.json>
```

Actual:

```
Config file changed. Exiting.
exit=0
generated: 0 of 400
tail run.log:
  Processing src/q97.sql
  Processing src/q96.sql
  Config file changed. Exiting.
```

A build step that templates a connection string into the config while codegen runs gets a green
build and absent generated types.

The `exit(0)` was deliberate and its comment justified it as "every time someone edited the config in
watch mode" — which is exactly the case it failed to be limited to. The watcher is now registered
only under `--watch`; watch mode keeps exit 0.

**Unverified, and worth knowing:** upstream's motivating symptom is #609,
`EMFILE: too many open files, watch 'pgtyped-config.ci.json'` in non-watch CI. That could **not** be
reproduced on macOS with `ulimit -n` down to 64 — chokidar 5 on Darwin does not appear to burn a
descriptor per watch the way inotify does. The EMFILE half remains plausible-but-unverified; the
reporter hit it on Linux CI. The 2.x worker-thread pool (Piscina/tinypool) that was the most likely
multiplier is gone regardless — 3.0 runs single-process via `mapConcurrent`.

### Type errors named neither the file nor the query — issue #526, PR #584 — **FIXED**

`packages/cli/src/generator.ts` logged `console.error('Error in query. Details: %o', typeData)` with
`queryName` already in scope and `fileName` not threaded in at all. On the **default**
(`failOnError: false`) path that was the user's only signal, and because files are processed at
`MAX_CONCURRENCY` the `Processing …` lines interleave, so the errors could not be attributed by
ordering either.

Reproduced — two bad queries in a deep tree:

```
$ node packages/cli/lib/index.js -c config.json
Processing src/deep/nested/b.sql
Processing src/deep/nested/a.sql
Error in query. Details: {
  errorCode: '42P01',
  message: 'relation "no_such_table" does not exist',
  hint: undefined,
  position: '15'
}
Saved 1 query types from src/deep/nested/b.sql to src/deep/nested/b.ts
Error in query. Details: {
  errorCode: '42703',
  message: 'column "nonexistent_column" does not exist',
  hint: undefined,
  position: '8'
}
Saved 1 query types from src/deep/nested/a.sql to src/deep/nested/a.ts
```

The query still gets `never` types written to disk, so the user's first real signal was a downstream
TS error. With `failOnError: true` the picture was already fine — `processFile` reports
`Error processing src/deep/nested/b.sql: Query "BadQueryTwo" is invalid.` — so the gap was specific
to the default path.

`fileName` is now threaded into `queryToTypeDeclarations` and both names appear in the message.
PR #584's own formatting hunks were **not** taken: they revert prettier across four unrelated blocks
and add stray blank lines, and `pnpm lint` gates on `prettier --check .`.

### `Buffer` referenced in generated output with no import — PR #612, upstream #262 — **FIXED**

A `bytea` column emitted `Buffer` relying on the ambient Node global. Reproduced by typechecking a
generated file with `"types": [], "lib": ["esnext"]`:

```
src/repro.queries.ts(15,9): error TS2591: Cannot find name 'Buffer'.
  Do you need to install type definitions for node? ...
```

`packages/cli/src/types.ts` had `const Bytes: Type = { name: 'Buffer' }`; it now carries
`from: 'node:buffer'`, and `declareImport` already emitted the right form for a bare specifier
(`import type { Buffer } from 'node:buffer';`, since `from !== RUNTIME_MODULE`). This makes generated
output compile under Deno, workerd/Cloudflare, Bun, and any project that deliberately keeps
`@types/node` off its global `types` list — without the `declare global { Buffer }` hack users write
today.

It changes generated output for every existing `bytea` user (adds one import line) while being
behaviour-preserving in Node. `packages/example` has no `bytea` column, so its committed output is
unaffected.

**`Buffer` was the only ambient non-ES global in generated output.** The rest of
`DefaultTypeMapping` bottoms out in `string`/`number`/`boolean`/`undefined`, in `Date` (an ES lib
global, available everywhere), or in locally-declared aliases (`Json`, `DateOrString`,
`NumberOrString`, `PgPoint`, `PgInterval`, the `*Array` aliases). Enum unions are string literals.

### Six `DefaultTypeMapping` entries disagreed with what the runtime returns — issue #552, PR #553 — **FIXED**

PR #553 only adds an `audio_books` table and a snapshot test for an `INTERVAL` column; it documents
#552 without fixing it. Chasing it uncovered five more of the same kind.

The generated types and the runtime values disagreed **silently** — `tsc` was happy and the value was
wrong.

Reproduction, table `mism` with columns `time`, `timetz`, `bit(3)`, `numeric[]`, `point`, `interval`,
all `NOT NULL`:

```sql
/* @name GetMism */
SELECT t, tz, b, n, p, iv FROM mism;
```

Generated, before the fix:

```ts
export type numberArray = number[];
export type stringArray = string[];

export interface GetMismResult {
  b: boolean;
  iv: string;
  n: stringArray;
  p: numberArray;
  t: Date;
  tz: Date;
}
```

Actual values from `getMism.run(client)` through the fork's runtime:

```
  t:  String            = "01:02:03"
  tz: String            = "01:02:03+00"
  b:  String            = "101"
  n:  Array             = [1.5]
  p:  Object            = {"x":1,"y":2}
  iv: PostgresInterval  = {"hours":1}
```

| Postgres type | declared     | actual                                                                                                     |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `interval`    | `string`     | `PostgresInterval { hours, minutes, seconds, … }`                                                          |
| `time`        | `Date`       | `string` `"01:02:03"`                                                                                      |
| `timetz`      | `Date`       | `string` `"01:02:03+00"`                                                                                   |
| `bit`         | `boolean`    | `string` `"101"`                                                                                           |
| `numeric[]`   | `(string)[]` | `(number)[]` — scalar `numeric` **is** correctly `string`; only the array form is parsed with `parseFloat` |
| `point`       | `(number)[]` | `{ x, y }`                                                                                                 |

A broader sweep of 36 type/value pairs confirmed everything else in `DefaultTypeMapping` agrees with
pg-types: `int8`/`numeric`→string, `date`/`timestamp`/`timestamptz`→`Date`, `bytea`→`Buffer`,
`json`/`jsonb`→parsed, `text[]`/`int4[]`/`int8[]`/`timestamptz[]` all correct.

**Where this came from — a long-standing upstream bug, not a 3.0 regression.** It is tempting to
explain these entries as describing what the deleted hand-rolled wire client used to return. That is
wrong: the wire client only ever did codegen type discovery and never returned rows to users. The
fork point confirms it — `git show 88a428f:packages/cli/src/types.ts` already has
`time`/`timetz` → `Date`, `interval` → `String`, `point` → `getArray(Number)` and
`bit: { parameter: Boolean, return: Boolean }` carrying a literal
`// TODO: … bit array support`. These entries were already wrong upstream; the fork inherited them.
Adopting node-postgres did not cause the mismatch, it only made it observable end to end.

**Fixed.** `packages/cli/src/types.ts` now declares what the driver returns:

| Postgres type | now          |
| ------------- | ------------ |
| `interval`    | `PgInterval` |
| `time`        | `string`     |
| `timetz`      | `string`     |
| `bit`         | `string`     |
| `numeric[]`   | `(number)[]` |
| `point`       | `PgPoint`    |

`PgInterval` and `PgPoint` are emitted into the generated file, the way `Json` and `DateOrString`
already are, so generated output still imports nothing. `PgInterval` declares every field optional,
which is what the parser actually produces — `'1 hour'` is `{ hours: 1 }` and `'0 seconds'` is `{}`,
absent rather than zero — and includes the three real prototype methods `toPostgres`, `toISO` and
`toISOString`. It deliberately omits `toString`, which is only the one inherited from `Object` and
returns `'[object Object]'`.

**The parameter direction moved too, and it was worse than the return direction.** Every non-string
input form these entries allowed is rejected by the server, verified one at a time:

| passed in                  | server says                                                           |
| -------------------------- | --------------------------------------------------------------------- |
| `Date` → `time`            | `invalid input syntax for type time: "2019-12-31T17:02:03.000-08:00"` |
| `Date` → `timetz`          | `invalid input syntax for type time with time zone: …`                |
| `Date` → `interval`        | `invalid input syntax for type interval: …`                           |
| `true` → `bit`             | `"t" is not a valid binary digit`                                     |
| `[1, 2]` → `point`         | `invalid input syntax for type point: "{"1","2"}"`                    |
| `{ x: 1, y: 2 }` → `point` | `invalid input syntax for type point: "{"x":1,"y":2}"`                |

So `time`, `timetz`, `interval`, `bit` and `point` all take a `string` in the parameter direction as
well. The generated type was not merely imprecise there, it was admitting calls that could only ever
fail at runtime. `numeric[]` needed no parameter change: the server takes numbers or strings as
elements, exactly as it does for a scalar `numeric`.

**`numeric[]` could not be fixed in the mapping table alone.** `TypeAllocator.use` derived every
`_`-prefixed type by wrapping its element type's mapping, and that branch ran _before_ the mapping
was consulted, so no entry could describe an array type — and a `typesOverrides` entry naming one
was silently ignored for the same reason. An exact mapping entry now wins over the derivation, which
fixes both.

**Previously marked Unverified, now verified.** The earlier probe covered only six array OIDs. A
sweep of 21 array types against PostgreSQL 17 — `_text`, `_int4`, `_int8`, `_numeric`, `_float4`,
`_float8`, `_bool`, `_date`, `_timestamp`, `_timestamptz`, `_time`, `_timetz`, `_interval`, `_point`,
`_bit`, `_uuid`, `_bytea`, `_json`, `_jsonb`, `_money`, `_inet` — comparing each array's elements
against the same value as a scalar found `_numeric` to be **the only** type whose elements are parsed
differently from its scalar. It is therefore the only exception the mapping needs.

**One further mismatch found by that sweep, and left alone:** `_bit` is not returned as an array at
all. pg-types has no parser registered for it, so a `bit(3)[]` column arrives as the raw literal
string `'{101}'` while the generated type says `(string)[]`. That is a seventh bug of the same
family, out of scope here, and worth its own entry if anyone selects a `bit[]`.

**Regression cover.** `packages/cli/src/types.test.ts` pins all six entries in both directions,
alongside the neighbours that were correct and must not move with them (scalar `numeric`, `date`,
`timestamp`, `timestamptz`, `_int4`, `_text`), and pins the two emitted aliases verbatim.
`packages/example` grows a `driver_types` table with a column of each type and asserts, against the
live server, both that the value has the declared shape and — via `const x: T = row.col` — that the
declaration compiles. The example is now typechecked in CI, which it was not before: it had a
`check` script that nothing ran, so a `check:test` was added for the existing CI step to pick up.
Without that the type half of the assertion would be stripped by vitest and prove nothing.

---

## Still open — cheap

### `tstzrange` and the other range types are unmapped — issue #213

Still absent from `DefaultTypeMapping` (`packages/cli/src/types.ts`), so a range column generates:

```ts
export interface TstzRangeResult {
  period: unknown;
}
```

plus a logged `Error: Postgres type 'tstzrange' is not supported by mapping`.

Two things moved in 3.0's favour, both verified: the failure is **non-fatal** (it logs and emits
`unknown` rather than aborting as the reporter's stack trace shows), and the reporter's exact
array-insert case works via `typesOverrides`:

```json
"typesOverrides": { "tstzrange": "string" }
```

```ts
export interface CreateTimesParams {
  times: readonly { id: number | null | void; period: string | null | void }[];
}
```

**Fix:** add `tstzrange`/`tsrange`/`daterange`/`int4range`/`int8range`/`numrange` to
`DefaultTypeMapping` as `string`. Low risk; retires a five-year-old report.

### `.sql` discovery includes `node_modules` — issue #534

Reproduced: `globSync('/tmp/.../src/**/*.sql')` returns `src/node_modules/somepkg/b.sql`. Neither
`globSync` in `packages/cli/src/typescriptAndSqlTransformer.ts` nor the chokidar watcher in the same
file excludes `node_modules`.

**Fix:** add `ignore: ['**/node_modules/**']` to both.

(The reporter's specific `.bin/tsc` lines would be filtered by today's minimatch predicate; the core
complaint — files under `node_modules` are parsed — reproduces exactly.)

### `--file` only matches one exact spelling of the path — issue #579

Half fixed. The reported "all files are regenerated anyway" is gone — verified: with a non-matching
`-f`, `multi/b/two.queries.ts` was never written. The other half is not:
`fileList.includes(fileOverride)` in `typescriptAndSqlTransformer.ts` is raw string equality against
glob output, identical to 2.x.

| `-f` argument                                   | Result                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `multi/a/one.sql`                               | works                                                                            |
| `./multi/a/one.sql`                             | `File override specified, but file was not found in provided transforms`, exit 0 |
| `/tmp/pgt-repro/multi/a/one.sql`                | same                                                                             |
| `multi\a\one.sql` (the Windows reporter's case) | same                                                                             |

**Fix:** compare `path.relative(process.cwd(), path.resolve(x))` on both sides. Also worth exiting
non-zero on that message rather than 0.

**Related footgun, pre-existing:** `yargs.env()` is called with **no prefix**, so an ambient `FILE`
environment variable sets `--file`. Verified: `FILE=one/nonexistent.sql pgtyped -c cfg.json` printed
the override-not-found message and did nothing.

### Pick-expansion keys are never optional — issue #573

Partially fixed already: **scalar** params are marked optional in 3.0
(`const optional = param.type === ParameterTransform.Scalar && !param.required;`), verified:

```ts
export interface Get583Params {
  avatar?: Json | null | void; // note the `?`
  email?: string | null | void;
}
```

But the reporter's actual case is a **pick expansion**, and its keys still get no `?`:

```sql
/*
  @name Get573
  @param address -> (line1!, line2, city!)
*/
INSERT INTO postal_codes (code, created_at, updated_at) VALUES :address RETURNING code;
```

```ts
export interface Get573Params {
  address: {
    line1: string;
    line2: DateOrString | null | void; // expected: line2?: …
    city: DateOrString;
  };
}
```

**Fix:** the `else` branch of the param loop in `queryToTypeDeclarations` builds those keys as raw
strings; append `?` when `!p.required`, mirroring the scalar branch three lines above. Decide
alongside PR #582 / issue #556, which pull on the same line of code in the opposite direction.

### The CLI package's `exports` map hijacks the importing process — found while evaluating PR #620

Independent of whether #620's package split is adopted (it should not be — see
[Not applicable](#not-applicable)), `packages/cli/package.json` has no `"."` entry and maps `"./*"`
onto `./lib/index.js`, which is the `#!/usr/bin/env node` bin with top-level yargs parsing and
`process.exit`.

Reproduced with the CLI symlinked into a scratch project's `node_modules`:

```
import('@pelotech/pgtyped-cli')             -> ERR_PACKAGE_PATH_NOT_EXPORTED
import('@pelotech/pgtyped-cli/generator.js') -> prints the CLI's --help text and
                                                "Missing required argument: config"
                                                into the importing process
```

Any subpath import takes over the host process.

**Fix:** add a real `"."` library entry, stop mapping `./*` onto the bin, and move the
argv/`process.exit` code out of `index.ts` into a `cli.ts` bin. Cheap on its own; the stable public
API behind #620 is a separate design task.

### Docs and repo residue — issues #491, #548, #572

All one-line fixes, verified present today:

- `docs-new/docs/faq.md` is **0 bytes**. It is not in `sidebars.js`, so it does not render, but it
  should not ship empty.
- `CONTRIBUTING.md`, `packages/example/README.md` and `docs-new/docs/getting-started.md` still point
  at `github.com/adelsz/pgtyped` for cloning and for the example app. `packages/example/README.md`'s
  step 4 is `pnpm build`, which in that package is
  `echo 'No build step required. Use pnpm test instead'` — following the README literally leaves
  `packages/cli/lib` unbuilt and step 5 (`docker compose run watch`, which execs
  `/app/packages/cli/lib/index.js`) then fails. The root `pnpm build` is what is needed.
- **#572** — `srcDir` is still resolved against `process.cwd()`, not against the config file
  (`includePattern = ${srcDir}/**/${include}`, fed to `globSync` with no `cwd`), and
  `docs-new/docs/cli.md` still describes it only as "Directory to scan or watch for query files."
  Worse than the reporter described: running the CLI from another directory with an absolute `-c`
  path produced **no output whatsoever** and exit 0 — no `Processing`, no warning that zero files
  matched. Add the parenthetical, and consider warning when the glob matches nothing.

---

## Still open — medium

### Domain types are flattened to their base type — issues #503, #594; PR #637

`typesOverrides` keyed on a domain name silently never fires for result columns, and a domain over
an enum loses the enum.

Reproduced on pg17:

```sql
CREATE DOMAIN email AS text CHECK (VALUE ~ '@');
CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);
CREATE TYPE mood AS ENUM ('sad','ok','happy');
CREATE DOMAIN mood_d AS mood;
CREATE TABLE accounts (id serial PRIMARY KEY, contact email NOT NULL,
                       score positive_int, feeling mood_d);
```

with `"typesOverrides": {"email": "./types#Email", "positive_int": "./types#PositiveInt"}`:

```ts
export interface GetAccountsResult {
  contact: string; // want Email
  feeling: mood | null; // domain name mood_d lost; resolves to the base enum
  id: number;
  score: number | null; // want PositiveInt | null
}
```

No import of `./types` is emitted at all — dead config, no warning. Same for parameters
(`WHERE contact = :contact!` → `contact: string`) and for a direct column alias
(`SELECT contact AS c1` → `c1: string`).

Independently reproduced with `CREATE DOMAIN uint128 AS numeric(39,0)` and
`"typesOverrides": {"uint128": "BigInt"}` → generated `big: string | null`, override ignored, while
the control in the same run (`"interval": "./types#PgInterval"`) **was** respected. The symptom has
changed since #594 was filed: 3.0 no longer errors
`Postgres type 'uint128' is not supported by mapping`, it silently resolves to the base type.

**Root cause, traced and instrumented:** Postgres reports the domain's _base_ type OID in
`RowDescription`, never the domain's own OID.

```
custom_time   oid 16406  typtype d  typbasetype 1184
timestamptz   oid 1184
RowDescription dataTypeID for domain column ctime: 1184   <- base type, not 16406
```

So `typeMap[f.typeOID]` can only ever resolve to the base type name. Parameters are typed correctly
in the `custom_time` reproduction because `ParameterDescription` _does_ carry the domain OID
(note this contradicts the `email`/`mood_d` run above, where the parameter also came out `string` —
the parameter side is worth re-checking before anyone relies on it). `DatabaseTypeKind.Domain` is
declared in `packages/cli/src/db/type.ts` and never used.

**How to fix, and the amendment PR #637 does not contain.** `getTypes()` in
`packages/cli/src/db/types.ts` **already runs** a `pg_attribute` query per result column, for
`attname`/`attnotnull`. `pg_attribute.atttypid` holds the _domain_ OID — verified on the same
server:

```
attrelid | attnum | attname | atttypid | attnotnull
   16408 |      2 | ctime   |    16406 | t
```

So adopting is: add `atttypid` to that existing `SELECT`, move it above `runTypesCatalogQuery`
(today the catalog query runs first), and remap `f.typeOID` before building `usedTypesOIDs`. No
extra round trip.

**But do not merge #637 verbatim.** Remapping the OID makes `runTypesCatalogQuery` return the
_domain_ row (`typtype = 'd'`, `typname = 'email'`), and `reduceTypeRows` has no domain branch — it
would yield the bare string `'email'`, which `TypeAllocator.use()` does not know. Verified on the
same code path using a composite type (also an unmapped type name):

```
$ node packages/cli/lib/index.js -c config.json     # SELECT ROW('a','b')::addr AS a
Error: Postgres type 'addr' is not supported by mapping
...
  a: unknown | null;
```

Unamended, #637 turns today's `contact: string` into `contact: unknown` plus a codegen error for
**every** project that has domain columns and has not written a `typesOverrides` entry for each one.
`mood_d` is worse: it currently resolves usefully to the `mood` enum union and would degrade to
`unknown`.

A correct adoption needs a fallback: resolve the domain name if it is mapped or overridden,
otherwise walk `pg_type.typbasetype` recursively (expanding enums) back to what is generated today.
Realistically **~40–60 lines in `db/types.ts` plus tests**, not the 44 in the PR.

**Scope limit:** this fixes result columns that are direct column references only. Domain-typed
_parameters_ and domain-typed _expressions_ (`upper(contact)`) stay flattened, and no OID trick can
fix that.

### Array elements are typed as non-nullable — issues #613, #460; PR #614

`getArray` produces `(T)[]`; Postgres arrays can always contain NULL elements, so `(string)[]` is a
lie. Reproduced:

```sql
/* @name GetTextArray */
SELECT ARRAY['a', NULL, 'c']::text[] AS vals;
```

```ts
export type stringArray = (string)[];
…
vals: stringArray | null;
```

```
actual rows: [{"vals":["a",null,"c"]}]
```

Also reproduced from #613's own angle: `SELECT pg_typeof(:input!::text[])` →
`export type stringArray = (string)[];`. #613 and #460 are the same request and should be resolved
together.

**Take the idea, not the patch.** Upstream's #614 applies `(null | T)[]` in **both** scopes and
renames every alias `TArray` → `NullTArray`, a gratuitous rename of every generated alias. The
parameter side does not need it — a caller passing `string[]` is already fine, and widening the
accepted input is not the bug reported.

**Suggested scope:** make `getArray` scope-aware in `TypeAllocator.use` — keep
`stringArray = (string)[]` for `TypeScope.Parameter`, emit a distinct
`nullableStringArray = (string | null)[]` for `TypeScope.Return`. Roughly 20 lines in
`packages/cli/src/types.ts`, plus tests, plus regenerating `packages/example`. Breaking for consumers
who index array results without a null check — which is the point:
`row.tags.map(t => t.toUpperCase())` stops being a silent `TypeError` waiting to happen.

### Empty array in a spread renders `IN ()` — issues #221, #314, #273

Reproduced in three shapes:

```
compile({ids:[1,2,3]}) -> {"text":"SELECT id, name FROM books WHERE id IN ($1,$2,$3)","values":[1,2,3]}
compile({ids:[]})      -> {"text":"SELECT id, name FROM books WHERE id IN ()","values":[]}
run(c, {ids:[]})       -> THREW: 42601 syntax error at or near ")"
```

- **#221** — `@param things -> ((column1, column2)…)` with `things: []` renders
  `INSERT INTO jt (id, doc) VALUES ()` → `42601 syntax error at or near ")"`, the exact error in the
  report.
- **#314** — `SELECT * FROM jt WHERE id IN ()` → `42601`. Same root cause.
- **#273** — `$$evtTypes is NULL or evt_type in $$evtTypes` with `evtTypes: []` renders
  `( () is NULL or evt_type in () )` → `42601`.

`render.ts` joins an empty list to `''` and wraps it in parens. **There is no correct SQL for "zero
rows" in every position**, so this needs a decision (skip the statement, `WHERE false`, per
transform) rather than a patch.

**The mitigation that exists is `nonEmptyArrayParams`**, off by default
(`packages/cli/src/generator.ts`). It types the param as `readonly [T, ...T[]]` and covers both
`array_spread` and `pick_array_spread` — verified: `ids: readonly [number | null | void, ...(number
| null | void)[]]`, so the empty literal becomes a compile error. It is a **type-level guard only**:
an array whose length is not known statically still reaches `IN ()` at runtime.

Two follow-ups worth deciding together: **default `nonEmptyArrayParams` to true** — 3.0 is the one
release where a default can move, and it is the only mitigation that exists — and add the caveat to
`docs-new/docs/dynamic-queries.md`, which recommends the `:param :: TEXT IS NULL` pattern without
saying it only works for scalars and cannot be used with a spread. `docs-new/docs/cli.md` describes
`nonEmptyArrayParams` but never mentions `IN ()` or the runtime error.

### No way to type the keys of a `VALUES :rows` pick — issues #498, #517, #630

One issue with three reports.

- **#498**, reproduced against a live DB with the reporter's exact schema (`issue.id TEXT`,
  `issue.badge_id INT`):
  `Error in query. Details: { errorCode: '42804', message: 'column "badge_id" is of type integer but
expression is of type text' }`, and the query is emitted with `Params = never`.
- **#630**, reproduced:
  `UPDATE foo f SET val = item.val FROM (VALUES :foos) AS item(id, val) WHERE f.id = item.id` →
  `42883 operator does not exist: integer = text`.
- **#517** asks for the annotation syntax that would fix both. None exists.

Not cheap: needs new annotation syntax plus IR and renderer support.

### Codegen accepts queries the connecting role may not execute — PR #563

Postgres checks table/column privileges at **execute** time, not at Parse/Describe time, so the
`DescribeStatement` path reports a perfectly good result type for a query the role cannot run.

Reproduced with role `app_user` and `REVOKE ALL ON secrets`:

```sql
/* @name GetSecrets */
SELECT id, value FROM secrets;
```

```ts
// codegen: exit 0, no warning
export interface GetSecretsResult {
  id: number;
  value: string;
}
```

```
RUNTIME ERROR: 42501 permission denied for table secrets
```

Half of what #563 was after **is** already caught: the second query in the same file,
`INSERT INTO secrets (id, value) …` against a `GENERATED ALWAYS AS IDENTITY` column, failed at Parse
with `428C9 cannot insert a non-DEFAULT value into column "id"` and was correctly emitted as `never`.
Only the privilege half is missing.

See [Worth adopting](#pr-563--pre-flight-privilege-check) for the technique and its caveats.

### Ambient `PG*` environment variables override an explicit `dbUrl` — found while evaluating PR #524

`parseConfig` merges `envDBConfig` last. Reproduced:

```
$ PGDATABASE=nonexistent_db node packages/cli/lib/index.js -c config.json
Could not connect to the database at localhost:55444 as user "postgres". No files were written.
database "nonexistent_db" does not exist
```

It failed loudly here only because `verifyConnection` now exists. With a _valid_ but wrong
`PGDATABASE` — a developer with `PGDATABASE=prod` exported in their shell — codegen would connect
happily and generate types from the wrong schema. The precedence is inherited from upstream and
`docs-new/docs/cli.md` documents it, but it is worth deciding deliberately whether config should beat
ambient env. Bundle the decision with PR #524 (see [Worth adopting](#pr-524--env-var-templating-in-config)).

### Duplicate keys in generated interfaces — not reported upstream

Two result columns landing on the same field name emit a TypeScript interface that will not compile
(TS2300). Both spellings reproduce:

```sql
/* @name Dup */ SELECT "userName", user_name FROM mixed;          -- with camelCaseColumnNames
/* @name DupHint */ SELECT a.id, b."aId" AS id FROM "A" a LEFT JOIN "B" b ON a.id = b."aId";
```

```ts
export interface DupResult {
  userName: string;
  userName: string;
}
export interface DupHintResult {
  id: number;
  id: number;
}
```

**Pre-existing, not a 3.0 regression** — 2.x's `generateInterface` and `returnTypes.forEach` (checked
at `88a428f`) had no dedup either. Note a `@column id!` hint matches by name and so applies to
_both_ columns.

### `record` is unmapped, and `failOnError` does not catch it — issue #317

Reproduced with the reporter's exact message: `Error: Postgres type 'record' is not supported by
mapping`. Unchanged from 2.x (`git show 90e567b:packages/cli/src/generator.ts` has the same
`types.errors.forEach((err) => console.log(err))`).

Two sharp edges: the column is emitted as `row: unknown | null`, and **`failOnError: true` does not
catch it** — verified `exit=0` with `failOnError: true`. The code comment in `generator.ts` claims "a
`never` type is emitted which can be caught later when compiling"; it emits `unknown`, which nothing
will catch. Fixing the `failOnError` escalation for `TypeAllocator` errors is cheap and worth doing
independently of composite-type support (#629).

### Shared type aliases collide across generated files — issue #565

Confirmed directly from two generated files: both declare
`export type DateOrString = Date | string;`, and both declare `lobby_statusArray` — with _different_
definitions (`(lobby_status)[]` vs `(LobbyStatus)[]`). `export *` from both gives exactly the
reported TS2308.

Not cheap: needs a shared-emit target plus a watch-mode invalidation story, which the reporter
flagged as the hard part themselves.

### A column-shaped `typesOverrides` key is silently accepted and silently ignored — issue #567

`typesOverrides` is keyed by type name only. Because the schema is `z.record(…)`, a column-shaped key
passes validation and does nothing — no warning, no error:

```json
"typesOverrides": { "lobbies.status": "./x.js#MyStatus" }
```

```ts
export interface ColMapResult {
  status: lobby_status;
} // override had no effect
```

That is a bad failure mode next to 3.0's new strictness elsewhere. Implementing the feature properly
is medium cost, and the data is already in hand: `getTypes` computes `columnName` per result column
in `db/types.ts` and then never uses it. At minimum, warn on a key containing a dot.

---

## Known limitations — real, reproduced, and not cheaply fixable

These are all confirmed still-current. They are grouped because the answer to each is "this is what
the protocol gives us", not "nobody has got to it".

| Source                                       | Behaviour, reproduced                                                                                                                                                                                                                              | Why it stays                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#551** outer joins not nullable            | `SELECT a.*, b."bStr" FROM "A" a LEFT JOIN public."B" b ON a.id = b."aId"` → `bStr: string`, expected `string \| null`                                                                                                                             | `getTypes` reads `attnotnull` on the _base column_, and `"B"."bStr"` genuinely is `NOT NULL`. The join that synthesises a NULL row is invisible at that level, and Describe gives no per-result-column nullability. Doing it right means a real analyser. **The supported answer is `@column bStr?`, which works** — verified: `@column c!` on a `coalesce` result flipped `string \| null` to `string`. Worth pointing at from the docs. |
| Views/matviews all-nullable                  | `SELECT id, foo, bar FROM v_jt` → every column `\| null`                                                                                                                                                                                           | `pg_attribute.attnotnull` is false for view columns even when the underlying column is `NOT NULL`. Pre-existing; `docs-new/docs/sql-file.md` already names matviews as a `@column` case.                                                                                                                                                                                                                                                  |
| **#583** params typed optional               | Params come out `avatar?: Json \| null \| void`; the **result** side correctly honours `NOT NULL`                                                                                                                                                  | `ParameterDescription` returns type OIDs and nothing else. The reporter's own workaround (`:name!`) is the answer and is documented under "Enforcing non-nullability for parameters".                                                                                                                                                                                                                                                     |
| **#455** nullable spread param               | `ages: readonly (number \| null \| void)[]`; `:ages!` gives `readonly (number)[]`                                                                                                                                                                  | Nullability lands on the elements; the array itself is always required, and `optional` is only ever set for `ParameterTransform.Scalar`. Needs a syntax decision (e.g. `@param ages -> (…)?`) plus parser and codegen work. Same design gap as variable-arity params generally.                                                                                                                                                           |
| **#634** `JsonArray` elements nullable       | `array_agg(jsonb_build_object(…))` → `aggregated: JsonArray \| null`, `JsonArray = (Json)[]`                                                                                                                                                       | Elements are nullable because `Json` itself includes `null`. That is `getArray()` wrapping the `Json` alias, not a nullability-inference bug. Separating JSON `null` from SQL NULL means a second alias (`JsonValue`) and deciding which one `array_agg` results get — a design call. `@column agg!` removes the outer `\| null` (verified) but not the element nullability the issue is about.                                           |
| **#263** JS array to a `json` param          | `SELECT :doc!::jsonb` with `doc: [1,2,3]` → `22P02 invalid input syntax for type json`; with `doc: {a:1}` it succeeds                                                                                                                              | node-postgres encodes arrays natively; pgTyped passes bindings through untouched. Fixing it needs the param's Postgres type at render time, which the runtime does not carry. Document it.                                                                                                                                                                                                                                                |
| **#348** static JSON aggregate typing        | `SELECT json_agg(json_build_object(…)) AS family` → `family: Json \| null`                                                                                                                                                                         | Unchanged; would need to interpret the aggregate's arguments.                                                                                                                                                                                                                                                                                                                                                                             |
| **#170**, **#446** dynamic column / order-by | `ORDER BY (CASE WHEN :asc = true THEN :sort_column END) ASC, :sort_column DESC` compiles to `… $2 …` with `values:[false,"id"]`; changing `sort_column` does not change the row order at all (verified against the correct raw `ORDER BY age ASC`) | `$n` is a value, not an identifier. **Cannot be fixed in code.** The docs promised otherwise; that has been corrected (see [Fixed in this fork](#fixed-in-this-fork)).                                                                                                                                                                                                                                                                    |
| **#549** `:name` inside a `DO $$ … $$` block | `export type CreateNamedSequenceIfNotExistsParams = void;`, `"params":[]`                                                                                                                                                                          | Deliberate in 3.0: the scanner treats `$$ … $$` as a dollar-quoted string, matching what Postgres would do. Close as working-as-intended — but the silent `void` is a poor signal, and a warning for a `:name` sigil inside a dollar-quoted body would be kind.                                                                                                                                                                           |
| **#561** permission reflection               | Not implemented                                                                                                                                                                                                                                    | `db/describe.ts` derives types from Parse/Describe, which carries no grant information. The limitation the reporter deduced still holds.                                                                                                                                                                                                                                                                                                  |
| **#513** DDL instead of a live database      | Not implemented; the CLI still requires a live connection                                                                                                                                                                                          | Not attempted; only verified the feature does not exist.                                                                                                                                                                                                                                                                                                                                                                                  |

## Unimplemented feature requests — reproduced as absent

| #                      | Ask                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #523                   | Support arbitrary env var names in config                 | `config.ts` reads only fixed `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGPORT`/`PGURI`/`DATABASE_URL`; no `{{MY_DB_HOST}}` templating. See PR #524 in [Worth adopting](#pr-524--env-var-templating-in-config).                                                                                                                                                                                                                                                                 |
| #586, #556             | A setting to force non-nullability / drop optional params | Not implemented. Verified against the zod schema: `failOnError`, `camelCaseColumnNames`, `hungarianNotation`, `nonEmptyArrayParams`, `preparedStatements` only. `.strict()` now rejects `noOptionalParameters` outright: `(root): Unrecognized key(s) in object: 'noOptionalParameters'`. **Cheap** — one boolean plus one condition. The reporter offered the PR; see PR #582.                                                                                                   |
| #522                   | Expose the query name on the query object                 | See PR #580 in [Worth adopting](#pr-580--expose-the-query-name-on-the-query-object).                                                                                                                                                                                                                                                                                                                                                                                              |
| #143                   | Emit type info at runtime                                 | **Partial.** 3.0 emits the whole `QueryIR` into generated files (`queryName`, `statement`, `params` with transforms and locs, `columns`, prepared `name`) — verified in generated output. Column _types_ are still not emitted, which is what the issue actually asks for.                                                                                                                                                                                                        |
| #404                   | `@comment` annotation                                     | Not supported. `bcc4b07` downgraded unrecognised annotations from fatal to a warning, so a file with `@comment` now generates. Adding the annotation itself is unimplemented.                                                                                                                                                                                                                                                                                                     |
| #459                   | SQL-formatter-friendly variable syntax                    | No syntax change in 3.0. One thing did move that the issue should know: the quoted-identifier workaround it floats (`":id!"`) _was_ being parsed as a param by 2.4.2 and is now correctly ignored, so that avenue is definitively closed. Worth a comment on the issue.                                                                                                                                                                                                           |
| #557                   | Conditional fragments `[[ … ]]`                           | Not implemented. Note the "trailing comment trick" the issue relies on cannot work now that comment contents are opaque to the scanner.                                                                                                                                                                                                                                                                                                                                           |
| #395                   | Mappings within parameter expansions                      | Unsupported; the syntax is passed to Postgres verbatim → `42601 syntax error at or near "("`. New expansion grammar plus IR and renderer support.                                                                                                                                                                                                                                                                                                                                 |
| #629                   | Composite types                                           | Not implemented; `ARRAY(SELECT ROW(…))` has no structural typing.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #202                   | Type-safe dynamic filters at runtime                      | Not implemented; out of scope for the rewrite.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #560                   | Globally replace strings                                  | Unimplemented; no `@global` or equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #576                   | postgres.js support                                       | The issue's actual ask — codegen emitting postgres.js template literals — is unimplemented. But it is **much closer**: `DatabaseConnection` is a single method over a plain `{name?, text, values}`, and `compile()` hands you that object, so a postgres.js adapter is a five-line wrapper around `sql.unsafe(text, values)`. Worth a FAQ entry showing the adapter.                                                                                                             |
| #512                   | Target a schema / `search_path`                           | Still no config option, but there is now a **working workaround, and it is new in 3.0**: because codegen goes through node-postgres, `PGOPTIONS` reaches the server. Verified: `SELECT * FROM widgets` against a table in schema `tenant1` fails with `relation "widgets" does not exist`; with `PGOPTIONS='-c search_path=tenant1'` it succeeds and emits `label: string`. The hand-rolled wire client did not send `options`. This is now documented in `docs-new/docs/cli.md`. |
| #565, #567, #573, #556 | (covered above)                                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

# Worth adopting from upstream

Ordered by value per unit of effort.

### PR #580 — expose the query name on the query object

**Effort: ~2 lines.** Also closes issue #522.

The data is already there and simply is not exposed. `queryName` is serialised into every emitted IR
literal (`{"queryName":"GetAccounts", …}`) but `TypedQuery` holds the IR in a `private readonly ir`
and publishes only `name`, which is the **prepared statement** name, not the query name.

```
codegen query .name:  GetAccounts_8bb00196     # preparedStatements: true
.name with preparedStatements:false -> undefined
public API surface: [ 'constructor', 'compile', 'execute', 'run', 'interpolate', 'split' ]
plain sql tag .name: undefined
sql.prepared('findAccount') .name: findAccount_e0594094
```

Three cases have **no public query identifier at all**: `preparedStatements: false`; a plain `sql`
tag; and any query with an array spread, which never gets a statement name even with prepared
statements on (confirmed in the committed example — `insertBooksIR` has no `"name"` field while its
13 siblings do). And even when `.name` is set it is `GetAccounts_8bb00196`, whose hash suffix changes
whenever the SQL is edited — unusable as a stable metrics dimension.

**What it buys:** per-query metrics, OTel span names, slow-query logs. The stated upstream motivation
is that a fork is being maintained solely for this.

**Do not copy the PR's mechanism** — a second positional constructor argument would churn every
generated file. Add `readonly queryName: string` assigned from `ir.queryName` in the constructor,
plus a line of docs.

### PR #624 — bump the example's Postgres image 17-alpine → 18-alpine

**Effort: one line in `packages/example/docker-compose.yml`.** Verified rather than assumed, against
`postgres:18.6`:

- Copied `packages/example` to `/tmp`, pointed `dbUrl` at the pg18 container, loaded
  `sql/schema.sql`, ran codegen: every file `Skipped … no changes`, and `diff -r` against the
  committed `packages/example/src` reported **no diff**. Generated output is byte-identical on pg18.
- Ran the example suite against pg18: **27 passed (27)**.

**What it buys:** broader coverage of what CI proves. Worth folding into a CI matrix over 17 and 18
rather than a straight swap.

**Unverified:** pg18 was checked for codegen and the example suite only, not for anything it changes
outside those paths.

### PR #582 — an `optionalNullParams` config flag

**Effort: ~10 lines across `config.ts` + `generator.ts`, plus a test.**

Adds a config boolean (default `true`, i.e. current behaviour) that, when `false`, stops a
non-`!` scalar param from being emitted as an optional interface member. Current behaviour confirmed
in generated output: a non-required scalar becomes `id?: string | null | void`.

Survives the rewrite essentially verbatim. The `config.ts` half needs re-expressing in the fork's zod
schema (upstream's is `io-ts`); the generator half is the exact three-line change that still exists
here:

```ts
const optional = param.type === ParameterTransform.Scalar && !param.required;
```

The fork already carries two flags of exactly this character (`nonEmptyArrayParams`,
`camelCaseColumnNames`), so it fits.

**What it buys:** with `optionalNullParams: false`, forgetting to pass a parameter becomes a compile
error rather than a silent `NULL`. Today the only way to get that is to mark every param `!`, which
also changes the emitted TS type. Also answers issue #556. Decide together with #573
(pick-expansion optionality), which pulls the same line the other way.

**Unverified:** the current output and the patched branch were confirmed; the flag was not built.

### PR #637 — fix handling of domain types

**Effort: ~40–60 lines in `db/types.ts` plus tests.** Full analysis, the reproduction, and the
mandatory amendment are under
[Domain types are flattened to their base type](#domain-types-are-flattened-to-their-base-type--issues-503-594-pr-637). In
one line: adopt the technique (read `atttypid` from the `pg_attribute` query `getTypes` already
runs), **not** the patch, and add a `typbasetype` fallback or it converts working columns into
`unknown` for every project with domain columns.

**What it buys:** `typesOverrides` on a domain finally fires; closes #503 and #594.

### PR #614 — array element nullability

**Effort: ~20 lines in `types.ts`, plus tests, plus regenerating `packages/example`.** See
[Array elements are typed as non-nullable](#array-elements-are-typed-as-non-nullable--issues-613-460-pr-614).
Adopt the idea scope-aware; reject the blanket `TArray` → `NullTArray` rename.

**What it buys:** `row.tags.map(t => t.toUpperCase())` stops being a silent `TypeError` waiting to
happen. Closes #613 and #460.

### PR #524 — env-var templating in config

**Effort: small if rewritten from scratch, ~30 lines plus tests.**

**What it buys:** the ability to say which environment variable supplies each connection field,
instead of being limited to the fixed `PGHOST`/`PGUSER`/… names — real for anyone whose CI already
exports `MYAPP_DB_HOST`. Closes issue #523.

**Adopt the idea, not the patch.** The implementation is wrong in ways the PR's own tests encode:
`parseEnvTemplate` returns `result.input.substring(2, len - 2)` — a slice of the _whole input
string_, not of the match — so only a value that is exactly `{{VAR}}` works and `"prefix{{VAR}}"`
yields garbage. A non-template literal value is discarded entirely in favour of the `PG*` default
rather than being used as a literal. It also loosens `db.port` to `number | string`, which fights the
fork's deliberately strict zod schema.

Rewrite as a proper `replace(/\{\{(\w+)\}\}/g, …)` over string-valued `db` fields, applied before
validation, with a clear error on an unset variable. Bundle it with the env-precedence decision
above.

**Unverified:** upstream's own test file was read, not run against upstream's code.

### PR #620 — a programmatic API, minus the package split

**Effort: the packaging fix is small; the stable public API is a design task.**

**What it buys:** generating types from a script without shelling out to the CLI. The motivating case
is PGlite — spin up an in-process Postgres, apply migrations, generate types, all in one Node process
with no TCP listener.

**Do not adopt the shape.** It re-splits `@pgtyped/cli` into `cli` + `typegen`, directly against this
fork's deliberate 6-packages-to-3 consolidation.

**Take instead:** fix the `exports` map (see
[the packaging bug](#the-cli-packages-exports-map-hijacks-the-importing-process--found-while-evaluating-pr-620)),
move the argv/`process.exit` code out of `index.ts` into a `cli.ts` bin, and export a small
`generateTypes(file, config, db)` surface. The fork is well positioned for the PGlite half: `TypeDb`
in `db/type-db.ts` is already a two-method interface (`describe`, `rows`) over a `pg.Pool`.

**Unverified:** the packaging defect was reproduced; the PGlite claim was not. `db/describe.ts` uses
`pg`'s private `Connection.parse`/`describe`/`sync`, and whether PGlite has an equivalent was not
checked — if it does not, the "no TCP" story is more work than it looks.

### PR #563 — pre-flight privilege check

**Effort: medium — roughly a day with tests.** A new method on `TypeDb`/`describe.ts`, a config flag,
and error mapping into the existing `IParseError` path.

**What it buys:** codegen fails on queries the application role is not allowed to run — column-level
`INSERT`/`UPDATE` grants in particular, which are invisible to Parse/Describe. Reproduced above as a
live `42501` at runtime with clean codegen.

**None of the code survives** (`packages/query`, `packages/wire`, the raw Parse/Flush/Close message
plumbing are all gone). The **technique** survives: inside a transaction, `PREPARE` the rendered SQL,
`EXPLAIN EXECUTE name(null, null, …)`, `ROLLBACK`. `EXPLAIN` without `ANALYZE` plans but does not
execute, so it is safe for DML.

**Caveats to settle before anyone starts:**

1. It must be **opt-in**. Many projects run codegen as the owner/migration role and the app as a
   restricted role, where this check is meaningless or actively wrong.
2. Upstream hardcoded `const doTestRuns = true` with no config. Do not copy that.
3. Binding `null` for every parameter changes the plan and can produce spurious errors for some
   queries; failures should probably be a warning unless `failOnError`.
4. It doubles the round trips per query.

**Unverified:** only the missing-`SELECT`-privilege case was reproduced. The column-level
`INSERT (a, b)` / `UPDATE (b)` grants in upstream's example schema were not tested, and the
`PREPARE`/`EXPLAIN EXECUTE` replacement was not prototyped, so the effort estimate is a judgement,
not a measurement.

### PR #642 — `actions/checkout` v5 → v7

**Trivial.** All three workflows are on `actions/checkout@v5` (`main.yml`, `release.yaml`,
`commit-conventions.yml`), and also still `actions/setup-node@v4`, which the PR does not touch. Pure
maintenance — adopt with the next dependency sweep, not on this PR's authority.

---

# Fixed in this fork

Verified by running the case, not by reading code. "Fixed" here means the 2.4.2 packages show the bad
behaviour on the same input and 3.0 does not, or the reported behaviour is directly demonstrated
absent.

## Fixed by the 3.0 rewrite

### Parser and scanner — the clearest argument for the rewrite

Several of these are **silent-wrong-SQL** bugs in 2.x, and none of them had an issue number; they
were found by diffing 3.0 against 2.4.2 in the areas the rewrite touched.

| Bug in 2.x                                                                                        | Evidence (input → 2.4.2 → 3.0)                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:name` inside a double-quoted identifier was a parameter                                         | `SELECT "we""ird :nope" FROM t WHERE a = :x;` → 2.4.2 params `["nope","x"]`; 3.0 `["x"]`. Quoted identifiers are opaque to the scanner.                                                                                                                          |
| `$name` inside line comments, block comments and quoted identifiers was a parameter in `sql` tags | `SELECT 1 -- $nope\nWHERE a = $real` → 2.4.2 `["nope","real"]`; 3.0 `["real"]`. Same for `/* $nope */` and `"$nope"`. In 2.x these were substituted with `$1`, **corrupting the SQL sent to the server**.                                                        |
| A backslash in a string literal broke the parser outright                                         | `SELECT 'a\\' WHERE a = :real;` → 2.4.2 truncates the statement to `SELECT` and emits 2 critical events; 3.0 → statement `SELECT 'a\\' WHERE a = :real`, param `["real"]`. Same for `E'a\\'`.                                                                    |
| Nested block comments ended early and left tail garbage in the statement                          | `SELECT 1 /* outer /* inner :nope */ still */ WHERE a = :real` → 2.4.2 leaves an **unbalanced `*/` in the SQL sent to Postgres**; 3.0 keeps the comment intact.                                                                                                  |
| Prose in an annotation block was a parse error                                                    | `/*\n @name GetUsers\n Returns every user row.\n*/\nSELECT * FROM users;` → 2.4.2: 0 queries, 1 critical event; 3.0: 1 query, no diagnostics. Non-ASCII identifiers and a leading `-- header` line comment were also parse errors in 2.4.2 and are accepted now. |
| `$1` positional placeholders in a `sql` tag were a parse error                                    | `SELECT $1, $x` → 2.4.2: critical "no viable alternative"; 3.0: param `["x"]`, `$1` left alone.                                                                                                                                                                  |

### Issues demonstrably fixed

| #    | Title                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #599 | `IDatabaseConnection` not compatible with `pg`       | `QueryResult.rowCount` is now `number \| null` (`packages/runtime/src/connection.ts`) — exactly what the report asked for. Typechecked strict + nodenext against the built package: `pg.Pool`, `pg.PoolClient` and a hand-written adapter returning `rowCount: null` all satisfy `DatabaseConnection`; `tsc` exit 0.                                                                                                                                                                                |
| #574 | `failOnError` does not abort generation              | Reproduced the reporter's recipe (bad column, `failOnError: true`): `Error processing src/bad.sql: Query "BadQuery" is invalid. Can't generate types.`, **exit 1**, no `bad.queries.ts` written. With `failOnError: false`: error logged, exit 0, file written. The worker-pool swallow the reporter diagnosed is gone — `index.ts` awaits `Promise.all(tasks)`, and `typescriptAndSqlTransformer.ts` rethrows the _returned_ error too, the case the reporter's own patch targeted.                |
| #625 | Errors not reported unless `-w`                      | Same run, no `--watch`: `Error in query. Details: { errorCode: '42703', message: 'column "nonexistent_col" does not exist', position: '8' }` printed to stderr.                                                                                                                                                                                                                                                                                                                                     |
| #151 | Allow multiple `srcDirs`                             | Ran the reporter's exact config (`srcDir: "."`, two transforms with `services/project-a/src/**/*.ts` and `libs/npm/project-b/src/**/*.ts` shapes). Both transforms processed exactly their own file; a planted `node_modules/dep/d.sql` was **not** picked up. The "multiple `**` doesn't work" premise no longer holds under glob v13. The multi-root workaround the reporter wanted now works. (Note this does **not** contradict #534 above — that reproduction plants the file under `srcDir`.) |
| #636 | Modernize TS config: drop polyfills, ESM-only        | `grep -rl __awaiter packages/*/lib/` finds **nothing** — the polyfill that broke stack traces is gone. No CJS entry in `packages/runtime/lib`; `"type": "module"` with ESM-only `exports`; `engines.node` `>=24` in both packages. Every concrete ask is met; only the literal `ES2024`/`NodeNext` string choice differs, which is cosmetic.                                                                                                                                                        |
| #159 | How to get `rowCount`                                | `execute()` returns it. `UpdateNothing.execute(c,{id:1})` → `{"rows":[],"rowCount":1}`; `FindBookById.execute(c,{id:1})` → `{"rows":[{"id":1,"name":"Black Swan"}],"rowCount":1}`; parameterless `CountBooks.execute(c)` → `{"rows":[{"total":4}],"rowCount":1}`.                                                                                                                                                                                                                                   |
| #292 | Get the original SQL from a query object             | `TypedQuery.compile()` is public and returns exactly what would be sent: `{"name":"FindBookById_34358438","text":"SELECT id, name FROM books WHERE id = $1","values":[1]}`. `.name` is public too.                                                                                                                                                                                                                                                                                                  |
| #454 | SQL query tags                                       | 3.0 keeps mid-statement block comments in the statement text, so a tag reaches the server. `SELECT /* app=billing,controller=invoices */ id, name FROM books WHERE id = :id!` → `compile().text` preserves the comment, and `select name, statement from pg_prepared_statements` shows `TaggedQuery_065fa2a1` with the comment intact. **Worth a release-notes line — nobody would guess this from "block comments are kept."**                                                                     |
| #585 | Switch from `antlr4ts` to `antlr4`                   | Moot: the parser package is gone. `grep -rn antlr packages/*/package.json pnpm-lock.yaml` → no hits; `packages/runtime/package.json` has no dependencies at all.                                                                                                                                                                                                                                                                                                                                    |
| #604 | Cannot connect to PostgreSQL 16 with `scram-sha-256` | Ran the CLI against PostgreSQL **16.15** with `password_encryption = scram-sha-256` and `host all all all scram-sha-256`, using a config shaped like the reporter's: `Saved 1 query types from src/ok.sql to src/ok.queries.ts`. SCRAM works. The failure the reporters actually hit — a stale `PGPASSWORD` overriding the config — is covered by the `verifyConnection` fix below.                                                                                                                 |
| #640 | TypeScript 6 support                                 | Peer range is `">=5 <7"` with `peerDependenciesMeta.typescript.optional = true`. Upstream is still `"3.1 - 5"`, which excludes 6.x. TS 6 now installs, and for `sql`-only transforms TS is not needed at all — `generator.ts` imports it lazily behind a clear error.                                                                                                                                                                                                                               |
| #548 | Cannot run the example application                   | `cd packages/example && docker compose run --rm build` → all 12 files processed; `docker compose run --rm test` → 26 passed. **Residual:** the _instructions_ the reporter actually complained about are still stale — see [Docs and repo residue](#docs-and-repo-residue--issues-491-548-572).                                                                                                                                                                                                     |
| #394 | Write types to a separate file                       | Already true for `mode: "ts"`, verified on 3.0: `tsmode/q.types.ts` is emitted with **no imports at all**, only `export interface`. Still mixed for `mode: "sql"`, but a `.sql`-mode user's `import type` is erased by TS anyway and the runtime now has zero dependencies. Effectively answered; not worth code changes.                                                                                                                                                                           |
| #410 | Null parsed parameters in array spread and pick      | **Not creditable to 3.0 — already fixed upstream.** 2.4.2 renders `values ($1,$2)` with bindings `["id","value"]`; 3.0 renders the same. Verified 3.0 has not regressed it (`keys.map(({ name }) => entity[name])` in `render.ts`). Safe to close as fixed.                                                                                                                                                                                                                                         |

### PRs already implemented here

| PR                | Title                                    | Evidence                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #545              | Use a query config object for queries    | `DatabaseConnection.query(config: QueryConfig)` takes exactly one object. Ran a real query through a spying connection: `connection.query received: {"text":"SELECT id, contact FROM accounts WHERE id = $1","values":[1]}`; with `sql.prepared`: `{"name":"findAccount_e0594094",…}`. The two-argument form the PR removes does not exist here.    |
| #633              | Add a `compile` function                 | `TypedQuery.compile()` is public and documented for exactly this use. Plain tag → `{"text":"…","values":[7]}`; `sql.prepared('findAccount')` → `{"name":"findAccount_e0594094","text":"…","values":[7]}`. The shape differs from the PR's `InterpolatedQuery` and is if anything better for the PR's stated PGlite `live.query(text, values)` case. |
| #616 (first hunk) | `fileOverride` reaches the transformer   | `index.ts` already passes `fileOverride` into `transformer.start`. Verified: `-f src/deep/nested/good.sql` processed only that file. The **second hunk is the config-watcher fix**, taken on this branch.                                                                                                                                           |
| #635              | Escape special characters in enum values | `CREATE TYPE car_model AS ENUM ('car''s', 'back\slash', 'plain')` → `export type car_model = 'back\\slash' \| 'car\'s' \| 'plain';`, correctly escaped, and `tsc --noEmit` over the generated file reports no parse error. `quoteString` in `types.ts` does this via `JSON.stringify` and cites upstream #611.                                      |
| #627              | `@types/yargs` → 17.0.35                 | Already `"^17.0.35"`.                                                                                                                                                                                                                                                                                                                               |
| #628              | node → v24 in `release.yaml`             | Already `node-version: '24'`; `main.yml` tests a `['24','26']` matrix; every package sets `"engines": {"node": ">=24"}`.                                                                                                                                                                                                                            |
| #641              | `@types/debug` → 4.1.13                  | Already `"^4.1.13"`.                                                                                                                                                                                                                                                                                                                                |
| #643              | Allow a TypeScript 6 peer for the CLI    | Peer is already `">=5 <7"` with `peerDependenciesMeta.optional` — the exact property the PR validates. The workspace is itself _built_ with TS 6 (catalog `typescript: ^6.0.3`).                                                                                                                                                                    |
| #632              | `glob` → v13                             | Already `"^13.0.6"`.                                                                                                                                                                                                                                                                                                                                |

**Unverified:** the Renovate PRs (#615, #619, #627, #628, #632, #641, #642, #643) were classified by
reading `package.json`, `pnpm-workspace.yaml` and the workflow files, not by installing. That is
sufficient for the claim being made — "the fork is already at this version or newer".

## Fixed after this triage, in `bcc4b07`

These were found _by_ this triage and fixed in
`bcc4b07 fix: correct defects found triaging upstream issues against 3.0 (#21)`. They are recorded
with their reproductions because the reproductions are the regression tests' reason for existing.

| What was wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Reproduction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A mid-statement block comment containing `@name` split the file.** `readBlock` attempted a header on **every** `/* … */` span regardless of whether a statement body was open, so any mid-statement comment mentioning `@name <ident>` terminated the statement in progress and invented a bogus query. A 2.x-clean `.sql` file stopped building under 3.0, with a message pointing at a missing semicolon rather than at the comment.                                                                                               | `/* @name GetUsers */\nSELECT id FROM users\n/* WHERE id = :x  -- see @name GetUsersById */\nORDER BY id;` → 3.0 `queries: ["GetUsers","GetUsersById"]`, `errors: ["Statement for @name GetUsers is not terminated by \";\""]`, and because `generator.ts` treats `parsed.errors` as fatal per file, the whole file emitted nothing. 2.4.2 on the same input: `["GetUsers"]`, no events. Second shape: `@name must stay above` inside a `SELECT` list → `["GetUsers","must"]` plus the same fatal error.                                                                  |
| **#611 — enum labels were interpolated into single quotes with no escaping**, emitting TypeScript that does not parse, with no error and exit 0.                                                                                                                                                                                                                                                                                                                                                                                       | `CREATE TYPE model_enum AS ENUM ('rileys','525','car''s')` → generated line 4: `export type model_enum = '525' \| 'car's' \| 'rileys';`, while the CLI printed `Saved 5 query types …` and exited 0. Now goes through `quoteString`.                                                                                                                                                                                                                                                                                                                                      |
| **A connection failure silently overwrote every generated file with `never` and exited 0** (surfaced by #604's comments — a stale `PGPASSWORD` in the reporter's shell). 2.x did `await startup(…)` _before_ any transform ran; 3.0 replaced it with a lazily-connecting `pg.Pool` and had no eager check, so a connection-level failure degraded into a per-query describe error, which codegen turns into `never` and which `failOnError: false` (the default, and the value in both documented sample configs) does not escalate.   | `PGPASSWORD=stale-wrong node packages/cli/lib/index.js -c config-one.json` → `Error in query. Details: { errorCode: '28P01', … }` / `Saved 1 query types …` / `EXIT=0`, and the previously-correct `env.queries.ts` rewritten to `export type EnvQResult = never;`. Same for a wrong `db.password` and for `ECONNREFUSED`. Now `verifyConnection` runs first and the run aborts before anything is written. (**Unverified:** the 2.x behaviour was read from `git show 90e567b:packages/cli/src/index.ts`, not executed — those packages no longer exist on this branch.) |
| **Every CLI failure path exited 0**, including the config errors 3.0 newly introduced. `index.ts` called bare `process.exit()` in the config-parse catch block. Pre-existing on its own; a release blocker in combination with 3.0's new strictness, because **the most likely first experience of upgrading is a config that no longer parses, and in CI that run passed green while generating nothing**.                                                                                                                            | `maxWorkerThreads: 4` → `Unrecognized key(s) in object: 'maxWorkerThreads'`, exit **0**. `mode: "ts-implicit"` → the bespoke removal message, exit **0**. `-c nope.json` → `Cannot find module …`, exit **0**. Typo `camelCaseColumNames` → exit **0**. `docs-new/docs/getting-started.md` said the removed key "will now **fail the run**"; it did not.                                                                                                                                                                                                                  |
| **`AS "total!"` silently disagreed with the generated type under `camelCaseColumnNames`.** The upgrade note promised the suffix survives into the generated type and the row key. It does with `camelCaseColumnNames: false`; with it on, codegen runs `camelCase("total!")` → `"total"` while the row key stays `total!`, so `row.total` is `undefined` and **nothing in the generated type tips anyone off**. In 2.x these agreed (the runtime stripped `!` from every row key); 3.0 removed the stripping but kept the camelCasing. | `SELECT count(*)::int AS "total!" FROM jt;` with `camelCaseColumnNames: true` → generated `total: number \| null`; actual row keys `[ 'total!' ]`. Now codegen warns when a result column name ends in `!` or `?`, and both doc sites were corrected.                                                                                                                                                                                                                                                                                                                     |
| **Only the top level of the config was `.strict()`**, so `db` and each transform silently dropped unknown keys — while `docs-new/docs/cli.md` claimed unrecognised keys fail the run. The dangerous instance is `db`: `"dbname"` or `"database"` instead of `"dbName"` was dropped and the CLI fell back to the `postgres` default database.                                                                                                                                                                                           | `{"db": {…, "schema": "tenant1"}}` → accepted, key dropped, `Saved 4 query types…`. `{"transforms":[{…,"emitFileNam":"typo.ts"}]}` → accepted, key dropped. Nested objects are now strict.                                                                                                                                                                                                                                                                                                                                                                                |
| **#170/#446 — `docs-new/docs/dynamic-queries.md` documented a pattern that does not work.**                                                                                                                                                                                                                                                                                                                                                                                                                                            | `ORDER BY (CASE WHEN :asc = true THEN :sort_column END) ASC, :sort_column DESC` compiled to `…$2…` with `values:[false,"id"]`; `sort_column=id`, `sort_column=user_name` and `asc=true sort_column=age` all returned rows `1,2,3`, while the raw `ORDER BY age ASC` returned `3,2,1`. The page now states that a bind parameter cannot name a column and shows the pattern that does work.                                                                                                                                                                                |
| **#404 — an unrecognised annotation was fatal**, so a block containing `@deprecated`, `@see` or `@comment` emitted nothing. (**Parity, not a regression** — 2.4.2 also rejected it. `@` in prose and `foo@bar.com` were always fine.)                                                                                                                                                                                                                                                                                                  | `/* @name GetUsers\n @comment Fetches all the users */ SELECT * FROM users;` → `errors: ["Unrecognised annotation @comment"]`, file emits nothing. Now a warning.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **The `sql-file.md` trailing-semicolon rule and the `parseSqlFile` doc comment were both wrong** (not from the issue set; found by diffing against 2.4.2). 3.0 deliberately does not require a semicolon on the _last_ statement in a file (pinned at `parse-sql-file.test.ts`), making it _more_ permissive than 2.x. An unterminated statement _followed by another block_ is still fatal.                                                                                                                                           | `/* @name Q */\nSELECT 1` → 3.0 `queries: ["Q"]`, `errors: []`; 2.4.2: critical parse error, fatal in the 2.x CLI too. `/* @name A */\nSELECT 1\n/* @name B */\nSELECT 2;` → `errors: ["Statement for @name A is not terminated by \";\""]`. Rule 3 now reads "Statements are separated by semicolons; the last statement in a file may leave its semicolon off."                                                                                                                                                                                                         |

## Release notes — corrected, no longer outstanding

Four separate findings reported that the 3.0.0 changelog on
`origin/release-please--branches--master` contradicted the shipped API, because release-please had
aggregated upstream 2.x commit subjects for features the rewrite then removed or renamed:

- Features listed `add support for streaming (#569)` and `run method that returns affected row count
(#598)`, while BREAKING CHANGES in the same entry said `stream() and ICursor are removed` and
  `runWithCounts is replaced by execute()`. Verified absent: `grep -rn "stream\|ICursor\|runWithCounts"`
  over `packages/runtime/src` and `packages/cli/src` returned nothing but the migration prose in the
  runtime README.
- Two BREAKING CHANGES bullets disagreed about `query()`. The wrong one claimed it "now accepts
  `string | QueryConfig`"; typechecking the built package gives
  `error TS2345: Argument of type 'string' is not assignable to parameter of type 'QueryConfig'`.
- `PreparedQuery` was said to keep "a deprecated alias … until codegen catches up". It does not:
  `packages/runtime/src/index.ts` exports no `PreparedQuery`.

**All three are already corrected** in the current changelog entry: the phantom Features lines are
gone, `query()` has a single correct bullet, and the `PreparedQuery` bullet now reads "the
transitional alias was removed before release." Recorded here so nobody re-files them.

## Checked and found healthy

Recorded so nobody re-checks them.

- **Watch mode.** `pgtyped -c cfg -w` against two nested directories: the initial `add` generated
  both files, editing a `.sql` regenerated it, and a newly created `.sql` was picked up. No
  regression from the chokidar 4 → 5 bump. One cosmetic wart: an edit fires twice, producing a
  `Skipped … no changes` followed by a `Saved`.
- **Concurrency.** `describe()` checks a client out of the pool and drives an unnamed
  `Parse`/`Describe`/`Sync` on it, releasing in `finally`. `pg` serialises per client, so the 2.x
  "dropped messages under concurrency" class of bug has no foothold. The full example suite (26
  tests, 12 files, `MAX_CONCURRENCY = 4`) passes.
- **`--uri`.** A config with no `db` block plus `--uri postgres://…` generated correctly.
- **`ts-implicit` rejection** produces the intended bespoke message rather than a raw zod error.
- **Env-var precedence** (`PG*` beating both the config and `--uri`) is unchanged from 2.x and matches
  `docs-new/docs/cli.md`. It is the trigger for the stale-`PGPASSWORD` case and for the `dbUrl`
  footgun above, but is not itself a regression.
- **Catalog-row reshaping for `pg`.** The areas called out as risky were probed specifically and no
  regression found: `attnotnull` as a real boolean (result types are correctly non-null), OIDs as
  numbers (`attid` string-keying still matches), `typcategory`/`typtype` as single-char strings (enum
  arrays resolve), enum arrays via `array_agg`, `typelem` of 0 correctly falsy for non-arrays, and
  column comments still attaching (`/** the foo column */`).
- **Result nullability** correctly honours `NOT NULL` — the `pg`-parses-booleans hazard around
  `attnotnull` is handled, with a comment in `db/types.ts` saying as much.

---

# Not applicable

Triaged and closed out. Nobody needs to look at these again.

| #                          | Title                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #375                       | Type inference issues in the Postgres engine         | A meta/tracker issue listing eight sub-issues. Nothing to verify; it is a label, not a report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| #566                       | What approach can you recommend for data grouping?   | A usage question about shaping joined rows in application code. No pgTyped code path is implicated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| #504                       | Multiple databases support                           | The feature does not exist, and 3.0 made asking for it a hard error rather than a silent no-op: the reporter's proposed config now fails fast with `db: Expected object, received array`. There is also no `exclude` key. Nothing regressed — the request is simply unimplemented, and now un-expressible rather than quietly ignored.                                                                                                                                                                                                                                                                                                       |
| #564                       | `typesOverrides` converts relative paths undesirably | Behaviour is correct and documented; the report is a misunderstanding. `docs-new/docs/typing.md` states "All relative paths must be relative to the root of your project." Verified end to end: config `"./common.js#LobbyStatus"`, real file at `<root>/common.ts`, generated `src/nested/f.queries.ts` emits `import type { LobbyStatus } from '../../common.js';` — correct. The reporter's file was under `src/`, so `"./src/common.js"` was the right config value and their `@src/*` tsconfig workaround was unnecessary. At most, cross-link the root-relative rule from the `typesOverrides` examples.                               |
| #50                        | MySQL support                                        | PgTyped is built on the Postgres extended-query protocol (`Parse`/`Describe`); 3.0 doubled down by adopting node-postgres. No shared code path exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| #316                       | Dependency Dashboard                                 | An upstream Renovate bot issue about `adelsz/pgtyped`'s own dependencies. This fork has its own `renovate.json`. Not a bug report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| #578                       | Website localization                                 | Docs-infrastructure request against the upstream site. A fork decision, not a 3.0 question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PR #615                    | jest monorepo → v30                                  | The fork has no jest; every package tests with vitest (catalog `^5.0.0`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PR #619                    | Update all non-major dependencies                    | Touches `packages/wire/package.json` and `docs-new/package-lock.json`, neither of which exists here. The fork's remaining targets are already at or above the proposed floors via the pnpm catalog. An npm-lockfile PR against a pnpm workspace regardless.                                                                                                                                                                                                                                                                                                                                                                                  |
| PR #555                    | A fourth `@param x -> ARRAY[…]` expansion            | Written against the **ANTLR grammar** in `packages/parser`, which no longer exists. Beyond that the use case is already served: `SELECT * FROM UNNEST(:vals!::text[])` with `{ vals: ['x','y'] }` returns two rows — node-postgres binds a JS array to a single `text[]` placeholder. That keeps the SQL text fixed, so the query still gets a canonical prepared-statement name; a variable-arity `ARRAY[$1,$2,$3]` transform would forfeit it, against this fork's prepared-statement direction. **Unverified:** no attempt was made to construct a query where an array _literal_ is genuinely required and a bound `text[]` will not do. |
| PR #622, #623              | lerna → 8.2.4 / v10                                  | `package-lock.json` only. The fork uses pnpm workspaces + release-please; there is no lerna anywhere in the tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PR #639                    | Fix `AsyncQueue.replyPending`                        | Fixes `packages/wire`, the hand-rolled wire-protocol client, which was deleted. Both codegen and the runtime go through node-postgres now, so the message-dropping race cannot occur. The bug it describes is genuine and its regression test is well written — it just has no code left to protect.                                                                                                                                                                                                                                                                                                                                         |
| PR #584 (formatting hunks) | —                                                    | The substantive change was taken; the PR also reverts prettier's formatting on four unrelated blocks and adds two stray blank lines, and `pnpm lint` gates on `prettier --check .`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PR #580 (mechanism)        | —                                                    | The goal is right; the mechanism — a second positional constructor argument rewriting every generated file — is wrong here, because the fork already serialises `queryName` inside the IR.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PR #637 (as written)       | —                                                    | Do not merge verbatim: unamended it converts working `string`/`number`/enum columns into `unknown` plus a hard codegen error for any project with domain columns and no per-domain `typesOverrides` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PR #620 (as written)       | —                                                    | Re-splits the CLI into a second `@pgtyped/typegen` package, against the deliberate 6→3 consolidation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PR #614 (as written)       | —                                                    | Applies `(null \| T)[]` in both scopes and renames every generated alias `TArray` → `NullTArray`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PR #524 (as written)       | —                                                    | `parseEnvTemplate` slices the whole input rather than the match, so only an exact `{{VAR}}` value works; non-template literals are discarded; and it loosens `db.port` to `number \| string`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

# What was not verified

Collected from every bucket, so the gaps are in one place.

- **EMFILE (#609, PR #616).** Not reproduced on macOS at `ulimit -n` 64. The unguarded watcher was
  definitely present and a different, arguably worse consequence of it _was_ reproduced. Treat the
  EMFILE half as plausible-but-unverified; the original report is from Linux CI.
- **#610 (Bun).** Bun is not installed on this machine, so the reporter's case could not be run. What
  _can_ be stated: the exact code the report blames is unchanged — `packages/cli/src/config.ts` still
  has `const { default: parseDatabaseUri } = dbUrlModule as any;` under a comment that literally says
  `// module import hack`, a double-default unwrap whose correctness depends on the host's CJS/ESM
  interop. It resolves to a function under Node 24; Bun's interop differs, which is precisely the
  reported `parseDatabaseUri is not a function`. Note also that 3.0 sets `engines.node >= 24` and is
  ESM-only, so Bun support is a larger question than this line. **Do not claim this fixed.**
- **2.x behaviour on a connection failure.** Read from `git show 90e567b:packages/cli/src/index.ts`,
  not executed. The 2.x packages are deleted on this branch and building them would have meant
  modifying the checkout.
- **The #503/#594 root-cause mechanism** is reproduced for `custom_time` (OIDs and `pg_attribute` rows
  printed directly). The parameter-side claim conflicts between two reproductions and should be
  re-checked before anyone relies on it.
- **Windows path handling for `-f` (#579)** was approximated by passing a backslash string on macOS.
  The failure mode is the same string comparison, but nothing ran on Windows.
- **PgBouncer transaction-pooling mode**, which `unprepared()` exists for, was not exercised.
- **#561 (permissions)** and **#513 (DDL source)**: verified only that the feature does not exist and
  that the code path the reporters describe is unchanged. No attempt was made to build either to
  confirm feasibility.
- **PR #563**: only the missing-`SELECT`-privilege case was reproduced; column-level grants were not,
  and the `PREPARE`/`EXPLAIN EXECUTE` replacement was not prototyped.
- **PR #620**: the packaging defect was reproduced, the PGlite claim was not.
- **PR #582**: the current output and the patched branch were confirmed; the flag was not built.
- **PR #524**: the implementation was read and the env-precedence footgun reproduced; upstream's own
  test file was not run.
- **PR #624**: pg18 verified for codegen and the example suite only.
- **Renovate PRs** were assessed against manifests, not by installing.
- **Array-type parsers**: only six array OIDs were probed (`_text`, `_int4`, `_int8`, `_numeric`,
  `_timestamptz`, `_point`).

---

# Index

Every triaged number, and where it is covered.

**Issues (70).**
#50 NA · #143 feature · #151 fixed · #159 fixed · #170 limitation/docs fixed · #202 feature ·
#213 open-cheap · #221 open · #263 limitation · #273 open · #292 fixed · #314 open · #316 NA ·
#317 open · #348 limitation · #375 NA · #394 fixed · #395 feature · #404 fixed (warn) ·
#410 fixed upstream · #446 limitation/docs fixed · #454 fixed · #455 limitation · #459 feature ·
#460 open · #491 open (docs) · #498 open · #503 open · #504 NA · #512 feature/workaround ·
#513 limitation · #517 open · #522 adopt #580 · #523 adopt #524 · #526 **FIXED here** ·
#534 open-cheap · #548 fixed (residual docs) · #549 limitation · #551 limitation · #552 open ·
#556 adopt #582 · #557 feature · #560 feature · #561 limitation · #564 NA · #565 open ·
#566 NA · #567 open · #572 open (docs) · #573 open-cheap · #574 fixed · #576 feature ·
#578 NA · #579 open-cheap · #583 limitation · #584 → PR · #585 fixed · #586 feature ·
#594 open · #599 fixed · #604 fixed · #609 **FIXED here** · #610 unverified · #611 fixed (bcc4b07) ·
#613 open · #625 fixed · #629 feature · #630 open · #634 limitation · #636 fixed · #640 fixed

**Pull requests (27).**
#524 adopt (rewrite) · #545 already fixed · #553 open bug · #555 NA · #563 adopt (medium) ·
#580 adopt (cheap) · #582 adopt (small) · #584 **FIXED here** · #612 **FIXED here** ·
#614 adopt (rescope) · #615 NA · #616 **FIXED here** · #619 NA · #620 adopt packaging only ·
#622 NA · #623 NA · #624 adopt (trivial) · #627 already fixed · #628 already fixed ·
#632 already fixed · #633 already fixed · #635 already fixed · #637 adopt (amended) ·
#639 NA · #641 already fixed · #642 adopt (trivial) · #643 already fixed
