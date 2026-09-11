/** @fileoverview Config file parser */

import { createRequire } from 'module';
import { isAbsolute, join } from 'path';
import type tls from 'node:tls';
import { DatabaseConfig, default as dbUrlModule } from 'ts-parse-database-url';
import { z } from 'zod';
import { Type } from './db/type.js';
import { DEFAULT_SHARED_TYPES_FILE } from './sharedTypes.js';
import { TypeDefinition } from './types.js';

/**
 * Interop hack: `ts-parse-database-url` is CJS, so what the default import
 * yields depends on who did the interop. Under node it is the CJS exports
 * object, whose `.default` is the function; under vitest's transform it can be
 * the function itself. Reaching for both is what makes any code path that
 * parses a connection string testable at all — before this, `dbUrl` threw
 * `parseDatabaseUri is not a function` in the suite while working in the built
 * CLI.
 */
const parseDatabaseUri: (uri: string) => DatabaseConfig =
  typeof dbUrlModule === 'function'
    ? (dbUrlModule as any)
    : ((dbUrlModule as any).default ?? (dbUrlModule as any));

const transformProps = {
  include: z.string(),
  emitTemplate: z.string().optional(),
  /** @deprecated emitFileName is deprecated */
  emitFileName: z.string().optional(),
};

const Transform = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('sql'), ...transformProps }).strict(),
  z.object({ mode: z.literal('ts'), ...transformProps }).strict(),
]);

/**
 * `typesOverrides` is keyed by Postgres **type** name. A column-shaped key
 * passed validation and then did nothing at all — no warning, no error — which
 * is a bad failure mode next to the strictness everywhere else in this file
 * (#567).
 *
 * It is rejected rather than implemented, because it cannot be implemented for
 * both directions. A result column can be traced back to its table, but a
 * *parameter* cannot be traced back to a column at all: ParameterDescription
 * carries type OIDs and nothing else, and nothing in the protocol says that the
 * `$1` in `WHERE status = $1` has anything to do with `lobbies.status`.
 * Answering that needs a real SQL analyser, which this project deliberately
 * does not have. A column-scoped override that silently covered results and not
 * parameters would be the same defect one layer further in.
 *
 * The supported way to type one column differently is a domain, which is a name
 * the mapping can be keyed on — and, since #503/#594, actually fires:
 *
 *   CREATE DOMAIN lobby_status AS text;
 *   ALTER TABLE lobbies ALTER COLUMN status TYPE lobby_status;
 *   "typesOverrides": { "lobby_status": "./x.js#MyStatus" }
 *
 * No type name Postgres reports contains a dot: `pg_type.typname` is not
 * schema-qualified, so a dotted key never matched anything anyway.
 */
const TypeOverrideKey = z.string().refine(
  (key) => !key.includes('.'),
  (key) => ({
    message:
      `"${key}" looks like a column, and typesOverrides is keyed by Postgres type name — ` +
      `a column-scoped override has never had any effect (#567). ` +
      `Override the column's type name instead, or give the column a domain type ` +
      `(CREATE DOMAIN) and override the domain's name.`,
  }),
);

/**
 * Where the type aliases every generated file shares are emitted.
 *
 * A path relative to `srcDir`, or `false` to go back to each generated file
 * declaring its own copy of every alias — which is what made `export *` from
 * two of them `TS2308: Module ... has already exported a member` (#565).
 *
 * The extension is what the file is *written* as; the specifier generated
 * files import through carries the one the emitted JavaScript will have, since
 * this package is ESM-only.
 */
const SharedTypesFile = z
  .union([
    z.literal(false),
    z.string().refine(
      (file) => /\.[mc]?ts$/.test(file) && !isAbsolute(file),
      (file) => ({
        message:
          `"${file}" is not a usable shared types file: it must be a TypeScript file name ` +
          `relative to srcDir, ending in .ts, .mts or .cts. Set it to false to turn shared ` +
          `types off instead.`,
      }),
    ),
  ])
  .default(DEFAULT_SHARED_TYPES_FILE);

