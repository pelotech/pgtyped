# Changelog

## [3.0.0](https://github.com/pelotech/pgtyped/compare/v2.4.3...v3.0.0) (2026-09-10)

### Highlights

pgTyped's parser, query representation, runtime API, Postgres client and codegen
were all rewritten. Two ANTLR grammars and 3,820 lines of generated parser code
became a 150-line scanner; a 2,561-line hand-rolled wire-protocol client became
a node-postgres `Submittable`; six packages became three. **`@pelotech/pgtyped-runtime`
now has no dependencies at all** — installing it no longer pulls in
`antlr4ts@0.5.0-alpha.4`, an alpha release of an abandoned parser generator.

Every open issue and pull request on the upstream project was triaged against
this release, each one reproduced rather than assumed; `docs/upstream-triage.md`
records the result. Long-standing bugs it confirmed fixed:

- A `:param` inside a comment or a quoted identifier is no longer treated as a
  parameter. 2.x rewrote placeholders _inside_ comments.
- A string containing a backslash no longer breaks parsing.
- Nested block comments no longer send an unbalanced `*/` to the server.
- SCRAM authentication works against PostgreSQL 16.
- Enum values containing an apostrophe no longer generate invalid TypeScript.
- Six default type mappings now describe what the driver actually returns —
  `interval`, `time`, `timetz`, `bit`, `point` and `numeric[]` were all wrong.
- A failed database connection no longer overwrites generated types with `never`
  and exits 0.
- `PGOPTIONS='-c search_path=…'` reaches the server.

Queries carry a server-side prepared statement name so Postgres reuses its parse
and plan, and `sql` tags can opt in with `sql.prepared()`.

**Upgrading:** start from the "Upgrading from 2.x" section of
[the runtime README](https://github.com/pelotech/pgtyped/blob/HEAD/packages/runtime/README.md).
The changes most likely to alter runtime behaviour are the connection-first
argument order, nullability hints moving from column aliases to `@column`
annotations, and the corrected type mappings — affected projects must
regenerate.

### ⚠ BREAKING CHANGES

- the bin moved from `lib/index.js` to `lib/cli.js`. Anything invoking it by path — a Dockerfile, a CI step, a `node_modules/...` invocation — must be updated; `npx pgtyped` and the `pgtyped` bin name are unaffected.
- replace lerna with pnpm workspaces ([#18](https://github.com/pelotech/pgtyped/issues/18))
- **cli:** the ts-implicit transform mode and the maxWorkerThreads option are removed. preparedStatements now defaults to true and hungarianNotation to false. The typescript peer dependency is optional and capped below 7.
- **runtime:** IDatabaseConnection is now DatabaseConnection and query() takes a single QueryConfig. PreparedQuery is renamed TypedQuery; the transitional alias was removed before release. runWithCounts is replaced by execute(). stream() and ICursor are removed. TaggedQuery is gone: the sql tag returns a TypedQuery. Nullability hints in column aliases (AS "total!") are no longer stripped from rows; use @column annotations instead. Mid-statement block comments are kept in the statement text rather than blanked, so editing one changes the query's prepared statement name. Preprocessor internals move to the @pelotech/pgtyped-runtime/internal subpath. In sql tags, a $param referenced twice with different inline selections is now an error; the old preprocessor silently merged the key sets. The runtime no longer depends on @pelotech/pgtyped-parser, so consumers stop bundling antlr4ts and chalk.
- packages require Node >=24 and are ESM-only. The CommonJS entry point of @pelotech/pgtyped-runtime has been removed.

### Features

- **cli:** 3.0 codegen on the unified IR ([#16](https://github.com/pelotech/pgtyped/issues/16)) ([3cb2df6](https://github.com/pelotech/pgtyped/commit/3cb2df69749985bcc0c759ccb21d30729baeb426))
- opt tagged queries into parse-plan caching with sql.prepared ([#20](https://github.com/pelotech/pgtyped/issues/20)) ([2c0bb0a](https://github.com/pelotech/pgtyped/commit/2c0bb0adbce287f29a8ecaee3aa6766d32e7a0e1))
- **runtime:** hand-written scanner and a unified query IR ([#12](https://github.com/pelotech/pgtyped/issues/12)) ([b23bdf9](https://github.com/pelotech/pgtyped/commit/b23bdf994a3093b55b82b668cda029cc51f87978))
- **runtime:** publish the 3.0 API and migrate consumers ([#14](https://github.com/pelotech/pgtyped/issues/14)) ([06b6759](https://github.com/pelotech/pgtyped/commit/06b6759f50fa750da35d38ce2bf5347ae7d57818))
- send queries as server-side prepared statements ([c963f40](https://github.com/pelotech/pgtyped/commit/c963f40182d69325a9c4e41a9da47cdc19c4f3f5))

### Bug Fixes

- correct defects found triaging upstream issues against 3.0 ([#21](https://github.com/pelotech/pgtyped/issues/21)) ([bcc4b07](https://github.com/pelotech/pgtyped/commit/bcc4b074f9e8f8a688d39901348a6e029e16dd13))
- **deps:** update all non-major dependencies ([22ccf87](https://github.com/pelotech/pgtyped/commit/22ccf873e1fabcab715694a27b7f2c1753868d23))

### Refactoring

- rename packages to @pelotech/pgtyped-* ([3b3bd64](https://github.com/pelotech/pgtyped/commit/3b3bd64427e9036385e9c26e59cf639b254283b2))
- **runtime:** one renderer and one query class ([#13](https://github.com/pelotech/pgtyped/issues/13)) ([02c3b22](https://github.com/pelotech/pgtyped/commit/02c3b22a703eca5da69fa33e111eaf582b40ce52))

### Build

- replace lerna with pnpm workspaces ([#18](https://github.com/pelotech/pgtyped/issues/18)) ([72a55a2](https://github.com/pelotech/pgtyped/commit/72a55a28980e9f522fb0c67017e3d762ae54f7ab))

### Chores

- require Node 24 and drop the CommonJS build ([80843ec](https://github.com/pelotech/pgtyped/commit/80843ecb747892b87f6356ea35ef9ad90c79252b))

### Documentation

- record the upstream triage, and fix three defects it found ([#22](https://github.com/pelotech/pgtyped/issues/22)) ([d8d2c36](https://github.com/pelotech/pgtyped/commit/d8d2c36ebe35a68a70e307e2b7b597e215e062a6))
