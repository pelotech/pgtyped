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
  not modified for any reproduction — except #565, whose reproduction is now pinned there
  permanently, as a barrel over every generated file.
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

Three of the cheap ones were taken as part of writing this document, the mis-mapped types were taken
straight after it, and the six that were left in **Still open — cheap** have since been taken as
well. That bucket is now empty. Ten entries from **Still open — medium** have since been taken as
well, which empties that bucket too: domain types — the one adoption in this list that needed real
code — the `failOnError` escalation for a type the mapping does not know, the column-shaped
`typesOverrides` key, duplicate keys in a generated interface, the diagnosis for an empty array in
a spread (the rendering question
it raises is recorded there and stays open), the silence around an ambient `PG*` variable
displacing an explicit config value (its precedence is deliberately unchanged), the pre-flight
privilege check of PR #563, whose technique was prototyped against a live server before anything was
built on it and which shipped as the opt-in `checkPrivileges`, the element nullability of array
results, which absorbs the PR #614 adoption entry, the shared type aliases of #565, the only one
here that changes the shape of generated output unasked, and the key types of #498/#517/#630. PR
#563 is an adoption rather than a bug, as are the three entries before the #565 one — the cheapest
three in **Worth adopting from upstream** (PRs #580, #624 and #642), which have also been taken — and
so is the last entry below, PR #582's `optionalNullParams`, the fifth adoption taken from that
bucket. Everything here is listed first so nobody re-opens it, with the reproduction that justified
each.

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

### `tstzrange` and the other range types were unmapped — issue #213 — **FIXED**

Was absent from `DefaultTypeMapping` (`packages/cli/src/types.ts`), so a range column generated:

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

**Fixed.** All six built-in range types — `int4range`, `int8range`, `numrange`, `tsrange`,
`tstzrange`, `daterange` — are in `DefaultTypeMapping` as `string` in both directions, which is what
node-postgres sends and receives: it registers no parser for any of them, so the value is the
server's own literal. An existing `typesOverrides` entry still wins, so the workaround above keeps
working unchanged.

**Deliberately not covered, and worth knowing.** A user-defined range, and a multirange (PG14+),
still need a `typesOverrides` entry — they are not built-in type names. An _array_ of ranges is the
`_bit` case recorded under #552: pg-types cannot parse it either, so a `tstzrange[]` arrives as one
raw string while the derived type says `stringArray`. Both are noted in the code.

**Regression cover.** `packages/cli/src/types.test.ts` pins all six in both directions and asserts
the allocator records no error for them; `packages/example` grows a `period TSTZRANGE NOT NULL`
column on `driver_types`, so the declaration is checked against the live server the way the other
driver-type columns are — including the parameter direction, which round-trips a range literal
through an INSERT.

### `.sql` discovery included `node_modules` — issue #534 — **FIXED**

Reproduced: `globSync('/tmp/.../src/**/*.sql')` returns `src/node_modules/somepkg/b.sql`. Neither
`globSync` in `packages/cli/src/typescriptAndSqlTransformer.ts` nor the chokidar watcher in the same
file excluded `node_modules`.

(The reporter's specific `.bin/tsc` lines would be filtered by today's minimatch predicate; the core
complaint — files under `node_modules` are parsed — reproduced exactly.)

**Fixed.** Discovery moved into an exported `findQueryFiles`, which passes
`ignore: ['**/node_modules/**']`, and the watcher's ignore predicate into an exported
`isUnderNodeModules`, which splits on either separator so it holds on Windows too. Returning true for
the directory itself is what stops chokidar descending into an installed tree at all, so watch mode
spends no descriptors on it.

Extracting both is also what makes the fix testable: `packages/cli/src/typescriptAndSqlTransformer.test.ts`
plants a dependency with its own `.sql` files under `srcDir` and asserts neither is found, without
needing a database. A directory merely _named_ like one (`node_modules_helpers/`) is still scanned.

### `--file` only matched one exact spelling of the path — issue #579 — **FIXED**

Half of it was already fixed. The reported "all files are regenerated anyway" was gone — verified:
with a non-matching `-f`, `multi/b/two.queries.ts` was never written. The other half was not:
`fileList.includes(fileOverride)` in `typescriptAndSqlTransformer.ts` was raw string equality against
glob output, identical to 2.x.

| `-f` argument                                   | Result                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `multi/a/one.sql`                               | works                                                                            |
| `./multi/a/one.sql`                             | `File override specified, but file was not found in provided transforms`, exit 0 |
| `/tmp/pgt-repro/multi/a/one.sql`                | same                                                                             |
| `multi\a\one.sql` (the Windows reporter's case) | same                                                                             |

**Fixed.** Both sides are resolved against the working directory (`path.resolve`, which is the same
comparison as the `path.relative(cwd, resolve(x))` suggested above and one call shorter), so files
are compared rather than strings and the platform decides what a separator is. Every row of the
table above now matches. The glob's own spelling is what gets processed, so the `Processing …` lines
no longer depend on how the flag was typed. The not-found message moved to stderr and the run exits
**1**: a targeted regeneration step that matches nothing used to report success.

**The related footgun is fixed too, and it was a one-liner.** `yargs.env()` is now `.env('PGTYPED')`,
so options come from `PGTYPED_CONFIG`/`PGTYPED_WATCH`/`PGTYPED_URI`/`PGTYPED_FILE` and an ambient
`FILE` is nobody's business but the shell's. This is a breaking change for anyone who was setting the
unprefixed form deliberately, and is in the runtime README's upgrade notes.

**Regression cover.** The matching itself is unit-tested against all four spellings from the table
(`typescriptAndSqlTransformer.test.ts`). The environment prefix is tested end to end through the
built CLI in `cli.test.ts`, using `--file`'s `conflicts: 'watch'` as a discriminator that needs no
database — whether yargs refuses the combination says whether the variable reached the flag. The
exit code and the `./`-prefixed and absolute spellings are tested in `packages/example`, which is
the only suite with a live server to get that far.

**A detail worth recording:** the refusal a user sees for `--file` with `--watch` is yargs' own
`Arguments file and watch are mutually exclusive`, not the CLI's
`File override is not compatible with watch mode` — `conflicts` fires first, so that `fatal` call is
unreachable. Left alone; noted here so the next person does not chase it.

### Pick-expansion keys were never optional — issue #573 — **FIXED**

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

**Fixed** exactly as described: the `else` branch of the param loop in `queryToTypeDeclarations`
now appends `?` when `!p.required`, mirroring the scalar branch three lines above.

**Checked before doing it, because the `?` has to be true and not just convenient.** `render` in the
runtime reads each key off the object (`paramValue[name]`) and pushes whatever it finds; there is no
required-key enforcement anywhere on the runtime path, and node-postgres sends `undefined` as NULL.
So an absent key and an explicit `undefined` already reached the server identically — the `?`
describes what worked rather than enabling anything new. It is purely widening: every params object
that compiled before still compiles.

**On the collision with PR #582 / issue #556.** Those wanted a config flag that makes non-required
_scalar_ params non-optional, which is the opposite direction on the neighbouring line. Far from
foreclosing them, this change is what let them be
[adopted](#a-non-required-parameter-was-always-an-optional-member--pr-582-issue-556--fixed-adopted):
`optionalNullParams` governs both branches together, so the two kinds of parameter cannot disagree
about what "optional" means, and making them agree here is the precondition that made one flag
governing both possible.

**Regression cover.** `packages/cli/src/generator.test.ts` gains the reporter's own mixed case
(`(line1!, line2, city!)`) in both `sql` and `ts` mode, and the three existing pick expectations
moved with the output. `packages/example` regenerates one key — `categories` in
`@param books -> ((rank!, name!, authorId!, categories)...)` — and gains a test that omits it
entirely and asserts the column came back NULL.

### The CLI package's `exports` map hijacked the importing process — found while evaluating PR #620 — **FIXED**

Independent of whether #620's package split is adopted (it should not be — see
[Not applicable](#not-applicable)), `packages/cli/package.json` had no `"."` entry and mapped `"./*"`
onto `./lib/index.js`, which was the `#!/usr/bin/env node` bin with top-level yargs parsing and
`process.exit`.

Reproduced with the CLI symlinked into a scratch project's `node_modules`:

```
import('@pelotech/pgtyped-cli')             -> ERR_PACKAGE_PATH_NOT_EXPORTED
import('@pelotech/pgtyped-cli/generator.js') -> prints the CLI's --help text and
                                                "Missing required argument: config"
                                                into the importing process
```

Any subpath import took over the host process.

**Fixed.** `index.ts` is now the library — it exports `main` and its only import-time effect is
configuring nunjucks — and a new `cli.ts` holds the shebang, the yargs parsing, the watch-mode config
watcher and the exits. `exports` gains a real `"."`, and `"./*"` resolves to `./lib/*`, so a subpath
import yields the module it names instead of the bin. `bin.pgtyped` points at `lib/cli.js`.

**Preserving the exit codes was the constraint, and it shaped the split.** `main` returns the code
the run earned — `undefined` in watch mode, which has no end — and `cli.ts` calls `process.exit` at
exactly the point the old top-level code did. `fatal` still ends the process from inside `main` on an
unreachable database, deliberately: routing that through a thrown error would have lost the
underlying pg message, which is the useful half of that report. So `main` is honest enough to import
but not yet a clean programmatic API; the stable public API behind #620 remains a separate design
task.

**Regression cover.** `cli.test.ts` builds a scratch project with the package symlinked into
`node_modules` and imports it through the real `exports` map, which is the thing under test:
`import('@pelotech/pgtyped-cli')` must yield `main` with empty stderr and exit 0, and
`import('@pelotech/pgtyped-cli/generator.js')` must yield `generateInterface` rather than the CLI's
`--help`. Reverting the manifest to either of its two bad shapes reproduces the exact upstream
symptoms — `ERR_PACKAGE_PATH_NOT_EXPORTED` for the first, `Missing required argument: config` for the
second.

**Breaking, and it needed following through the repo.** The bin path moved, so
`packages/example/docker-compose.yml` (both the `build` and `watch` services), the CLI's own exit-code
tests and the example's `codegen exit code` test all had to be repointed at `lib/cli.js`. Anyone
invoking the CLI by path rather than through `npx pgtyped` has the same edit to make; it is in the
runtime README's upgrade notes.

### Docs and repo residue — issues #491, #548, #572 — **FIXED**

All one-line fixes, verified present at the time of triage:

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

**Fixed.**

- `faq.md` has content — the questions this triage kept turning up, each pointing at the page that
  answers it properly — and is in `sidebars.js`, so it renders.
- The clone and repo URLs point at `pelotech/pgtyped`, in `CONTRIBUTING.md`,
  `packages/example/README.md`, `packages/cli/README.md`, `docs-new/docs/getting-started.md`,
  `docs-new/docusaurus.config.js` (the header link and the docs `editUrl`) and the root README. Two
  URLs were **not** repointed and the reason matters: the `adelsz/pgtyped/issues/…` links in
  `generator.ts` and `typescriptAndSqlTransformer.ts` are citations of upstream issues, which is
  where those issues actually live. The root README's `github/v/release/adelsz/pgtyped` badge was
  dropped rather than repointed — this fork publishes to GitHub Packages and cuts no GitHub releases,
  so the repointed badge would have read "no releases" and the original was reporting a version this
  fork does not ship.
- The example README's steps are corrected end to end, not just at step 4: the build has to run from
  the repository root (the example's own `pnpm build` is the `echo`), so the `cd` moves and step 5
  enters `packages/example` itself.
- **#572 got a code change as well as the parenthetical.** `srcDir`'s resolution is left alone —
  changing it would silently relocate every existing project's source directory — but a transform
  whose glob matches nothing now warns, naming both the pattern and the working directory it was
  resolved against. That is the missing signal the reporter actually hit. `docs-new/docs/cli.md`
  documents the resolution rule in the config table, and the `--file` and `PGTYPED_` changes from
  #579 are documented there too.

### Domain types were flattened to their base type — issues #503, #594; PR #637 — **FIXED**

`typesOverrides` keyed on a domain name silently never fired for result columns, and a domain over an
enum lost the enum.

Reproduced on pg17, and re-verified on pg18 while fixing it:

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

No import of `./types` was emitted at all — dead config, no warning. Same for a direct column alias
(`SELECT contact AS c1` → `c1: string`).

Independently reproduced with `CREATE DOMAIN uint128 AS numeric(39,0)` and
`"typesOverrides": {"uint128": "BigInt"}` → generated `big: string | null`, override ignored, while
the control in the same run (`"interval": "./types#PgInterval"`) **was** respected. The symptom had
changed since #594 was filed: 3.0 no longer errored
`Postgres type 'uint128' is not supported by mapping`, it silently resolved to the base type.

**Root cause, traced and instrumented:** Postgres reports the domain's _base_ type OID in
RowDescription, never the domain's own OID.

```
custom_time   oid 16406  typtype d  typbasetype 1184
timestamptz   oid 1184
RowDescription dataTypeID for domain column ctime: 1184   <- base type, not 16406
```

So `typeMap[f.typeOID]` could only ever resolve to the base type name. `DatabaseTypeKind.Domain` was
declared in `packages/cli/src/db/type.ts` and never used.

**Fixed** by the amendment PR #637 does not contain. `getTypes()` in `packages/cli/src/db/types.ts`
**already ran** a `pg_attribute` query per result column, for `attname`/`attnotnull`, and
`pg_attribute.atttypid` holds the _domain_ OID:

```
attrelid | attnum | attname | atttypid | attnotnull
   16408 |      2 | ctime   |    16406 | t
```

That query now also selects `atttypid` and runs _before_ the catalog query rather than after, so the
declared type is one of the OIDs the catalog query covers. No extra round trip.

**Merging #637 verbatim would have regressed every project with a domain column.** Remapping the OID
makes the catalog query return the _domain_ row (`typtype = 'd'`, `typname = 'email'`), and
`reduceTypeRows` had no domain branch — it yielded the bare string `'email'`, which
`TypeAllocator.use()` does not know. Verified on the same code path with a composite type, which is
also an unmapped type name:

```
$ node packages/cli/lib/cli.js -c config.json     # SELECT ROW('a','b')::addr AS a
Error: Postgres type 'addr' is not supported by mapping
...
  a: unknown | null;
```

So a domain now reaches the allocator as a `DomainType` — its own name, plus whatever its base type
resolved to. The name is offered to the mapping first, which is what makes an override fire; when
nothing claims it the type resolves to its base, which is exactly what the column generated before.
`mood_d` with no override is still the `mood` union, `contact` with no override is still `string`,
and neither logs anything. A domain over a domain follows the chain, so an override on the inner one
applies to the outer.

**The parameter direction moved further than expected, in the fix's favour.** The two reproductions
in this document appeared to contradict each other on whether ParameterDescription carries the domain
OID. It does — but only where the server has no reason to resolve the parameter to something else,
which is a property of the query rather than of the column:

| query                                        | `$1` reported as |
| -------------------------------------------- | ---------------- |
| `INSERT INTO accounts (contact) VALUES ($1)` | `email` (16385)  |
| `SELECT … WHERE contact = $1`                | `text` (25)      |

Where the domain _is_ reported, an override already worked — and, without one, codegen **failed**:
`Postgres type 'email' is not supported by mapping` and `contact: unknown`, on an INSERT into any
domain column. That is now the base type, `contact: string`. Where the server reports the base type,
nothing can be done: there is no column to consult, so `WHERE contact = :contact!` stays `string`.

**Scope limits, all reproduced.**

- Domain-typed _expressions_ stay flattened. `SELECT contact::text` and `SELECT upper(contact)` both
  report `tableID = 0`, so there is no source column to read a declared type from — which is also
  what stops a cast from being mistaken for the column it was applied to.
- An _array_ of a domain (`email[]`) is unchanged, and is the `_bit` case from #552 in a different
  costume: RowDescription reports `_email` itself, so an override on `email` already applies to its
  elements (`EmailArray = (Email)[]`), and _without_ one it still logs
  `Postgres type 'email' is not supported by mapping` and generates `unknownArray`. The element type
  arrives as a name rather than as an OID, so the domain machinery does not reach it.
- A domain's own `NOT NULL` constraint is still not read; nullability comes from the column.

**Regression cover.** `packages/cli/src/db/types.test.ts` drives `getTypes` against a fake server
that answers the catalog queries with the same `IN (…)` filter the real one applies, so the base type
that is fetched in a second round trip is genuinely absent from the first: it pins the remap, the
alias, the domain-over-domain chain, the two guards that stop an expression or a disagreeing base
type from being remapped, and that a query with no domain in it makes exactly one catalog query.
`packages/cli/src/types.test.ts` pins the allocator half — override wins, no override falls back to
the base with no error recorded, a domain over an enum keeps the union, and an override on one
direction only leaves the other on the base type. `packages/example` grows a
`contact EMAIL_ADDRESS NOT NULL` column on `driver_types` with an override to a template-literal type
that a plain `string` does not satisfy, so the example's typecheck — which CI runs — fails if the
domain is ever flattened again. Reverting the fix and regenerating produces exactly that:
`src/index.test.ts(342,11): error TS2322: Type 'string' is not assignable to type '`${string}@${string}`'.`

### `record` was unmapped, and `failOnError` did not catch it — issue #317 — **FIXED**

Reproduced with the reporter's exact message: `Error: Postgres type 'record' is not supported by
mapping`. Unchanged from 2.x (`git show 90e567b:packages/cli/src/generator.ts` has the same
`types.errors.forEach((err) => console.log(err))`).

Two sharp edges: the column was emitted as `row: unknown | null`, and **`failOnError: true` did not
catch it** — verified `exit=0` with `failOnError: true`. The code comment in `generator.ts` claimed "a
`never` type is emitted which can be caught later when compiling"; it emitted `unknown`, which nothing
would catch.

**Fixed, in the escalation rather than in the mapping.** Supporting composite types is a separate and
much larger question (#629) and is deliberately not attempted here. A `TypeAllocator` error is now
advisory by default, exactly as it was, and fails the run under `failOnError` — the same rule the
parser warnings and the nullability-suffix warning already follow. The message names the query and
the file, like the #526 fix, and lists the types that failed.

**`unknown` was kept deliberately, and the old comment was wrong twice.** It claimed `never` was
emitted, and it emitted `unknown`; and `never` would have been the _weaker_ of the two, not the
stronger. `never` is assignable to every type, so a `never` result column makes
`const total: number = row.row` compile silently — precisely the "caught later when compiling" the
comment promised, and precisely what it would not do. `unknown` is assignable to nothing, so the
caller has to narrow it before using it, which is the compile error the comment always wanted. So the
generated output does not change; only the exit code does.

```
$ node packages/cli/lib/cli.js -c config.json   # failOnError: true, SELECT ROW(1,2) AS r
Error processing src/record.sql: Query "GetRecord" in src/record.sql uses types the mapping does not
support:
Postgres type 'record' is not supported by mapping
Add a "typesOverrides" entry for each, or remove the column from the query.
exit=1, and src/record.ts was not written
```

**A second defect was found doing it, and fixed with it.** The allocator is shared by every query in
a file and accumulates errors, and the reporting loop printed the whole array — so each error was
printed again for every query that followed it in the file. Only the errors a query raised itself are
reported now, which is also what makes the thrown message attributable to one query.

**Regression cover.** `packages/cli/src/generator.test.ts` pins all four behaviours: `unknown` plus
one logged error by default, the throw under `failOnError` naming query and file, one report per
error rather than one per following query, and a clean query later in the same file still generating
even though the allocator still carries the earlier error. `packages/example` runs the built CLI
against a scratch project whose only query is `SELECT ROW(1,2) AS r`, and asserts the pair that
matters end to end: exit 0 with `r: unknown` written by default, and a non-zero exit with **nothing
written** under `failOnError`.

### A column-shaped `typesOverrides` key was silently accepted and silently ignored — issue #567 — **FIXED**

`typesOverrides` is keyed by type name only. Because the schema was `z.record(…)`, a column-shaped key
passed validation and did nothing — no warning, no error:

```json
"typesOverrides": { "lobbies.status": "./x.js#MyStatus" }
```

```ts
export interface ColMapResult {
  status: lobby_status;
} // override had no effect
```

That is a bad failure mode next to 3.0's new strictness elsewhere.

**Fixed by rejecting the key, not by implementing the feature — and the reason is the parameter
direction.** A result column can be traced back to its table: `getTypes` already knows the table OID
and the attribute number, and one join on `pg_class` would give it the name. A _parameter_ cannot.
ParameterDescription carries type OIDs and nothing else, and nothing in the protocol connects the
`$1` in `WHERE status = $1` to `lobbies.status` — answering that needs a real SQL analyser, which is
the same thing #551 needs and does not have. A column-scoped override that quietly covered results
and not parameters would be the same defect one layer further in: a config entry that appears to
apply and does not.

So a key containing a dot is now a parse error naming the key, alongside the other config errors:

```
$ node packages/cli/lib/cli.js -c config.json
Failed to parse config file:
typesOverrides.lobbies.status: "lobbies.status" looks like a column, and typesOverrides is keyed by
Postgres type name — a column-scoped override has never had any effect (#567). Override the column's
type name instead, or give the column a domain type (CREATE DOMAIN) and override the domain's name.
exit=1
```

**Nothing that worked stops working.** No type name Postgres reports contains a dot —
`pg_type.typname` is not schema-qualified — so a dotted key never matched anything. If schema
qualification is ever supported in this map, this rule is the thing to revisit.

**The supported answer is a domain, and it is only supported as of the entry above.** `CREATE DOMAIN
lobby_status AS text` plus `ALTER TABLE lobbies ALTER COLUMN status TYPE lobby_status` gives that one
column a name the mapping can be keyed on, in both directions — which is exactly what the reporter
wanted, and would have silently failed before
[domains were fixed](#domain-types-were-flattened-to-their-base-type--issues-503-594-pr-637--fixed).

**Regression cover.** `packages/cli/src/config.test.ts` pins the rejection in both the string and the
`{ return }` form, that every bad key is reported rather than only the first, and that a plain type
name — the thing this must not break — still parses into the same override it always did.

### Ambient `PG*` environment variables overrode an explicit `dbUrl` silently — found while evaluating PR #524 — **FIXED (the silence)**

`parseConfig` merges `envDBConfig` last. Reproduced:

```
$ PGDATABASE=nonexistent_db node packages/cli/lib/index.js -c config.json
Could not connect to the database at localhost:55444 as user "postgres". No files were written.
database "nonexistent_db" does not exist
```

It failed loudly here only because `verifyConnection` now exists. With a _valid_ but wrong
`PGDATABASE` — a developer with `PGDATABASE=prod` exported in their shell — codegen would connect
happily and generate types from the wrong schema.

**The precedence is unchanged, and that is the decision.** Environment over config is a normal
convention, it is what this project has always done, and someone is relying on it — including this
repository's own example, which reaches the database in the compose network that way. Changing it
would break those setups to fix a problem they do not have. The defect was never the order; it was
that the displacement happened without a word, so the only case that ever surfaced was the one where
the displaced value was unreachable.

**Fixed by reporting the conflict.** When a `PG*` variable displaces a value the config file set
**explicitly**, `parseConfig` names both the variable and the field it replaced:

```
Warning: environment variable PGDATABASE overrides dbName from the config file: "prod" replaces
"app_dev", set by dbUrl. Environment variables take precedence over the config file, so that is what
PgTyped will connect with — unset PGDATABASE if it is not what you meant.
```

The source is named as `dbUrl` or as `db.<field>`, whichever set it. `PGURI`/`DATABASE_URL`
displacing the config's `dbUrl` is reported the same way, with neither URI quoted into the message —
a connection string carries the password. `PGPASSWORD` is named but never printed for the same
reason.

**Staying quiet is the harder half, and it is what the tests are mostly about.** Nothing is said
when the variable fills in a field the config left unset, which is the intended way to configure
PgTyped from the environment; when the config has no `db` section at all, so the value it "set" was
a default; when the variable agrees with the config; when it is the empty string, which `merge`
skips anyway; or when something between the config and the environment already displaced the value —
a `--uri` flag, or a `PGURI` that replaced the whole connection string — since then the environment
is not what the config lost to.

**One repository change followed from it, and it is the intended fix rather than a workaround.**
`packages/example`'s compose services set `PGHOST: db` over a config whose `dbUrl` says `localhost`,
which is exactly the shape being reported. They now pass `PGTYPED_URI` instead: the `--uri` flag
outranks both, so the container's connection is stated deliberately rather than arrived at by an
override nobody can see. Codegen for the example is silent again.

**A second defect was found doing it, and fixed with it.** `const { default: parseDatabaseUri } =
dbUrlModule` — the "module import hack" — depends on who performed the CJS interop. It is right under
node and wrong under vitest, where `dbUrlModule` is already the function, so **every code path that
parsed a connection string threw `parseDatabaseUri is not a function` in the test suite** while
working in the built CLI. No test had ever set `dbUrl`, so nothing noticed. Both shapes are accepted
now, which is what makes the `dbUrl` half of this entry testable at all.

**Regression cover.** `packages/cli/src/config.test.ts` pins both message shapes verbatim, that the
`db.<field>` source is named as such, that `PGPASSWORD`'s value appears in neither direction, and —
in four separate tests — each of the ways this must stay quiet. Every case also asserts the merged
result, so the precedence itself is pinned where it is.

### Empty array in a spread rendered `IN ()` — issues #221, #314, #273 — **FIXED (the diagnosis)**

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

**What is fixed is the report, not the rendering, and the split is deliberate.** There is still **no
correct SQL for "zero rows" in every position**: `IN (NULL)` is right for `IN` and wrong for
`VALUES`, where it would insert a row, and skipping the statement or substituting `WHERE false`
changes what the query means. That needs a design decision, and this is not it. What needed no
decision at all is _who_ the error is reported to. The user used to be handed the server's
`42601 syntax error at or near ")"`, which points at a paren in SQL they never wrote, in a statement
PgTyped generated, and names neither the parameter nor the call.

`render` now refuses an empty array before anything is sent, from both spread branches:

```
Query selectSomeUsers was passed an empty array for parameter "ids" (array_spread): a spread renders
one placeholder per element, and there is no SQL for zero of them — "IN ()" is a syntax error, and no
substitute is correct in every position. Check the array is non-empty before running the query. The
nonEmptyArrayParams codegen option makes a statically empty array a compile error, but cannot see the
length of one built at runtime.
```

It names the query, the parameter and its transform, so it identifies the offending call rather than
the SQL — which is the half of these three reports that was always answerable. `compile`, `execute`
and `run` all go through `render`, so all three refuse it, and nothing reaches the server.

**`nonEmptyArrayParams` keeps its default, and that is a decision rather than an omission.** It types
the param as `readonly [T, ...T[]]` and covers both `array_spread` and `pick_array_spread` —
verified: `ids: readonly [number | null | void, ...(number | null | void)[]]`, so the empty literal
becomes a compile error. But it is a **type-level guard only**: an array whose length is not known
statically was never covered by it, which is why the runtime check is the one that closes these
issues. Turning it on by default would be a breaking change to every project that passes an array
variable, and 3.0.0 has shipped; that belongs to the next major. The two guards are complements —
one catches the literal at compile time, the other catches the variable at call time.

**The documentation gap the earlier note asked for is closed.** `docs-new/docs/cli.md` described
`nonEmptyArrayParams` without ever mentioning `IN ()` or the runtime error it exists to prevent, and
`docs-new/docs/dynamic-queries.md` recommended the `:param::TEXT IS NULL` optional-filter pattern
without saying that it works for **scalars only** — a spread has no value that means "no filter",
since `null` is not an array and `[]` renders nothing between the parens. Both now say so, and the
FAQ entry describes the throw rather than the syntax error.

**Regression cover.** `packages/runtime/src/render.test.ts` pins the message verbatim for
`array_spread` and, since the two render through different branches, separately for
`pick_array_spread` — plus the `$$ids` tag form, and the cases that must keep working: a
one-element array, and the no-params mapping form, which describes the shape of the query rather
than one call and so has no array to be empty.

### Duplicate keys in generated interfaces — not reported upstream — **FIXED**

Two result columns landing on the same field name emitted a TypeScript interface that will not
compile (TS2300), and codegen exited **0** — so the first signal was a type error in a file the user
did not write. Both spellings reproduced:

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
at `88a428f`) had no dedup either.

**Fixed by reporting it, because there is nothing to merge.** Two distinct columns cannot share one
field: dropping either loses a column the query selects, and renaming one invents a name the caller
would have to guess. So the query joins the family `queryToTypeDeclarations` already has for a query
whose result shape cannot be expressed — the one an anonymous column lands in. It is reported on
stderr, its `Result` and `Params` are emitted as `never` with the reason in a doc comment, and the
rest of the file still generates. Under `failOnError` it fails the run, like the type error beside
it.

**The message has two shapes, because the collision has two causes.** Where the columns really do
share a name, the SQL says so:

```
Query 'DupHint' has 2 result columns named "id". A TypeScript interface cannot declare the same key
twice, so no result type can be generated for it. Alias one of them to a different name.
```

Where `camelCaseColumnNames` created it, the SQL does _not_ say so — the two columns are spelled
differently — so the source columns are named:

```
Query 'Dup' has 2 result columns that camelCaseColumnNames collapses onto the field "userName":
"userName", "user_name". A TypeScript interface cannot declare the same key twice, so no result type
can be generated for it. Alias one of them to a name that does not collide, or turn
camelCaseColumnNames off.
```

**It settles the `@column` question rather than dodging it.** A hint is keyed by the Postgres result
column name, so a single `@column id!` matches _both_ columns of the `DupHint` query and silently
applies to each. Refusing the query is the only coherent answer available: the hint names a column
that occurs twice and says nothing about which of the two it meant. No hint can now apply
ambiguously, because a query with two same-named columns no longer generates at all.

**Regression cover.** `packages/cli/src/generator.test.ts` pins both message shapes verbatim — the
camelCase one naming both source columns, the same-name one _not_ blaming camelCase — the `never`
result, the `failOnError` escalation, and the case that must stay quiet: two columns that camelCase
to distinct fields (`user_name`, `user_id`) still generate both.

### Codegen accepted queries the connecting role may not execute — PR #563 — **FIXED**

Postgres checks table and column privileges at **execute** time, not at Parse/Describe time, so the
`DescribeStatement` path reported a perfectly good result type for a query the role could not run.

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

Half of what #563 was after was **already** caught: the second query in the same file,
`INSERT INTO secrets (id, value) …` against a `GENERATED ALWAYS AS IDENTITY` column, failed at Parse
with `428C9 cannot insert a non-DEFAULT value into column "id"` and was correctly emitted as `never`.
Only the privilege half was missing.

The opt-in `checkPrivileges` config option closes it. None of upstream's code survived — `packages/query`,
`packages/wire` and the raw Parse/Flush/Close plumbing are all gone — and neither, in the end, did its
technique. What shipped is one `EXPLAIN` per query after the describe, on the same pool: `EXPLAIN`
without `ANALYZE` plans the statement, which is where Postgres applies the privileges, and executes
nothing.

**The technique was prototyped before anything was built on it**, against live PostgreSQL 18.6 and
15.19 containers with a real role and real `REVOKE`s. What the prototype settled, question by
question:

- **Missing `SELECT` privilege** is surfaced as `42501`, with and without parameters.
- **Column-level grants are caught**, which is the case #563 was really for and the one this triage
  had never tested. With `GRANT INSERT (a, b)` and `GRANT UPDATE (b)` on a table, `INSERT INTO items
(a, b, c)` and `UPDATE items SET a = …` are both refused, while `INSERT INTO items (a, b)` and
  `UPDATE items SET b = …` plan cleanly. `INSERT … RETURNING id, a` is refused too, because
  `RETURNING` needs `SELECT` on the columns it names.
- **It is safe for DML.** `INSERT`, `INSERT … RETURNING`, `UPDATE`, `DELETE`, `INSERT … ON CONFLICT
DO UPDATE` and a data-modifying CTE were all planned, inside a transaction and outside one, and a
  full before/after snapshot of every row and both sequences was byte-identical. Nothing is written
  and no sequence advances, so no transaction is wrapped around the check — there is nothing to roll
  back.
- **Parameters are not a problem, and caveat 3 is settled.** Two findings, both against the recorded
  technique rather than against what shipped. First, the rendered query codegen describes has a
  _fixed_ `$n` per placeholder — an array spread renders `IN ($1)` and a pick spread `VALUES ($1,
$2)` at codegen time, the per-element expansion happening only at runtime — so the "spread" worry
  does not arise at all. Second, binding `NULL` for every parameter turned out to be dangerous in the
  _opposite_ direction from the one predicted: it produced no spurious error in any case tried, but
  it did produce a **false negative**. `WHERE id = $1 AND EXISTS (SELECT 1 FROM secrets)` folds
  `id = NULL` to a constant false, the planner drops the whole join tree, and `secrets` never gets
  checked — while the same query with a non-`NULL` parameter is correctly refused.
  `EXPLAIN (GENERIC_PLAN)`, new in PostgreSQL 16, plans `$1` as a parameter and binds nothing, which
  fixes the false negative and removes the premise of caveat 3 entirely. That is what is used on 16
  and up; before 16 there is no such option, `NULL` is bound, and the under-reporting is documented.
- **It costs one round trip per query**, plus one `SHOW server_version_num` per run. Measured against
  a local container at ~0.11 ms per `EXPLAIN (GENERIC_PLAN)` against ~0.14 ms for the equivalent
  parameterised query — the same order as the describe it follows, not the doubling the phrase "it
  doubles the round trips" suggests, though against a remote database it is a real latency cost on a
  large project.

Two of the entry's caveats are settled the other way from upstream, deliberately:

1. It is **opt-in and off by default** (caveat 1), because codegen very often connects as the schema
   owner or a migration role while the application connects as a restricted one — where the check is
   meaningless, and reassuring about exactly the queries it should not be. Upstream's hardcoded
   `const doTestRuns = true` (caveat 2) is not copied.
2. A privilege failure is a **warning that still generates the types**, and fails the run only under
   `failOnError` (caveat 3, though for a different reason than the caveat gave). The SQL is valid and
   the types describe it accurately; emitting `never`, which is what codegen does for a query it
   cannot describe, would break every call site over something only a `GRANT` can fix.

Only `42501` is reported. A statement `EXPLAIN` cannot plan at all — `TRUNCATE`, `CALL`, `SET`, DDL —
raises `42601` and is passed over in silence rather than reported as a permissions problem; it has
already been described successfully, so it is known to be valid SQL.

Covered by a live test in `packages/example` that creates a role, revokes one table outright, grants
two columns of another, and runs codegen as that role.

### Array elements were typed as non-nullable — issues #613, #460; PR #614 — **FIXED**

`getArray` produced `(T)[]`. A Postgres array may hold NULL elements whatever the column's own
nullability, so `(string)[]` was a lie for every `text[]` result. Reproduced:

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
`export type stringArray = (string)[];`. #613 and #460 are the same request, and are closed
together.

**A result now says so; a parameter is deliberately unchanged.** `TypeScope.Return` emits
`nullableStringArray = (string | null)[]`, and `TypeScope.Parameter` keeps
`stringArray = (string)[]`. Upstream's #614 applies the suffix in both scopes and renames every
alias `TArray` → `NullTArray`; the idea was taken and the patch was not. A caller passing `string[]`
was always correct, and widening what the input accepts is neither what #613 nor what #460 reports —
it only loosens the contract for every project that already compiles.

**The return scope's alias needs a name of its own**, which is the part of this that is not obvious.
`TypeAllocator` registers aliases by name with first occurrence winning, and one allocator serves
both scopes of a generated file. Two definitions under one name would emit whichever scope was
reached first and silently hand the other the wrong type. `packages/example` reaches both:
`categoryArray` is a result in four queries and a parameter in `InsertBooks`.

That collision turned out to be live already. `config.json` overrides `category` in the **return**
scope only, so the parameter direction resolves to the enum union — and yet `InsertBooks` generated
`categoryArray = (Category)[]`, the return scope's definition, because the return scope was reached
first. Splitting the names corrects the parameter to `(category)[]` as well as adding the elements'
`| null` to the result, which is why `books.queries.ts` shows both changes.

Element nullability lives inside the alias and the column's own nullability stays outside it, so a
nullable column of a nullable element type is `nullableCategoryArray | null`. `_json` is left
alone: `Json` already admits null as the first member of its union, so `JsonArray = (Json)[]` needs
no suffix and, having one definition in both scopes, no second name either. `formatArrayType` in
`generator.ts` is untouched too — it builds the list of bind values for a spread parameter
(`id IN :ids`), which is not a Postgres array type.

**Breaking, which is the point:** `row.tags.map((t) => t.toUpperCase())` stops being a silent
`TypeError` waiting to happen.

**Covered by** `packages/cli/src/types.test.ts`: both scopes of `_text`, `_int4`, the hand-written
`_numeric` entry and an enum array, pinned by definition string rather than by alias name — no test
asserted an array definition at all before, which is how this survived several passes over that
file — plus a regression test that drives both scopes through one allocator and asserts each alias
is emitted independently. In `packages/example`, a `@ts-expect-error` on
`const amounts: number[] = row.amounts` fails the build if the nullability is ever taken back off.

### Query name not reachable at runtime — issue #522, PR #580 — **FIXED**

The data was already there and simply was not exposed. `queryName` is serialised into every emitted
IR literal (`{"queryName":"GetAccounts", …}`), but `TypedQuery` held the IR in a `private readonly ir`
and published only `name`, which is the **prepared statement** name, not the query name.

```
codegen query .name:  GetAccounts_8bb00196     # preparedStatements: true
.name with preparedStatements:false -> undefined
public API surface: [ 'constructor', 'compile', 'execute', 'run', 'interpolate', 'split' ]
plain sql tag .name: undefined
sql.prepared('findAccount') .name: findAccount_e0594094
```

Three cases had **no public query identifier at all**: `preparedStatements: false`; a plain `sql`
tag; and any query with an array spread, which never gets a statement name even with prepared
statements on (confirmed in the committed example — `insertBooksIR` has no `"name"` field while its
13 siblings do). And even where `.name` was set it was `GetAccounts_8bb00196`, whose hash suffix
changes whenever the SQL is edited — unusable as a stable metrics dimension. The stated upstream
motivation is that a fork is being maintained solely for this.

**Fixed** as a `readonly queryName: string` assigned from `ir.queryName` in the constructor. It is
always present, never hashed, and does not move when the SQL does, so it is what a caller labels
per-query metrics, OpenTelemetry span names and slow-query logs with; `name` remains the identifier
the server knows, and is the one to look up in `pg_prepared_statements`.

**Upstream's mechanism was deliberately not taken.** PR #580 passes the name as a second positional
constructor argument, which would rewrite every generated file for data the IR already carries.
Reading it off the IR changes no generated output at all — `packages/example` regenerates
byte-identical — and a `sql` tag gets the property for free rather than needing codegen to inject it.

**One limit was found doing it, and it is documented rather than worked around.** A tag has no name
of its own at runtime unless it is given one: codegen derives a tag's name from the variable it is
assigned to, but that happens while generating types and never reaches the emitted query. So a plain
`sql` tag and a `sql.prepared()` called with no name both report `queryName` as the placeholder
`'query'`. Naming a tag with `sql.prepared('…')` is what makes it measurable, and the runtime README
says so.

**Regression cover.** `packages/runtime/src/typed-query.test.ts` pins each case the change exists
for: `@name` alongside a statement name; `preparedStatements: false`, where `name` is `undefined`
and `queryName` is not; an array spread, asserting through `preparedStatementName` that the name is
withheld by rule rather than merely absent from that IR; and an edit to the SQL that moves `name`
while leaving `queryName` alone. `sql.test.ts` covers the three tag forms, including the placeholder.

### The example's Postgres image was 17-alpine — PR #624 — **FIXED**

**Fixed**, and re-verified rather than carried over from the first pass, since the tree had moved
since. Against `postgres:18-alpine` (18.6, aarch64-musl) after a `docker compose down -v` so
`initdb` ran fresh on 18: codegen reports `Skipped … no changes` for all 15 files, `git status` is
clean, and the example suite is **35 passed**, identical to 17-alpine on the same tree. Regeneration
was run twice more to confirm it is stable. No behaviour difference between the two major versions
shows up anywhere the example reaches.

**What it buys:** broader coverage of what CI proves. A matrix over 17 and 18 would prove more than
the straight swap does, but CI runs this compose file directly, so that is a change to the workflow
rather than to the image tag, and it is not made here.

**Still unverified:** pg18 is checked for codegen and the example suite only, not for anything it
changes outside those paths.

### `actions/checkout` was two majors behind — PR #642 — **FIXED**

All three workflows (`main.yml`, `release.yaml`, `commit-conventions.yml`) were on
`actions/checkout@v5` and `pnpm/action-setup@v4`. **Both are now on v7 and v6 respectively**, and
both are pure runtime bumps for a consumer: `action.yml` declares an identical set of inputs and
outputs across v5→v7 for checkout and v4→v6 for the pnpm action, the latter differing only in
`using: node20` → `node24`. checkout v6 moved the token out of `.git/config` into a separate
credential file and v7 refuses to check out a fork's head for `pull_request_target` and
`workflow_run`; nothing here reads git credentials or uses either trigger.

**Two actions are deliberately left behind**, because their majors change behaviour rather than just
the runtime — the reason the sweep stops where it does:

- `actions/setup-node@v4` is **three** majors behind. v5 caches automatically when `package.json`
  carries a `packageManager` field, which this repo does (`pnpm@10.33.2`); v6 then narrowed that
  automatic caching to npm only. Every workflow here already passes `cache: 'pnpm'` alongside
  `pnpm/action-setup`, so how the two interact has to be worked out rather than assumed.
- `googleapis/release-please-action@v4` is one major behind. v5 is nominally just a node24 bump, but
  it carries release-please 17.3.0 → 17.6.0 with it, and this is the one workflow whose first real
  run happens on `master` rather than on a PR.

### Shared type aliases collide across generated files — issue #565 — **FIXED**

Re-checked after `197c625` gave the return and parameter scopes distinct array alias names. That
commit did not shrink this.

Reproduced on `197c625^` with two files that between them use one `lobby_status[]` in both
directions and a `typesOverrides` entry naming only the return scope. The result file declared
`export type lobby_statusArray = (LobbyStatus)[];`, the parameter file
`export type lobby_statusArray = (lobby_status)[];`, and both declared
`export type DateOrString = Date | string;`; `export *` from both gave TS2308 for
`lobby_statusArray` and for `DateOrString`.

On `197c625` that particular pair no longer disagreed: the result file declared
`nullableLobby_statusArray = (LobbyStatus | null)[]`, the parameter file kept
`lobby_statusArray = (lobby_status)[]`, and `export *` reported only `DateOrString`. But the two
definitions disagreeing was a separate defect — one name standing for two types, which #30 fixed
for its own reasons — and this issue never depended on it. Every alias that two generated files
both needed was still declared in both. Verified on `197c625`: two files selecting the array each
emitted `nullableLobby_statusArray = (LobbyStatus | null)[]` and `export *` still gave TS2308; two
files passing it as a parameter collided on `lobby_status` and on `lobby_statusArray` alike.

Reproduced once more inside `packages/example`, which is where it is now pinned. A new
`src/exportAll.ts` re-exports all seven generated modules; on `ec6c24d` that is four TS2308s —
`nullableCategoryArray`, `DateOrString`, `Json` and `notification_type` — and the package no longer
typechecks.

**What now happens.** Everything `TypeAllocator` used to emit into every file — enum unions, array
aliases, the driver types (`PgPoint`, `PgInterval`, `Json`, `DateOrString`, `NumberOrString`) and
the imports `typesOverrides` produces — is emitted **once**, into `<srcDir>/pgtyped-shared.ts`, and
each generated file carries one `import type` for the names it actually spells out. The example's
`books.queries.ts` now opens with
`import type { Iso31661Alpha2, category, categoryArray, nullableCategoryArray, … } from '../pgtyped-shared.js';`,
`src/exportAll.ts` typechecks, and the suite is **40 passed**. Per-query types (`FooParams`,
`FooResult`) are untouched: they belong to their query and stay in its file.

The new `sharedTypesFile` config key names the file — a path relative to `srcDir`, validated by the
zod schema — or takes `false` to restore the previous per-file declarations byte for byte. It is on
by default, which makes the generated output a breaking change; 3.0.0 is unpublished, so the shape
change costs nothing now and would cost a major later.

Two consequences the issue's reporter anticipated, and which are the substance of the work:

- **A name can no longer stand for two definitions.** `TypeAllocator` registers first-wins
  (`this.types[typ.name] = this.types[typ.name] ?? typ`), which within one file was the defect
  `197c625` fixed; across files into one target it is unrepresentable. Two generated files defining
  one name differently are now reported — the name, both declarations, and the file each came from
  — and are fatal under `failOnError`, following the same rule as every other codegen warning. The
  winner is chosen by file path so that regeneration stays byte-identical.
- **The union is maintained, not derived.** `--watch` keeps one registry for the whole session
  across every transform: an alias survives while any watched file still needs it, disappears when
  the last one stops, and is released when a query file is deleted. The watcher had **no `unlink`
  handler at all** before this; it now has one, which also removes the declaration file generated
  from the deleted query — that file imports aliases that are about to be released, so it could no
  longer stand on its own. Only a file whose header names the deleted query is removed.

`--file` is the one run that leaves the shared file alone: it describes a single file and so cannot
know what the rest of the project still shares. It says so rather than truncating the union.

A project with no shared aliases at all writes no file; one left over from a run that did have them
is removed, but only if its header marks it as generated.

Regeneration was run twice to confirm the output is stable, and `check-git-diff.sh` is clean.

---

### No way to type the keys of a `VALUES :rows` pick — issues #498, #517, #630 — **FIXED**

**This entry's earlier description of #498 was wrong and is corrected here.** It said the failing
construct was `INSERT INTO t (a, b) VALUES :rows`. It is not: that form has always worked, because
the target table's columns give the placeholders their types directly. The reporter's query is an
`INSERT … SELECT … FROM (VALUES :issues) AS tmp(issue_id, badge_id)`, and the `VALUES` list is
inside a **sub-select**. That is the whole defect, and it is the same construct in all three reports.

Postgres must assign a sub-select's columns concrete types before it typechecks anything downstream,
and a `VALUES` list resolves its columns from its own rows and nothing else. With every row an
`unknown` parameter, the `unknown` → `text` fallback fires and locks in. Measured directly against
a live server, by `PREPARE` and `pg_prepared_statements.parameter_types`:

| Construct                                                        | Inferred parameter types                |
| ---------------------------------------------------------------- | --------------------------------------- |
| `INSERT INTO issue (id, badge_id) VALUES ($1, $2)`               | `{text,integer}` — correct              |
| the same, multi-row `($1,$2),($3,$4)`                            | `{text,integer,text,integer}` — correct |
| `SELECT * FROM (VALUES ($1,$2)) AS tmp(a, b)`                    | `{text,text}` — **wrong**               |
| `SELECT * FROM (VALUES ($1::int,$2::text),($3,$4)) AS tmp(a, b)` | `{integer,text,integer,text}` — correct |

The last row is the fix and also its economy: **a cast in the first row propagates down the column**,
so one row of casts types the whole list however many rows are passed. Confirmed by `PREPARE` and by
`EXECUTE` against real rows.

Reproductions as reported, before the fix:

- **#498**, against the reporter's schema (`issue.id TEXT`, `issue.badge_id INT`):
  `Error in query. Details: { errorCode: '42804', message: 'column "badge_id" is of type integer but
expression is of type text' }`, and the query emitted with `Params = never`.
- **#630**: `UPDATE foo f SET val = item.val FROM (VALUES :foos) AS item(id, val) WHERE f.id =
item.id` → `42883 operator does not exist: integer = text`.
- **#517** asks for the annotation syntax that would fix both.

#### What now happens

A pick key may carry a cast, in either front-end:

```sql
/*
  @name UpdateFoos
  @param foos -> ((id!::int4, val!::text)...)
*/
UPDATE foo f SET val = item.val
FROM (VALUES :foos) AS item(id, val)
WHERE f.id = item.id;
```

```ts
const updateFoos = sql<UpdateFoosQuery>`UPDATE foo f SET val = item.val FROM (VALUES $$foos(id!::int4, val!::text)) AS item(id, val) WHERE f.id = item.id`;
```

which renders `(VALUES ($1::int4,$2::text),($3,$4))` and generates
`foos: readonly { id: number; val: string }[]` — `number`, where it was `string`. Both spellings are
pinned live in `packages/example`, which runs the #630 query against the server and asserts both the
generated type and the returned value.

Three things are worth recording about the shape of the fix.

- **Codegen needed no change at all.** The cast goes into the SQL, the server reports the resulting
  OID in its `ParameterDescription`, and the existing pick branch in `generator.ts` maps that OID
  like any other. Nothing in PgTyped infers, maps or validates the type name, which is why the type
  written is a Postgres type name rather than a TypeScript one.
- **The type grammar is deliberately narrow**: an identifier, optionally schema-qualified, with any
  number of `[]` suffixes. The text reaches the SQL verbatim, so a grammar admitting arbitrary text
  would admit arbitrary SQL. Multi-word spellings and length modifiers are rejected by name, and
  cost nothing — every multi-word type has a single-word alias, and a modifier cannot change the OID
  Describe reports.
- **The required marker comes first**, `id!::int4`. That keeps it on the name it qualifies, which is
  already how a scalar reference reads: `:id!::int4` has parsed all along. `id::int4!` is rejected
  with a message naming the key and the correct spelling.

This entry is also why `fix!: hash the rendered SQL into the prepared statement name` had to land
first. A `pick_tuple` renders a fixed number of placeholders, so it **is** named — and a key type
changes only the rendered SQL, never `ir.statement`. Under the old hash, two picks over identical
statement text with different key types would have taken the same statement name for two different
statement texts, which node-postgres rejects with "Prepared statements must be unique". There is a
test for exactly that pair.

#### Not fixed: a cast outside the `VALUES` row

Casting the sub-select's column instead of the key — `WHERE f.id = item.id::int4`, or
`SET val = item.val::text` — **describes successfully and silently generates the wrong type**. The
column is already `text` by the time the cast applies, so the parameter stays `text` and `id` comes
out `string`; PgTyped's report is a true description of the statement that was sent. Nothing here
detects it, and it remains the trap it was. The cast has to be on the key, inside the row. The
documentation says so under a caution.

Two query shapes that solve the same problem without the new syntax were verified end to end through
the CLI and are documented alongside it: `unnest(:ids!::int4[], :vals!::text[]) AS u(id, val)`,
which is correctly typed and cheaper for a large batch but changes the call shape to parallel
arrays; and a literal seed row, `FROM (VALUES (0, ''), :foos OFFSET 1) AS item(id, val)`, which
keeps the array-of-objects shape but is ugly and leans on `OFFSET` without an `ORDER BY`, which
Postgres does not contractually order.

### A non-required parameter was always an optional member — PR #582, issue #556 — **FIXED (adopted)**

An adoption rather than a bug: upstream's own reporter offered the patch, and the idea survives the
rewrite even though none of the code does. A parameter not marked `!` was emitted as an _optional_
interface member, so forgetting to pass one compiled and the query ran with it bound to NULL:

```ts
export interface Get582Params {
  id: string;
  note?: string | null | void;
}
```

The only way to get the strict reading was to mark every parameter `!`, which also drops `| null`
from the emitted type — there was no way to say "must be supplied" without also saying "may not be
null".

**Adopted as `optionalNullParams`, a config boolean defaulting to `true`.** The default is today's
behaviour exactly, so nothing regenerates; `packages/example` was confirmed byte-identical. With
`optionalNullParams: false` the same parameter becomes `note: string | null`.

**The `| void` goes with the `?`, deliberately.** `void` is in that union for one reason: to let the
caller leave the key out, which under `exactOptionalPropertyTypes` the `?` alone does not permit.
Once the key must be present, keeping `| void` would re-admit `undefined` by value — the very
omission the flag exists to catch — while `null` already says "bind NULL" in as many words, and the
runtime treats the two identically. So nothing is lost: `false` emits `| null`, not `| null | void`.

**It governs pick keys as well as scalars, and had to.** [#573](#pick-expansion-keys-were-never-optional--issue-573--fixed)
was fixed here in the opposite direction — a non-required _pick_ key now gets the `?` a non-required
scalar always had — and that agreement is the precondition for this flag, not a conflict with it. A
flag that made scalars mandatory while pick keys stayed optional would re-open exactly the gap #573
closed, so `(line1!, line2)` emits `line2?: string | null | void` or `line2: string | null` in step
with the scalar branch.

**An array parameter's element type is untouched.** A non-required spread stays
`readonly (string | null | void)[]` under either setting: that `| void` sits in the element type,
where there is no key for anyone to omit, and the flag is about keys.

**Regression cover.** `packages/cli/src/generator.test.ts` gains an `optionalNullParams` block that
asserts both settings against both branches in both `sql` and `ts` mode — eight tests, of which the
four `false` ones fail if the generator change is reverted and the four default ones do not, which is
their point. `packages/cli/src/config.test.ts` covers the default, the override and a non-boolean.
The hand-built config fixtures in `generator.test.ts` moved to a `testConfig` helper, because this is
the first flag whose schema default is not `false`, so `{} as ParsedConfig` stopped meaning "the
defaults".

---

## Known limitations — real, reproduced, and not cheaply fixable

These are all confirmed still-current. They are grouped because the answer to each is "this is what
the protocol gives us", not "nobody has got to it".

| Source                                       | Behaviour, reproduced                                                                                                                                                                                                                              | Why it stays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#551** outer joins not nullable            | `SELECT a.*, b."bStr" FROM "A" a LEFT JOIN public."B" b ON a.id = b."aId"` → `bStr: string`, expected `string \| null`                                                                                                                             | `getTypes` reads `attnotnull` on the _base column_, and `"B"."bStr"` genuinely is `NOT NULL`. The join that synthesises a NULL row is invisible at that level, and Describe gives no per-result-column nullability. Doing it right means a real analyser. **The supported answer is `@column bStr?`, which works** — verified: `@column c!` on a `coalesce` result flipped `string \| null` to `string`. Worth pointing at from the docs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Views/matviews all-nullable                  | `SELECT id, foo, bar FROM v_jt` → every column `\| null`                                                                                                                                                                                           | `pg_attribute.attnotnull` is false for view columns even when the underlying column is `NOT NULL`. Pre-existing; `docs-new/docs/sql-file.md` already names matviews as a `@column` case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **#583** params typed optional               | Params come out `avatar?: Json \| null \| void`; the **result** side correctly honours `NOT NULL`                                                                                                                                                  | `ParameterDescription` returns type OIDs and nothing else. The reporter's own workaround (`:name!`) is the answer and is documented under "Enforcing non-nullability for parameters".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **#455** nullable spread param               | `ages: readonly (number \| null \| void)[]`; `:ages!` gives `readonly (number)[]`                                                                                                                                                                  | Nullability lands on the elements; the array itself is always required, and `optional` is only ever set for `ParameterTransform.Scalar`. Needs a syntax decision (e.g. `@param ages -> (…)?`) plus parser and codegen work. Same design gap as variable-arity params generally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **#634** `JsonArray` elements nullable       | `array_agg(jsonb_build_object(…))` → `aggregated: JsonArray \| null`, `JsonArray = (Json)[]`                                                                                                                                                       | Elements are nullable because `Json` itself includes `null`. That is `getArray()` wrapping the `Json` alias, not a nullability-inference bug. Separating JSON `null` from SQL NULL means a second alias (`JsonValue`) and deciding which one `array_agg` results get — a design call. `@column agg!` removes the outer `\| null` (verified) but not the element nullability the issue is about.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **#263** JS array to a `json` param          | `SELECT :doc!::jsonb` with `doc: [1,2,3]` → `22P02 invalid input syntax for type json`; with `doc: {a:1}` it succeeds                                                                                                                              | node-postgres encodes arrays natively; pgTyped passes bindings through untouched. Fixing it needs the param's Postgres type at render time, which the runtime does not carry. Document it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **#348** static JSON aggregate typing        | `SELECT json_agg(json_build_object(…)) AS family` → `family: Json \| null`                                                                                                                                                                         | Unchanged; would need to interpret the aggregate's arguments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **#170**, **#446** dynamic column / order-by | `ORDER BY (CASE WHEN :asc = true THEN :sort_column END) ASC, :sort_column DESC` compiles to `… $2 …` with `values:[false,"id"]`; changing `sort_column` does not change the row order at all (verified against the correct raw `ORDER BY age ASC`) | `$n` is a value, not an identifier. **Cannot be fixed in code.** The docs promised otherwise; that has been corrected (see [Fixed in this fork](#fixed-in-this-fork)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **#549** `:name` inside a `DO $$ … $$` block | `export type CreateNamedSequenceIfNotExistsParams = void;`, `"params":[]`                                                                                                                                                                          | Deliberate in 3.0: the scanner treats `$$ … $$` as a dollar-quoted string, matching what Postgres would do, so the `void` is right and stays. Close as working-as-intended. The silence did not stay: a `:name` inside a dollar-quoted body — `$$ … $$` or `$tag$ … $tag$`, nested ones included — now **warns**, naming the query and the delimiter that hid it, and `failOnError` promotes it. It matches with the same pattern `scanParams` uses and descends through the body's own strings and comments, so `x := 1`, `val::int4`, `arr[1:2]` and a colon inside a string do not warn; a warning that fired on ordinary PL/pgSQL would be worse than the silence. No equivalent in `sql` tags: there the sigil is `$` and `$$ … $$` is not a quoted body at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **#561** permission reflection               | Not implemented                                                                                                                                                                                                                                    | `db/describe.ts` derives types from Parse/Describe, which carries no grant information, so the limitation the reporter deduced still holds for _typing_. Grants are no longer entirely invisible, though: the opt-in `checkPrivileges` added for PR #563 plans each query and reports what the role may not execute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **#513** DDL instead of a live database      | Not implemented; the CLI still requires a live connection                                                                                                                                                                                          | **No longer blocked, and the premise is measured.** Applying `packages/example/sql/schema.sql` to an in-process PGlite and generating the example's types produced all eight committed files **byte-for-byte identical** to the ones generated against `postgres:18-alpine` — enums, the domain and its `typesOverrides` mapping, arrays, `numeric`/`interval`/`point`, the `pg_description` comment, the `pg_attribute` nullability join and the whole-run shared-types union. Real 14.24, 15.19 and 18.6 servers produced the same bytes, so for this schema the output is version-insensitive — one schema measured, not a guarantee. Nothing in the pipeline needs a live server: all eight files were generated with no `pg.Pool` in the process, and `pg` is value-imported only at `index.ts:2`/`:35`. The blockers are both in `main`, which builds the pool unconditionally and calls `verifyConnection`; an optional `db?: TypeDb` skipping both is the whole change. Codegen timing is a wash (172–186 ms serialized against PGlite vs 167–180 ms through a 5-connection pool). **The risk is not type fidelity, it is reach:** a default PGlite has only `plpgsql`, and while 34 contrib extensions ship in the package they must be named in the _constructor_ — a `CREATE EXTENSION` line in the DDL fails `0A000` on its own, so the config would have to declare them. No PostGIS, pgvector or TimescaleDB at all. And "apply my DDL" is really "apply my migrations in order", a config surface nothing here has designed. |

## Unimplemented feature requests — reproduced as absent

| #                      | Ask                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #523                   | Support arbitrary env var names in config      | **Answered, and now documented.** `config.ts` reads only the fixed `PG*` names, but `parseConfig` loads the config with `require`, so a CommonJS config computes any field from any variable: `db: { host: process.env.MYAPP_DB_HOST }`. Verified end to end. No `{{VAR}}` templating, and none needed. See "Using other environment variables" in `docs-new/docs/cli.md`.                                                                                                        |
| #586                   | A setting to force result columns non-nullable | Not implemented, and not the same ask as #556: this one wants the _result_ types to drop `\| null`, which would be asserting something the catalog does not say. The parameter half of the pair is done — see [#556 below](#a-non-required-parameter-was-always-an-optional-member--pr-582-issue-556--fixed-adopted).                                                                                                                                                             |
| #143                   | Emit type info at runtime                      | **Partial.** 3.0 emits the whole `QueryIR` into generated files (`queryName`, `statement`, `params` with transforms and locs, `columns`, prepared `name`) — verified in generated output. Column _types_ are still not emitted, which is what the issue actually asks for.                                                                                                                                                                                                        |
| #404                   | `@comment` annotation                          | Not supported. `bcc4b07` downgraded unrecognised annotations from fatal to a warning, so a file with `@comment` now generates. Adding the annotation itself is unimplemented.                                                                                                                                                                                                                                                                                                     |
| #459                   | SQL-formatter-friendly variable syntax         | No syntax change in 3.0. One thing did move that the issue should know: the quoted-identifier workaround it floats (`":id!"`) _was_ being parsed as a param by 2.4.2 and is now correctly ignored, so that avenue is definitively closed. Worth a comment on the issue.                                                                                                                                                                                                           |
| #557                   | Conditional fragments `[[ … ]]`                | Not implemented. Note the "trailing comment trick" the issue relies on cannot work now that comment contents are opaque to the scanner.                                                                                                                                                                                                                                                                                                                                           |
| #395                   | Mappings within parameter expansions           | Unsupported; the syntax is passed to Postgres verbatim → `42601 syntax error at or near "("`. New expansion grammar plus IR and renderer support.                                                                                                                                                                                                                                                                                                                                 |
| #629                   | Composite types                                | Not implemented; `ARRAY(SELECT ROW(…))` has no structural typing.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #202                   | Type-safe dynamic filters at runtime           | Not implemented; out of scope for the rewrite.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #560                   | Globally replace strings                       | Unimplemented; no `@global` or equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #576                   | postgres.js support                            | The issue's actual ask — codegen emitting postgres.js template literals — is unimplemented. But it is **much closer**: `DatabaseConnection` is a single method over a plain `{name?, text, values}`, and `compile()` hands you that object, so a postgres.js adapter is a five-line wrapper around `sql.unsafe(text, values)`. Worth a FAQ entry showing the adapter.                                                                                                             |
| #512                   | Target a schema / `search_path`                | Still no config option, but there is now a **working workaround, and it is new in 3.0**: because codegen goes through node-postgres, `PGOPTIONS` reaches the server. Verified: `SELECT * FROM widgets` against a table in schema `tenant1` fails with `relation "widgets" does not exist`; with `PGOPTIONS='-c search_path=tenant1'` it succeeds and emits `label: string`. The hand-rolled wire client did not send `options`. This is now documented in `docs-new/docs/cli.md`. |
| #565, #567, #573, #556 | (covered above)                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

# Worth adopting from upstream

Ordered by value per unit of effort. The three cheapest — PRs #580, #624 and #642 — have been taken,
as have PR #563, the pre-flight privilege check, and PR #582, the `optionalNullParams` flag; all five
are recorded in [Fixed on this branch](#fixed-on-this-branch). PR #524 turned out to need no code at
all — see [Not applicable](#not-applicable). The one that is left, PR #620, is no longer blocked on
anything unknown: its PGlite premise was the open question and has been confirmed by running it. What
remains is a decision about when to commit to a public interface, not a technical risk.

### PR #620 — a programmatic API, minus the package split

**Effort: the packaging fix is small; the stable public API is a design task.**

**What it buys:** generating types from a script without shelling out to the CLI. The motivating case
is PGlite — spin up an in-process Postgres, apply migrations, generate types, all in one Node process
with no TCP listener.

**Do not adopt the shape.** It re-splits `@pgtyped/cli` into `cli` + `typegen`, directly against this
fork's deliberate 6-packages-to-3 consolidation.

**Take instead:** fix the `exports` map (see
[the packaging bug](#the-cli-packages-exports-map-hijacked-the-importing-process--found-while-evaluating-pr-620--fixed)),
move the argv/`process.exit` code out of `index.ts` into a `cli.ts` bin, and export a small
`generateTypes(file, config, db)` surface. **The first two are done** — `index.ts` is a library that
exports `main`, `cli.ts` is the bin, and the package has a real `"."` entry. The third, a public
surface worth committing to, is what is left.

**The PGlite premise was unverified and is now confirmed, by running it.** `@electric-sql/pglite`
0.5.8 (reporting server 18.3) can back `TypeDb` in full, so no part of the extended-query path has to
be reimplemented. An adapter of about sixty lines wired into the built CLI generated correct output — enum alias,
array alias, `pg_attribute` nullability, a column comment from `pg_description` — with no TCP
listener and no pool, in both `sql` and `ts` modes, string in and string out.

What the next person needs and would otherwise re-derive:

- **`db.describeQuery()` is unusable.** It returns only `{dataTypeID, parser}` per column — no
  `tableID`/`columnID`, so the `pg_attribute` nullability join has nothing to join on. Use
  `execProtocol` with `protocol.serialize`, which PGlite exports: `parse` + `describe` + `sync`
  concatenated returns a full `parameterDescription` and `rowDescription` including `tableID`,
  `columnID`, `dataTypeSize` and `dataTypeModifier`. No private API is touched.
- **`execProtocol` is not covered by PGlite's query lock, and the failure is silent.** Nine
  concurrent `describe` calls produced 360/360 wrong results: one caller receives every backend
  message and the rest receive nothing, yielding an empty `Described` and therefore `never` types,
  with no error. Wrapping each call in `db.runExclusive` gives 0/360. `MAX_CONCURRENCY` in `util.ts`
  buys nothing here — correctness is fine, throughput is serial.
- **`explain` must use `exec()`, not `query()`.** `query()` always binds, so
  `EXPLAIN (GENERIC_PLAN) … WHERE id = $1` fails with `08P01 bind message supplies 0 parameters`.
  Only matters with `checkPrivileges` on.
- `rowDescription.format` is numeric `0`/`1` rather than pg's `'text'`/`'binary'`.
- PGlite parses `oid`, `int4` and `atttypid` to `number` and `attnotnull` to `boolean`, as pg does.
  `db/types.ts` depends on it: `nullable: !attnotnull` would make every column nullable against a
  `'t'` string.
- PGlite's errors carry pg-shaped `code`, `hint` and `position`, which is what `toParseError` and
  `toPrivilegeError` read — `42501`, `42702` and `0A000` were all observed.
- `checkPrivileges` is exercisable: roles, `GRANT USAGE` and column-level grants all work. PGlite
  cannot _connect as_ a role — no listener, no auth — so `SET ROLE` stands in, with the same
  privilege semantics.
- **OIDs match a real server** byte for byte for the same schema and query (PGlite 18.3 against
  Postgres 18.6), differing only in `tableOID`, which is a relfilenode and per-database by nature. A
  user enum and a `CREATE DOMAIN` got identical OIDs on both, and both report the domain's _base_
  type in `RowDescription` — Postgres behaviour, not a PGlite deviation. The existing `typeMap`
  needs no change.

**Ready when wanted, and deliberately not done yet.** The remaining work is small — an optional
`db?: TypeDb` parameter on `main` (skipping `verifyConnection`, which is right anyway when there is
no pool to verify), a thin `generateTypes` over the existing `generateTypedecsFromFile` +
`generateDeclarationFile` seam, and a `configFrom` that runs the same zod parse `parseConfig` does
without the `require`. `main` has exactly one `process.exit`, on that one pre-flight.

What argues for waiting is not the cost but the commitment: the public surface would be `TypeDb`,
and `TypeDb` went from two methods to three when `explain` arrived with the privilege check. Freezing
it now makes every future method a breaking change for anyone implementing it, and nobody in this
fork has asked for in-process codegen. If it is built, make new methods optional from the start, keep
the PGlite adapter in the docs rather than taking a 3.7 MB WASM dependency, and note that
a per-file
`generateTypes` cannot honour `sharedTypesFile` — shared types are a whole-run concept keyed by
declaration file path, so per-file text generation cannot participate. Driving the transformer and
`SharedTypeRegistry` directly, which is `main`'s body minus the pool, _does_ honour it: the PGlite
run recorded against #513 emitted a byte-identical `pgtyped-shared.ts`.

Worth fixing first, if it is built: `srcDir` and the config path both resolve against
`process.cwd()` (#572), which is a wart a shell caller absorbs and a build script does not.

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
| #548 | Cannot run the example application                   | `cd packages/example && docker compose run --rm build` → all 12 files processed; `docker compose run --rm test` → 26 passed. **Residual, now also fixed:** the _instructions_ the reporter actually complained about were still stale — see [Docs and repo residue](#docs-and-repo-residue--issues-491-548-572--fixed).                                                                                                                                                                             |
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

| #                          | Title                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #375                       | Type inference issues in the Postgres engine         | A meta/tracker issue listing eight sub-issues. Nothing to verify; it is a label, not a report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #566                       | What approach can you recommend for data grouping?   | A usage question about shaping joined rows in application code. No pgTyped code path is implicated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| #504                       | Multiple databases support                           | The feature does not exist, and 3.0 made asking for it a hard error rather than a silent no-op: the reporter's proposed config now fails fast with `db: Expected object, received array`. There is also no `exclude` key. Nothing regressed — the request is simply unimplemented, and now un-expressible rather than quietly ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #564                       | `typesOverrides` converts relative paths undesirably | Behaviour is correct and documented; the report is a misunderstanding. `docs-new/docs/typing.md` states "All relative paths must be relative to the root of your project." Verified end to end: config `"./common.js#LobbyStatus"`, real file at `<root>/common.ts`, generated `src/nested/f.queries.ts` emits `import type { LobbyStatus } from '../../common.js';` — correct. The reporter's file was under `src/`, so `"./src/common.js"` was the right config value and their `@src/*` tsconfig workaround was unnecessary. At most, cross-link the root-relative rule from the `typesOverrides` examples.                                                                                                                                                                                                                                                                                                                                                                                                        |
| #50                        | MySQL support                                        | PgTyped is built on the Postgres extended-query protocol (`Parse`/`Describe`); 3.0 doubled down by adopting node-postgres. No shared code path exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PR #524                    | Env-var templating in config                         | **Not needed — the capability already exists.** The ask, choosing which variable supplies each connection field, works today: `parseConfig` loads the config with `require`, so a `.cjs` config reads `process.env` directly. Verified end to end, including that a `PG*` variable still displaces a JavaScript-set field and warns. A JavaScript config also gives defaults, string composition, a `Number()` for the port and a branch per environment, none of which `{{VAR}}` in JSON could express, so the templating syntax would be a weaker language and a permanent support burden. Documented under "Using other environment variables" in `docs-new/docs/cli.md`; the patch's own defects are in the row below. Checking this also turned up two config shapes that loaded but reported `transforms: Required` — an ESM `export default`, and `module.exports` in a file Node reads as ESM — so the default export is now unwrapped and the unrescuable case names the module format instead. Closes #523. |
| #316                       | Dependency Dashboard                                 | An upstream Renovate bot issue about `adelsz/pgtyped`'s own dependencies. This fork has its own `renovate.json`. Not a bug report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #578                       | Website localization                                 | Docs-infrastructure request against the upstream site. A fork decision, not a 3.0 question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PR #615                    | jest monorepo → v30                                  | The fork has no jest; every package tests with vitest (catalog `^5.0.0`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PR #619                    | Update all non-major dependencies                    | Touches `packages/wire/package.json` and `docs-new/package-lock.json`, neither of which exists here. The fork's remaining targets are already at or above the proposed floors via the pnpm catalog. An npm-lockfile PR against a pnpm workspace regardless.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PR #555                    | A fourth `@param x -> ARRAY[…]` expansion            | Written against the **ANTLR grammar** in `packages/parser`, which no longer exists. Beyond that the use case is already served: `SELECT * FROM UNNEST(:vals!::text[])` with `{ vals: ['x','y'] }` returns two rows — node-postgres binds a JS array to a single `text[]` placeholder. That keeps the SQL text fixed, so the query still gets a canonical prepared-statement name; a variable-arity `ARRAY[$1,$2,$3]` transform would forfeit it, against this fork's prepared-statement direction. **Unverified:** no attempt was made to construct a query where an array _literal_ is genuinely required and a bound `text[]` will not do.                                                                                                                                                                                                                                                                                                                                                                          |
| PR #622, #623              | lerna → 8.2.4 / v10                                  | `package-lock.json` only. The fork uses pnpm workspaces + release-please; there is no lerna anywhere in the tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PR #639                    | Fix `AsyncQueue.replyPending`                        | Fixes `packages/wire`, the hand-rolled wire-protocol client, which was deleted. Both codegen and the runtime go through node-postgres now, so the message-dropping race cannot occur. The bug it describes is genuine and its regression test is well written — it just has no code left to protect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PR #584 (formatting hunks) | —                                                    | The substantive change was taken; the PR also reverts prettier's formatting on four unrelated blocks and adds two stray blank lines, and `pnpm lint` gates on `prettier --check .`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PR #580 (mechanism)        | —                                                    | The goal was right and is [taken](#query-name-not-reachable-at-runtime--issue-522-pr-580--fixed); the mechanism — a second positional constructor argument rewriting every generated file — was wrong here, because the fork already serialises `queryName` inside the IR, so the property is read off it instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PR #637 (as written)       | —                                                    | The technique was right and is [taken](#domain-types-were-flattened-to-their-base-type--issues-503-594-pr-637--fixed); the patch was not merged verbatim, because unamended it converts working `string`/`number`/enum columns into `unknown` plus a hard codegen error for any project with domain columns and no per-domain `typesOverrides` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PR #620 (as written)       | —                                                    | Re-splits the CLI into a second `@pgtyped/typegen` package, against the deliberate 6→3 consolidation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PR #614 (as written)       | —                                                    | The idea was right and is [taken](#array-elements-were-typed-as-non-nullable--issues-613-460-pr-614--fixed); the patch was not, because it applies `(null \| T)[]` in both scopes — widening what a parameter accepts, which neither issue asks for — and renames every generated alias `TArray` → `NullTArray`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PR #524 (as written)       | —                                                    | `parseEnvTemplate` slices the whole input rather than the match, so only an exact `{{VAR}}` value works; non-template literals are discarded; and it loosens `db.port` to `number \| string`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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
  The failure mode was the same string comparison, but nothing ran on Windows. The fix resolves both
  sides with `path.resolve`, which is separator-aware on Windows and not on POSIX — so the reporter's
  `multi\a\one.sql` is expected to work there and is still expected to fail here, where a backslash
  is a legal character in a file name. That expectation, too, has not been run on Windows.
- **PgBouncer transaction-pooling mode**, which `unprepared()` exists for, was not exercised.
- **#561 (permissions)** and **#513 (DDL source)**: verified only that the feature does not exist and
  that the code path the reporters describe is unchanged. No attempt was made to build either to
  confirm feasibility.
- **PR #563**: no longer unverified. Every question the entry left open was prototyped against live
  PostgreSQL 18.6 and 15.19 containers before the feature was built — including the column-level
  grants and the DML safety this originally disclaimed. What remains untested in CI is the pre-16
  `NULL`-binding path: its behaviour was confirmed by hand against a 15.19 container, but the example
  suite runs on PostgreSQL 18, so only unit tests cover which of the two paths is chosen.
- **PR #620**: nothing outstanding. The packaging defect was reproduced and fixed, and the PGlite
  claim — the one thing this list used to carry for it — was confirmed by generating real types
  through PGlite with no TCP listener. What is left is a decision, not an unknown.
- **PR #524**: the implementation was read and the env-precedence footgun reproduced; upstream's own
  test file was not run.
- **PR #624**: pg18 verified for codegen and the example suite only — twice, before and after the
  image bump was taken, but never outside those two paths.
- **Renovate PRs** were assessed against manifests, not by installing.
- **Array-type parsers**: only six array OIDs were probed (`_text`, `_int4`, `_int8`, `_numeric`,
  `_timestamptz`, `_point`).

---

# Index

Every triaged number, and where it is covered.

**Issues (70).**
#50 NA · #143 feature · #151 fixed · #159 fixed · #170 limitation/docs fixed · #202 feature ·
#213 **FIXED here** · #221 **FIXED here** (diagnosis) · #263 limitation · #273 **FIXED here** (diagnosis) · #292 fixed · #314 **FIXED here** (diagnosis) · #316 NA ·
#317 **FIXED here** · #348 limitation · #375 NA · #394 fixed · #395 feature · #404 fixed (warn) ·
#410 fixed upstream · #446 limitation/docs fixed · #454 fixed · #455 limitation · #459 feature ·
#460 **FIXED here** · #491 **FIXED here** (docs) · #498 **FIXED here** · #503 **FIXED here** · #504 NA · #512 feature/workaround ·
#513 limitation · #517 **FIXED here** · #522 **FIXED here** · #523 **answered** (JS config) · #526 **FIXED here** ·
#534 **FIXED here** · #548 fixed (residual docs **FIXED here**) · #549 limitation (now warns) · #551 limitation · #552 open ·
#556 **FIXED here** · #557 feature · #560 feature · #561 limitation · #564 NA · #565 **FIXED here** ·
#566 NA · #567 **FIXED here** · #572 **FIXED here** (docs + warning) · #573 **FIXED here** · #574 fixed · #576 feature ·
#578 NA · #579 **FIXED here** · #583 limitation · #584 → PR · #585 fixed · #586 feature ·
#594 **FIXED here** · #599 fixed · #604 fixed · #609 **FIXED here** · #610 unverified · #611 fixed (bcc4b07) ·
#613 **FIXED here** · #625 fixed · #629 feature · #630 **FIXED here** · #634 limitation · #636 fixed · #640 fixed

**Pull requests (27).**
#524 adopt (rewrite) · #545 already fixed · #553 open bug · #555 NA · #563 **FIXED here** ·
#580 **FIXED here** · #582 **FIXED here** · #584 **FIXED here** · #612 **FIXED here** ·
#614 **FIXED here** (rescoped) · #615 NA · #616 **FIXED here** · #619 NA · #620 packaging **FIXED here**, split NA, API ready when wanted ·
#622 NA · #623 NA · #624 **FIXED here** · #627 already fixed · #628 already fixed ·
#632 already fixed · #633 already fixed · #635 already fixed · #637 **FIXED here** (amended) ·
#639 NA · #641 already fixed · #642 **FIXED here** · #643 already fixed