/**
 * Every object in the config is strict, not just the top level. A key the
 * schema does not know is silently dropped otherwise, and a dropped key is
 * indistinguishable from one that was never set: `db: { dbname: 'x' }` fell
 * back to the default `postgres` database and generated types against the
 * wrong schema without saying a word. The one exception is `db.ssl`, which is
 * handed to node's TLS stack verbatim.
 */
const Config = z
  .object({
    transforms: z.array(Transform),
    srcDir: z.string(),
    failOnError: z.boolean().default(false),
    camelCaseColumnNames: z.boolean().default(false),
    hungarianNotation: z.boolean().default(false),
    nonEmptyArrayParams: z.boolean().default(false),
    optionalNullParams: z.boolean().default(true),
    preparedStatements: z.boolean().default(true),
    checkPrivileges: z.boolean().default(false),
    sharedTypesFile: SharedTypesFile,
    dbUrl: z.string().optional(),
    db: z
      .object({
        host: z.string().optional(),
        port: z.number().optional(),
        user: z.string().optional(),
        password: z.string().optional(),
        dbName: z.string().optional(),
        // Passed through to node-postgres, which hands it to node's TLS
        // stack: an open set of options this schema has no business
        // enumerating, so this one object stays permissive.
        ssl: z
          .union([
            z.boolean(),
            z.custom<tls.ConnectionOptions>(
              (v) => typeof v === 'object' && v !== null,
            ),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    typesOverrides: z
      .record(
        TypeOverrideKey,
        z.union([
          z.string(),
          z
            .object({
              parameter: z.string().optional(),
              return: z.string().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
  })
  .strict();

export type IConfig = z.input<typeof Config>;
export type TransformConfig = z.infer<typeof Transform>;

export interface ParsedConfig {
  db: {
    host: string;
    user: string;
    password: string | undefined;
    dbName: string;
    port: number;
    ssl?: tls.ConnectionOptions | boolean;
  };
  failOnError: boolean;
  camelCaseColumnNames: boolean;
  hungarianNotation: boolean;
  nonEmptyArrayParams: boolean;
  optionalNullParams: boolean;
  preparedStatements: boolean;
  checkPrivileges: boolean;
  sharedTypesFile: string | false;
  transforms: TransformConfig[];
  srcDir: string;
  typesOverrides: Record<string, Partial<TypeDefinition>>;
}

function merge<T>(base: T, ...overrides: Partial<T>[]): T {
  return overrides.reduce<T>(
    (acc, o) =>
      Object.entries(o).reduce(
        (oAcc, [k, v]) => (v ? { ...oAcc, [k]: v } : oAcc),
        acc,
      ),
    { ...base },
  );
}

type DBConfigFields = ParsedConfig['db'];

/** The ambient variable that can displace each connection field. */
const AMBIENT_VARIABLE: Record<
  keyof Omit<DBConfigFields, 'ssl'>,
  `PG${string}`
> = {
  host: 'PGHOST',
  user: 'PGUSER',
  password: 'PGPASSWORD',
  dbName: 'PGDATABASE',
  port: 'PGPORT',
};

/**
 * Environment over config is the precedence PgTyped has always had, and it is
 * a normal enough convention that someone is relying on it — so it stays. What
 * was wrong is that it happened in silence: a developer with `PGDATABASE=prod`
 * exported in their shell had an explicit `dbUrl` in the config file quietly
 * replaced, and codegen generated types against the wrong schema without a
 * word. It was only visible at all when the displaced value happened to be
 * unreachable, which is the connection pre-flight talking, not this.
 *
 * Only a genuine conflict is reported. A `PG*` variable filling in something
 * the config left unset is the intended way to configure PgTyped from the
 * environment and stays silent, as does one that agrees with the config, and
 * so does one that displaces a value the config never owned — a `--uri` flag's,
 * say, since the flag has already taken precedence over the config by then.
 *
 * Values are quoted into the message so the disagreement can be read at a
 * glance, except for `PGPASSWORD`, which is only ever named.
 */
function ambientOverrideWarnings(
  fromConfigFile: Partial<Record<keyof typeof AMBIENT_VARIABLE, unknown>>,
  sourceInConfigFile: Partial<
    Record<keyof typeof AMBIENT_VARIABLE, 'db' | 'dbUrl'>
  >,
  beforeEnv: Partial<Record<keyof typeof AMBIENT_VARIABLE, unknown>>,
  fromEnv: Partial<Record<keyof typeof AMBIENT_VARIABLE, unknown>>,
): string[] {
  const warnings: string[] = [];
  for (const field of Object.keys(
    AMBIENT_VARIABLE,
  ) as (keyof typeof AMBIENT_VARIABLE)[]) {
    const configured = fromConfigFile[field];
    const ambient = fromEnv[field];
    // `merge` skips falsy overrides, so a variable set to the empty string
    // never displaces anything and must not be reported as though it had.
    if (!configured || !ambient) {
      continue;
    }
    // Something between the config and the environment — the `--uri` flag, or
    // `PGURI` — already replaced this field, so the environment is not what
    // displaced the config's value.
    if (String(beforeEnv[field]) !== String(configured)) {
      continue;
    }
    if (String(ambient) === String(configured)) {
      continue;
    }
    const variable = AMBIENT_VARIABLE[field];
    const source =
      sourceInConfigFile[field] === 'dbUrl' ? 'dbUrl' : `db.${field}`;
    const disagreement =
      field === 'password'
        ? `overrides the password set by ${source} in the config file`
        : `overrides ${field} from the config file: "${String(ambient)}" replaces "${String(
            configured,
          )}", set by ${source}`;
    warnings.push(
      `Warning: environment variable ${variable} ${disagreement}. ` +
        `Environment variables take precedence over the config file, so that is what PgTyped ` +
        `will connect with — unset ${variable} if it is not what you meant.`,
    );
  }
  return warnings;
}

function convertParsedURLToDBConfig({
  host,
  password,
  user,
  port,
  database,
}: DatabaseConfig) {
  return {
    host,
    password,
    user,
    port,
    dbName: database,
  };
}

const require = createRequire(import.meta.url);

export function stringToType(str: string): Type {
  if (
    str.startsWith('./') ||
    str.startsWith('../') ||
    str.includes('#') ||
    str.includes(' as ')
  ) {
    const [firstSection, alias] = str.split(' as ');
    const [from, namedImport] = firstSection.split('#');

    if (!alias && !namedImport) {
      throw new Error(
        `Relative import "${str}" should have an alias if you want to import default (eg. "${str} as MyAlias") or have a named import (eg. "${str}#MyType")`,
      );
    }

    return {
      name: alias ?? namedImport,
      from,
      aliasOf: alias ? (namedImport ?? 'default') : undefined,
    };
  }

  return { name: str };
}

export function parseConfig(
  path: string,
  argConnectionUri?: string,
): ParsedConfig {
  const fullPath = isAbsolute(path) ? path : join(process.cwd(), path);
  const configObject = require(fullPath);

  const declaredTransforms = (
    configObject as { transforms?: { mode?: unknown }[] }
  ).transforms;
  if (declaredTransforms?.some((tr) => tr?.mode === 'ts-implicit')) {
    throw new Error(
      'Transform mode "ts-implicit" was removed in 3.0; use mode "ts" and import the sql tag from @pelotech/pgtyped-runtime directly.',
    );
  }

  const result = Config.safeParse(configObject);
  if (!result.success) {
    throw new Error(
      result.error.issues
        .flatMap((issue) =>
          // Zod reports unknown keys against the enclosing object and lists
          // them in the message, which reads as `db: Unrecognized key(s) ...`.
          // Reported per key instead, the path is the thing to go and fix.
          issue.code === 'unrecognized_keys'
            ? issue.keys.map(
                (key) => `${[...issue.path, key].join('.')}: unrecognized key`,
              )
            : [`${issue.path.join('.') || '(root)'}: ${issue.message}`],
        )
        .join('\n'),
    );
  }

  const defaultDBConfig = {
    host: '127.0.0.1',
    user: 'postgres',
    password: '',
    dbName: 'postgres',
    port: 5432,
  };

  const envDBConfig = {
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    dbName: process.env.PGDATABASE,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    uri: process.env.PGURI ?? process.env.DATABASE_URL,
  };

  const {
    db = defaultDBConfig,
    dbUrl: configDbUri,
    transforms,
    srcDir,
    failOnError,
    camelCaseColumnNames,
    hungarianNotation,
    nonEmptyArrayParams,
    optionalNullParams,
    preparedStatements,
    checkPrivileges,
    sharedTypesFile,
    typesOverrides,
  } = result.data;

  // CLI connectionUri flag takes precedence over the env and config one
  const dbUri = argConnectionUri || envDBConfig.uri || configDbUri;

  const urlDBConfig = dbUri
    ? convertParsedURLToDBConfig(parseDatabaseUri(dbUri))
    : {};

  if (transforms.some((tr) => !!tr.emitFileName)) {
    // tslint:disable:no-console
    console.log(
      'Warning: Setting "emitFileName" is deprecated. Consider using "emitTemplate" instead.',
    );
  }

  // Everything the config file itself asked for, and which key asked for it.
  // `db` defaults to `defaultDBConfig` above, so the declared object is read
  // again here: a default is not something the environment can conflict with.
  const declaredDb: Partial<Record<string, unknown>> = result.data.db ?? {};
  const configOwnsUri = !argConnectionUri && !envDBConfig.uri && !!configDbUri;
  const fromConfigFile: Record<string, unknown> = {};
  const sourceInConfigFile: Record<string, 'db' | 'dbUrl'> = {};
  for (const field of Object.keys(AMBIENT_VARIABLE)) {
    const fromUrl = configOwnsUri
      ? (urlDBConfig as Record<string, unknown>)[field]
      : undefined;
    if (fromUrl) {
      fromConfigFile[field] = fromUrl;
      sourceInConfigFile[field] = 'dbUrl';
    } else if (declaredDb[field]) {
      fromConfigFile[field] = declaredDb[field];
      sourceInConfigFile[field] = 'db';
    }
  }

  const warnings = ambientOverrideWarnings(
    fromConfigFile,
    sourceInConfigFile,
    merge(defaultDBConfig, db, urlDBConfig),
    envDBConfig,
  );
  // The connection string as a whole is displaced the same way, and neither
  // value can be quoted into the message: a URI carries the password.
  if (
    configDbUri &&
    !argConnectionUri &&
    envDBConfig.uri &&
    envDBConfig.uri !== configDbUri
  ) {
    const variable = process.env.PGURI ? 'PGURI' : 'DATABASE_URL';
    warnings.push(
      `Warning: environment variable ${variable} overrides dbUrl from the config file. ` +
        `Environment variables take precedence over the config file, so that is what PgTyped ` +
        `will connect with — unset ${variable} if it is not what you meant.`,
    );
  }
  // tslint:disable-next-line:no-console
  warnings.forEach((warning) => console.warn(warning));

  const finalDBConfig = merge(defaultDBConfig, db, urlDBConfig, envDBConfig);

  const parsedTypesOverrides: Record<string, Partial<TypeDefinition>> = {};

  for (const [typeName, mappedTo] of Object.entries(typesOverrides ?? {})) {
    if (typeof mappedTo === 'string') {
      parsedTypesOverrides[typeName] = {
        parameter: stringToType(mappedTo),
        return: stringToType(mappedTo),
      };
    } else {
      parsedTypesOverrides[typeName] = {
        parameter: mappedTo.parameter
          ? stringToType(mappedTo.parameter)
          : undefined,
        return: mappedTo.return ? stringToType(mappedTo.return) : undefined,
      };
    }
  }

  return {
    db: finalDBConfig,
    transforms,
    srcDir,
    failOnError,
    camelCaseColumnNames,
    hungarianNotation,
    nonEmptyArrayParams,
    optionalNullParams,
    preparedStatements,
    checkPrivileges,
    sharedTypesFile,
    typesOverrides: parsedTypesOverrides,
  };
}
