# Changelog

## [3.0.0](https://github.com/pelotech/pgtyped/compare/v2.4.3...v3.0.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* every named query's hash suffix changes, because the hash is now taken over the rendered SQL rather than the statement text. A query with no parameters renders as its own text and keeps its name; every other named query is renamed. Regenerate with the new CLI before deploying — generated files carry the name, and a mismatch surfaces as "Prepared statements must be unique" on a connection that already prepared the old text.
* the bin moved from `lib/index.js` to `lib/cli.js`. Anything invoking it by path — a Dockerfile, a CI step, a `node_modules/...` invocation — must be updated; `npx pgtyped` and the `pgtyped` bin name are unaffected.
* replace lerna with pnpm workspaces ([#18](https://github.com/pelotech/pgtyped/issues/18))
* **cli:** the ts-implicit transform mode and the maxWorkerThreads option are removed. preparedStatements now defaults to true and hungarianNotation to false. The typescript peer dependency is optional and capped below 7.
* **runtime:** IDatabaseConnection is now DatabaseConnection and query() takes a single QueryConfig. PreparedQuery is renamed TypedQuery (a deprecated alias remains until codegen catches up). runWithCounts is replaced by execute(). stream() and ICursor are removed. TaggedQuery is gone: the sql tag returns a TypedQuery. Nullability hints in column aliases (AS "total!") are no longer stripped from rows; use @column annotations instead. Mid-statement block comments are kept in the statement text rather than blanked, so editing one changes the query's prepared statement name. Preprocessor internals move to the @pelotech/pgtyped-runtime/internal subpath. In sql tags, a $param referenced twice with different inline selections is now an error; the old preprocessor silently merged the key sets. The runtime no longer depends on @pelotech/pgtyped-parser, so consumers stop bundling antlr4ts and chalk.
* packages require Node >=24 and are ESM-only. The CommonJS entry point of @pelotech/pgtyped-runtime has been removed.
* IDatabaseConnection.query now accepts string | QueryConfig. pg's Client and Pool already satisfy it; a hand-written two-argument adapter needs widening.

### Features

* add support for streaming ([#569](https://github.com/pelotech/pgtyped/issues/569)) ([f2e6faa](https://github.com/pelotech/pgtyped/commit/f2e6faaeda7911155c0c0431b67b12082988f222))
* **cli:** 3.0 codegen on the unified IR ([#16](https://github.com/pelotech/pgtyped/issues/16)) ([3cb2df6](https://github.com/pelotech/pgtyped/commit/3cb2df69749985bcc0c759ccb21d30729baeb426))
* let a pick transform declare the type of each key ([#34](https://github.com/pelotech/pgtyped/issues/34)) ([e0f37cf](https://github.com/pelotech/pgtyped/commit/e0f37cf4bb8c877b3f16d6b11f98bfd9c07c908c))
* opt tagged queries into parse-plan caching with sql.prepared ([#20](https://github.com/pelotech/pgtyped/issues/20)) ([2c0bb0a](https://github.com/pelotech/pgtyped/commit/2c0bb0adbce287f29a8ecaee3aa6766d32e7a0e1))
* run method that returns affected row count ([#598](https://github.com/pelotech/pgtyped/issues/598)) ([7931e62](https://github.com/pelotech/pgtyped/commit/7931e62bd482c38f728e48f4d5f644ce5ab558bc))
* **runtime:** hand-written scanner and a unified query IR ([#12](https://github.com/pelotech/pgtyped/issues/12)) ([b23bdf9](https://github.com/pelotech/pgtyped/commit/b23bdf994a3093b55b82b668cda029cc51f87978))
* **runtime:** publish the 3.0 API and migrate consumers ([#14](https://github.com/pelotech/pgtyped/issues/14)) ([06b6759](https://github.com/pelotech/pgtyped/commit/06b6759f50fa750da35d38ce2bf5347ae7d57818))
* send queries as server-side prepared statements ([c963f40](https://github.com/pelotech/pgtyped/commit/c963f40182d69325a9c4e41a9da47cdc19c4f3f5))


### Bug Fixes

* correct defects found triaging upstream issues against 3.0 ([#21](https://github.com/pelotech/pgtyped/issues/21)) ([bcc4b07](https://github.com/pelotech/pgtyped/commit/bcc4b074f9e8f8a688d39901348a6e029e16dd13))
* **deps:** update all non-major dependencies ([22ccf87](https://github.com/pelotech/pgtyped/commit/22ccf873e1fabcab715694a27b7f2c1753868d23))
* hash the rendered SQL into the prepared statement name ([#33](https://github.com/pelotech/pgtyped/issues/33)) ([9274c7a](https://github.com/pelotech/pgtyped/commit/9274c7a8faf092120a60cb353d9e565b56f42ee4))
* make three silent failures loud ([#27](https://github.com/pelotech/pgtyped/issues/27)) ([f9a7ab5](https://github.com/pelotech/pgtyped/commit/f9a7ab5b448ce447c0cb112803f2cc412642eca9))
* type a sql tag from its cooked text, as the runtime sends it ([#38](https://github.com/pelotech/pgtyped/issues/38)) ([51189c8](https://github.com/pelotech/pgtyped/commit/51189c885b387dbbd98215b4cea6f948af420905))
* type domains correctly, and stop two config paths failing silently ([#25](https://github.com/pelotech/pgtyped/issues/25)) ([90f626d](https://github.com/pelotech/pgtyped/commit/90f626d41a801ead97bf18948f69ed4d11256f78))
* warn on a param sigil inside a dollar-quoted body ([#36](https://github.com/pelotech/pgtyped/issues/36)) ([9f63fd8](https://github.com/pelotech/pgtyped/commit/9f63fd829589423b9de83d7b0461189b905ba8a8))


### Refactoring

* rename packages to @pelotech/pgtyped-* ([3b3bd64](https://github.com/pelotech/pgtyped/commit/3b3bd64427e9036385e9c26e59cf639b254283b2))
* **runtime:** one renderer and one query class ([#13](https://github.com/pelotech/pgtyped/issues/13)) ([02c3b22](https://github.com/pelotech/pgtyped/commit/02c3b22a703eca5da69fa33e111eaf582b40ce52))


### Build

* replace lerna with pnpm workspaces ([#18](https://github.com/pelotech/pgtyped/issues/18)) ([72a55a2](https://github.com/pelotech/pgtyped/commit/72a55a28980e9f522fb0c67017e3d762ae54f7ab))


### Chores

* require Node 24 and drop the CommonJS build ([80843ec](https://github.com/pelotech/pgtyped/commit/80843ecb747892b87f6356ea35ef9ad90c79252b))


### Documentation

* record the upstream triage, and fix three defects it found ([#22](https://github.com/pelotech/pgtyped/issues/22)) ([d8d2c36](https://github.com/pelotech/pgtyped/commit/d8d2c36ebe35a68a70e307e2b7b597e215e062a6))

## Changelog
