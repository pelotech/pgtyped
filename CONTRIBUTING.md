# Contributing to pgTyped

pgTyped is an open source project, and we welcome contributions of all kinds, including bug reports, feature requests, and pull requests.

# How to contribute?

Our rules for pull requests and issues are fairly standard and flexible. When submitting a change, please provide a brief and descriptive title, if possible written in the imperative mood.

If you have an idea for a new feature or want to address a bug, it's recommended that you first open an issue. We're available to assist and discuss the process of opening a pull request to ensure your changes are incorporated.

We highly recommend you include a test-case added to the `packages/example` project when you submit a pull request or an issue.

This will help us verify your issue or pull request and prevent regressions in the future.

# Development Setup

To get started, clone the repository and install the dependencies:

```bash
git clone git@github.com:adelsz/pgtyped.git
cd pgtyped
corepack enable
pnpm install
```

We use a mono-repo setup with [pnpm workspaces](https://pnpm.io/workspaces).
This means that running `pnpm install` will install all the dependencies for all the packages in the project.
It will also link the packages together, so that you can make changes to one package and immediately see the effects in another package.

The `packages` directory contains the source code for the various components of pgTyped:

- `packages/cli` - The CLI tool for generating TypeScript types from SQL and TS files.
- `packages/runtime` - The pgTyped runtime library. It provides `TypedQuery`, the `sql` template tag, and the SQL parser shared by the CLI and the tag. It has no dependencies.
- `packages/example` - A small pgTyped project written as a Vitest suite. We use it both as a demonstration of pgTyped and as an end-to-end test suite for the project.

To build the project, run:

```bash
pnpm build
```

This will build all the packages in the project. To run build in watch mode, run:

```bash
pnpm watch
```

To run the tests, run:

```bash
pnpm test
```

It will run the tests for all the packages in the project, including end-to-end tests for the example project.

# The `packages/example` project

The `packages/example` project is an end-to-end test suite for pgTyped. It contains a simple example of a pgTyped project written as a [Vitest](https://vitest.dev/) suite.

The package's `pnpm test` runs the following command:

```bash
docker compose run build && docker compose run test
```

- The `build` target runs pgTyped on the `sql` and `ts` files in the `packages/example/src` directory, generating the query code and type definitions. It also runs `git diff` to verify that the generated code matches the code committed to the repository, so a change to codegen output has to be committed alongside the change that caused it.
- The `test` target runs the queries in `packages/example/src/index.test.ts` against the live database and verifies that the results match the snapshots.

All the targets are run in a Docker container, with a Postgres database running in a separate container spun up by Docker Compose.

The definitions of each of these targets and the DB service can be found in the `packages/example/docker-compose.yml` file.

The database is initialized with the `sql/schema.sql` file.
