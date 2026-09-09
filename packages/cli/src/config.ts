/** @fileoverview Config file parser */

import { createRequire } from 'module';
import { isAbsolute, join } from 'path';
import type tls from 'node:tls';
import { DatabaseConfig, default as dbUrlModule } from 'ts-parse-database-url';
import { z } from 'zod';
import { Type } from './db/type.js';
import { TypeDefinition } from './types.js';

// module import hack
const { default: parseDatabaseUri } = dbUrlModule as any;

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
    preparedStatements: z.boolean().default(true),
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
  preparedStatements: boolean;
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
    preparedStatements,
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
    preparedStatements,
    typesOverrides: parsedTypesOverrides,
  };
}
