# Changelog

## [3.0.0](https://github.com/pelotech/pgtyped/compare/v2.4.3...v3.0.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* type aliases shared between queries are no longer declared by the file generated for each query. Code that imported one from a generated file — `import type { PgInterval } from './driverTypes/driverTypes.queries.js'` — must import it from `<srcDir>/pgtyped-shared.ts` instead. Per-query types are unaffected. Set `sharedTypesFile: false` to restore the previous output.
* the bin moved from `lib/index.js` to `lib/cli.js`. Anything invoking it by path — a Dockerfile, a CI step, a `node_modules/...` invocation — must be updated; `npx pgtyped` and the `pgtyped` bin name are unaffected.
* replace lerna with pnpm workspaces ([#18](https://github.com/pelotech/pgtyped/issues/18))
* **cli:** the ts-implicit transform mode and the maxWorkerThreads option are removed. preparedStatements now defaults to true and hungarianNotation to false. The typescript peer dependency is optional and capped below 7.
* **cli:** @pelotech/pgtyped-wire and @pelotech/pgtyped-query no longer exist. Codegen connects through node-postgres, which is now a dependency of @pelotech/pgtyped-cli.
* **runtime:** IDatabaseConnection is now DatabaseConnection and query() takes a single QueryConfig. PreparedQuery is renamed TypedQuery (a deprecated alias remains until codegen catches up). runWithCounts is replaced by execute(). stream() and ICursor are removed. TaggedQuery is gone: the sql tag returns a TypedQuery. Nullability hints in column aliases (AS "total!") are no longer stripped from rows; use @column annotations instead. Mid-statement block comments are kept in the statement text rather than blanked, so editing one changes the query's prepared statement name. Preprocessor internals move to the @pelotech/pgtyped-runtime/internal subpath. In sql tags, a $param referenced twice with different inline selections is now an error; the old preprocessor silently merged the key sets. The runtime no longer depends on @pelotech/pgtyped-parser, so consumers stop bundling antlr4ts and chalk.
* packages require Node >=24 and are ESM-only. The CommonJS entry point of @pelotech/pgtyped-runtime has been removed.
* IDatabaseConnection.query now accepts string | QueryConfig. pg's Client and Pool already satisfy it; a hand-written two-argument adapter needs widening.
* Allow enforcing non-empty array parameters in config ([#603](https://github.com/pelotech/pgtyped/issues/603))
* generate errors for queries returning anonymous columns
* make nullable scalar parameters optional ([#482](https://github.com/pelotech/pgtyped/issues/482))

### Features

* \n line endings in generated IRs ([#442](https://github.com/pelotech/pgtyped/issues/442)) ([e20711b](https://github.com/pelotech/pgtyped/commit/e20711b7e6a7821e33bcb249ca314623790e5592))
* add `dir_base` template parameter for `emitTemplate` ([#515](https://github.com/pelotech/pgtyped/issues/515)) ([36cdf28](https://github.com/pelotech/pgtyped/commit/36cdf2837cde8c6620dd9289c1ef83a1cd415d2d))
* add optionalNullParams, to require a nullable parameter be named ([#35](https://github.com/pelotech/pgtyped/issues/35)) ([571fcba](https://github.com/pelotech/pgtyped/commit/571fcba452983adbfacb5cd22fda0126dc1ecb7c))
* add support for DATABASE_URL as an alternative to PGURI ([#484](https://github.com/pelotech/pgtyped/issues/484)) ([898110e](https://github.com/pelotech/pgtyped/commit/898110e1ba98c6efbc9ebe25518558bab78ebeeb)), closes [#381](https://github.com/pelotech/pgtyped/issues/381)
* add types overrides imports ([#488](https://github.com/pelotech/pgtyped/issues/488)) ([8440d6a](https://github.com/pelotech/pgtyped/commit/8440d6a012ab889ba729eb1943754e41b393638d))
* Allow enforcing non-empty array parameters in config ([#603](https://github.com/pelotech/pgtyped/issues/603)) ([c6de409](https://github.com/pelotech/pgtyped/commit/c6de409230be69fcde408daf7ab9b4d0a7f21ed9))
* check the connecting role may execute each query ([#29](https://github.com/pelotech/pgtyped/issues/29)) ([dbaa4bb](https://github.com/pelotech/pgtyped/commit/dbaa4bbd05a7c328c0726ea00aaae9912fb07508))
* **cli:** 3.0 codegen on the unified IR ([#16](https://github.com/pelotech/pgtyped/issues/16)) ([3cb2df6](https://github.com/pelotech/pgtyped/commit/3cb2df69749985bcc0c759ccb21d30729baeb426))
* **cli:** expose maxWorkerThreads configuration variable ([2410738](https://github.com/pelotech/pgtyped/commit/241073841454bd82621473bba805defd2465f8f3))
* declare shared type aliases once, in a shared types file ([#32](https://github.com/pelotech/pgtyped/issues/32)) ([633dc2a](https://github.com/pelotech/pgtyped/commit/633dc2a75e5e2f2f0af02f8673ad106c1a4a9cc1))
* generate errors for queries returning anonymous columns ([2b4ef61](https://github.com/pelotech/pgtyped/commit/2b4ef6145cf25821ff7984e7fc2c42a1133679c4))
* generate types from an injected TypeDb ([#41](https://github.com/pelotech/pgtyped/issues/41)) ([bd75076](https://github.com/pelotech/pgtyped/commit/bd7507635442eb9d87ab732bf4d9b04e9bdcefa9))
* let a pick transform declare the type of each key ([#34](https://github.com/pelotech/pgtyped/issues/34)) ([e0f37cf](https://github.com/pelotech/pgtyped/commit/e0f37cf4bb8c877b3f16d6b11f98bfd9c07c908c))
* make nullable scalar parameters optional ([#482](https://github.com/pelotech/pgtyped/issues/482)) ([db1f082](https://github.com/pelotech/pgtyped/commit/db1f08267a1347586a27ed979b47c1e307dd2475))
* opt tagged queries into parse-plan caching with sql.prepared ([#20](https://github.com/pelotech/pgtyped/issues/20)) ([2c0bb0a](https://github.com/pelotech/pgtyped/commit/2c0bb0adbce287f29a8ecaee3aa6766d32e7a0e1))
* Output nullability overriding with aliases ([#377](https://github.com/pelotech/pgtyped/issues/377)) ([dfb0b66](https://github.com/pelotech/pgtyped/commit/dfb0b66c000055227e83583f169ec99ed1508a2c))
* **runtime:** publish the 3.0 API and migrate consumers ([#14](https://github.com/pelotech/pgtyped/issues/14)) ([06b6759](https://github.com/pelotech/pgtyped/commit/06b6759f50fa750da35d38ce2bf5347ae7d57818))
* send queries as server-side prepared statements ([c963f40](https://github.com/pelotech/pgtyped/commit/c963f40182d69325a9c4e41a9da47cdc19c4f3f5))
* Typed sql overload functions ([#520](https://github.com/pelotech/pgtyped/issues/520)) ([e5f920e](https://github.com/pelotech/pgtyped/commit/e5f920e2892c862ca7441aefe9254a102dc4424b))
* use type-only imports in generated files ([72ba5bc](https://github.com/pelotech/pgtyped/commit/72ba5bc4f03df02a9abe8f9f137d305c3e90751d))


### Bug Fixes

* add parser to cli deps ([#505](https://github.com/pelotech/pgtyped/issues/505)) ([d89cc87](https://github.com/pelotech/pgtyped/commit/d89cc871db7a97a7c5b70f64ae7e1314c1d4406e))
* **cli:** pin glob package version to fix TS build ([6658671](https://github.com/pelotech/pgtyped/commit/66586719594a2d1349e41ccef157c52df521e177))
* correct defects found triaging upstream issues against 3.0 ([#21](https://github.com/pelotech/pgtyped/issues/21)) ([bcc4b07](https://github.com/pelotech/pgtyped/commit/bcc4b074f9e8f8a688d39901348a6e029e16dd13))
* deno support ([#595](https://github.com/pelotech/pgtyped/issues/595)) ([6fd02d7](https://github.com/pelotech/pgtyped/commit/6fd02d749d40e6292eb7030ef5ca6733edc3c6bd))
* **deps:** update dependency camel-case to v5 ([e98d908](https://github.com/pelotech/pgtyped/commit/e98d9082b75db6986759d523d7d0c3647658101f))
* **deps:** update dependency chokidar to v4 ([ab96250](https://github.com/pelotech/pgtyped/commit/ab962500f25f37e6740a6494e6250b0dedb04124))
* **deps:** update dependency fs-extra to v11 ([e05f070](https://github.com/pelotech/pgtyped/commit/e05f070e32c867bb559c5609bd061790c553db9a))
* **deps:** update dependency glob to v10 ([1814000](https://github.com/pelotech/pgtyped/commit/1814000ab79e6f857d096b85e0aa6df97eeec7f2))
* **deps:** update dependency glob to v11 ([1cdd631](https://github.com/pelotech/pgtyped/commit/1cdd63176ce54e726c22134220900759c127cbb2))
* **deps:** update dependency glob to v8 ([339070c](https://github.com/pelotech/pgtyped/commit/339070c588415a8bd5af01ddc014b7e27e74586c))
* **deps:** update dependency glob to v9 ([33628a9](https://github.com/pelotech/pgtyped/commit/33628a96136e732dc2bd991fbbb2743e24d4216e))
* **deps:** update dependency nunjucks to v3.2.4 ([336d962](https://github.com/pelotech/pgtyped/commit/336d962faa9fec61e37a71fe5a0132edf620226f))
* **deps:** update dependency pascal-case to v4 ([24789f1](https://github.com/pelotech/pgtyped/commit/24789f1087e8b4b9f87e60646b99d3c4dee1c11b))
* **deps:** update dependency piscina to v4 ([ccb1e36](https://github.com/pelotech/pgtyped/commit/ccb1e366cfc214b3d540a1918c8bc9bcc6828fea))
* **deps:** update dependency piscina to v5 ([00a1769](https://github.com/pelotech/pgtyped/commit/00a176963484f0450e8cbf1fe7ee4a3954f0d132))
* **deps:** update dependency tinypool to ^0.8.0 ([365328e](https://github.com/pelotech/pgtyped/commit/365328e4730c72131f533ad928afafd64a106e26))
* **deps:** update dependency tinypool to v1 ([6a2ae96](https://github.com/pelotech/pgtyped/commit/6a2ae96da736077fc14b81d35b2ca6b12b4537a2))
* **deps:** update dependency tinypool to v2 ([88a428f](https://github.com/pelotech/pgtyped/commit/88a428f3d710e9fc47e8261957e49a74de3c3b59))
* **deps:** update dependency yargs to v18 ([1583951](https://github.com/pelotech/pgtyped/commit/1583951125a5307f13d2780659626018c3ed9d97))
* **deps:** update react monorepo to v18 ([dfc6d30](https://github.com/pelotech/pgtyped/commit/dfc6d30b16cbc70cc4f7c234a121e65b9081a57a))
* disable nunjacks string escaping ([8a78ee8](https://github.com/pelotech/pgtyped/commit/8a78ee85b8442e5c858ee0f10a9761f234e1c639))
* emit Json type when required by JsonArray ([#456](https://github.com/pelotech/pgtyped/issues/456)) ([31c614a](https://github.com/pelotech/pgtyped/commit/31c614a72b0bdfa75db30ded98b273d70380c4eb))
* escape non-identifier keys in generated interfaces ([f9704e0](https://github.com/pelotech/pgtyped/commit/f9704e094e22202040c49194e3f9a839484bf7d3))
* failing glob import ([ad2ce40](https://github.com/pelotech/pgtyped/commit/ad2ce4070d77dc75a230114ba82038a942a14ec7))
* failOnError should destroy threadpool and exit with error code ([aada874](https://github.com/pelotech/pgtyped/commit/aada874f55f84f9caf290800b7d45de9e1c59ea4))
* fix build breaking glob search issue ([603b913](https://github.com/pelotech/pgtyped/commit/603b913ae8bda40a446247de836311acad23f911))
* generate POSIX paths in typesOverrides imports ([#533](https://github.com/pelotech/pgtyped/issues/533)) ([6c20fcb](https://github.com/pelotech/pgtyped/commit/6c20fcb2f66cfd61f188a2ed347bfa4b3eeba119))
* keep every newline in a sql tag's statement text ([#37](https://github.com/pelotech/pgtyped/issues/37)) ([f7aa8a2](https://github.com/pelotech/pgtyped/commit/f7aa8a2beff1ebad2bc919c75619b7038ff1085f))
* lint fixes for PR [#515](https://github.com/pelotech/pgtyped/issues/515) ([b9a2b98](https://github.com/pelotech/pgtyped/commit/b9a2b98ce0ca5d4b78f8e397861cc4e7f500753c))
* load a config that is an ES module ([#39](https://github.com/pelotech/pgtyped/issues/39)) ([c0ab2ab](https://github.com/pelotech/pgtyped/commit/c0ab2ab5beb3580450b118d717aaa429b9b3a55c))
* make three silent failures loud ([#27](https://github.com/pelotech/pgtyped/issues/27)) ([f9a7ab5](https://github.com/pelotech/pgtyped/commit/f9a7ab5b448ce447c0cb112803f2cc412642eca9))
* switch to node16 module resolution ([26254af](https://github.com/pelotech/pgtyped/commit/26254af2860cea7b14712fec470e8f1dae42b53d))
* type a sql tag from its cooked text, as the runtime sends it ([#38](https://github.com/pelotech/pgtyped/issues/38)) ([51189c8](https://github.com/pelotech/pgtyped/commit/51189c885b387dbbd98215b4cea6f948af420905))
* type domains correctly, and stop two config paths failing silently ([#25](https://github.com/pelotech/pgtyped/issues/25)) ([90f626d](https://github.com/pelotech/pgtyped/commit/90f626d41a801ead97bf18948f69ed4d11256f78))
* warn on a param sigil inside a dollar-quoted body ([#36](https://github.com/pelotech/pgtyped/issues/36)) ([9f63fd8](https://github.com/pelotech/pgtyped/commit/9f63fd829589423b9de83d7b0461189b905ba8a8))
* warn when checkPrivileges runs as a superuser ([#42](https://github.com/pelotech/pgtyped/issues/42)) ([aa5ab8e](https://github.com/pelotech/pgtyped/commit/aa5ab8efd6be12e94595a6d0ea716b146817553c))


### Refactoring

* **cli:** codegen on node-postgres ([#15](https://github.com/pelotech/pgtyped/issues/15)) ([6753991](https://github.com/pelotech/pgtyped/commit/675399178a08cfac18fe503c13e328e3fcc64944))
* rename packages to @pelotech/pgtyped-* ([3b3bd64](https://github.com/pelotech/pgtyped/commit/3b3bd64427e9036385e9c26e59cf639b254283b2))


### Build

* replace lerna with pnpm workspaces ([#18](https://github.com/pelotech/pgtyped/issues/18)) ([72a55a2](https://github.com/pelotech/pgtyped/commit/72a55a28980e9f522fb0c67017e3d762ae54f7ab))


### Chores

* require Node 24 and drop the CommonJS build ([80843ec](https://github.com/pelotech/pgtyped/commit/80843ecb747892b87f6356ea35ef9ad90c79252b))


### Documentation

* record the upstream triage, and fix three defects it found ([#22](https://github.com/pelotech/pgtyped/issues/22)) ([d8d2c36](https://github.com/pelotech/pgtyped/commit/d8d2c36ebe35a68a70e307e2b7b597e215e062a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @pelotech/pgtyped-runtime bumped to 3.0.0

## Changelog
