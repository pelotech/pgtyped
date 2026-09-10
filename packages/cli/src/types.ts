// Default types
import {
  ImportedType,
  isAlias,
  isDomain,
  isEnum,
  isEnumArray,
  isImport,
  MappableType,
  Type,
} from './db/type.js';
import os from 'os';
import { AliasedType, EnumType } from './db/type.js';
import path from 'path';
import { RUNTIME_MODULE } from './runtimeModule.js';

const String: Type = { name: 'string' };
const Number: Type = { name: 'number' };
const NumberOrString: Type = {
  name: 'NumberOrString',
  definition: 'number | string',
};
const Boolean: Type = { name: 'boolean' };
const Date: Type = { name: 'Date' };
const DateOrString: Type = {
  name: 'DateOrString',
  definition: 'Date | string',
};
// `bytea` is the one mapped type whose TypeScript name is not an ES global.
// Naming the module it comes from makes the generated file import it, rather
// than assume @types/node is on the ambient global list — which it is not
// under Deno, workerd or a project that sets `"types": []` (#612, #262).
const Bytes: Type = { name: 'Buffer', from: 'node:buffer' };
const Void: Type = { name: 'undefined' };
const Json: Type = {
  name: 'Json',
  definition:
    'null | boolean | number | string | Json[] | { [key: string]: Json }',
};
/**
 * A `point` arrives as an object with numeric `x` and `y`, not as the `[x, y]`
 * tuple this used to declare (#552).
 */
const PgPoint: Type = {
  name: 'PgPoint',
  definition: '{ x: number; y: number }',
};
/**
 * An `interval` arrives as a `PostgresInterval`, from the `postgres-interval`
 * package node-postgres depends on. The shape is declared structurally rather
 * than imported from that transitive dependency, so that generated files go on
 * depending on nothing (#552).
 *
 * Every field is optional because the parser sets only the ones the interval
 * actually uses: `'1 hour'` parses to `{ hours: 1 }`, and `'0 seconds'` to
 * `{}`. Reading an absent field gives `undefined`, never `0`.
 *
 * The three methods are real — they live on `PostgresInterval.prototype`, so a
 * returned value satisfies this type structurally. `toString` is deliberately
 * absent: it is only the one inherited from `Object`, and returns
 * `'[object Object]'`. Declaring the methods is also what makes them the only
 * way to build a value of this type, which is the point: a hand-written
 * `{ hours: 1 }` is not an interval node-postgres can send back to the server.
 */
const PgInterval: Type = {
  name: 'PgInterval',
  definition: `{
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
  toPostgres(): string;
  toISO(): string;
  toISOString(): string;
}`,
};
const getArray = (baseType: Type): Type => ({
  name: `${baseType.name}Array`,
  definition: `(${baseType.definition ?? baseType.name})[]`,
});

export const DefaultTypeMapping = Object.freeze({
  // Integer types
  int2: { parameter: Number, return: Number },
  int4: { parameter: Number, return: Number },
  int8: { parameter: NumberOrString, return: String },
  smallint: { parameter: Number, return: Number },
  int: { parameter: Number, return: Number },
  bigint: { parameter: NumberOrString, return: String },

  // Precision types
  real: { parameter: Number, return: Number },
  float4: { parameter: Number, return: Number },
  float: { parameter: Number, return: Number },
  float8: { parameter: Number, return: Number },
  numeric: { parameter: NumberOrString, return: String },
  decimal: { parameter: NumberOrString, return: String },

  // Serial types
  smallserial: { parameter: Number, return: Number },
  serial: { parameter: Number, return: Number },
  bigserial: { parameter: NumberOrString, return: String },

  // Common string types
  uuid: { parameter: String, return: String },
  text: { parameter: String, return: String },
  varchar: { parameter: String, return: String },
  char: { parameter: String, return: String },
  bpchar: { parameter: String, return: String },
  citext: { parameter: String, return: String },
  name: { parameter: String, return: String },
  // A bit string is its digits, '101' — not a boolean, which is what this was
  // declared as until #552. Sending a boolean is a server-side error:
  // `"t" is not a valid binary digit`.
  bit: { parameter: String, return: String },

  // Bool types
  bool: { parameter: Boolean, return: Boolean },
  boolean: { parameter: Boolean, return: Boolean },

  // Dates and times
  date: { parameter: DateOrString, return: Date },
  timestamp: { parameter: DateOrString, return: Date },
  timestamptz: { parameter: DateOrString, return: Date },
  // `time`, `timetz` and `interval` are not `Date`s in either direction. They
  // come back as the server's own text (`'01:02:03'`, `'01:02:03+00'`) or, for
  // `interval`, as a parsed object; and a `Date` passed *in* serialises to a
  // full ISO timestamp, which none of the three can parse — `invalid input
  // syntax for type time: "2019-12-31T17:02:03.000-08:00"` (#552).
  time: { parameter: String, return: String },
  timetz: { parameter: String, return: String },
  interval: { parameter: String, return: PgInterval },

  // Network address types
  inet: { parameter: String, return: String },
  cidr: { parameter: String, return: String },
  macaddr: { parameter: String, return: String },
  macaddr8: { parameter: String, return: String },

  // Range types
  //
  // node-postgres registers no parser for any of them, so a range column
  // arrives as the server's own literal — `["2020-01-01 00:00:00+00",
  // "2020-02-01 00:00:00+00")` — and the same literal is what the server
  // accepts back. Without these entries a range column generated `unknown`
  // and logged `Postgres type 'tstzrange' is not supported by mapping` (#213).
  //
  // Only the six built-in range types are listed. A user-defined range (or a
  // multirange, PG14+) still needs a `typesOverrides` entry, and an *array* of
  // ranges is the `_bit` case: pg-types cannot parse it either, so `_tstzrange`
  // arrives as one string rather than the `stringArray` derived here.
  int4range: { parameter: String, return: String },
  int8range: { parameter: String, return: String },
  numrange: { parameter: String, return: String },
  tsrange: { parameter: String, return: String },
  tstzrange: { parameter: String, return: String },
  daterange: { parameter: String, return: String },

  // Extra types
  money: { parameter: String, return: String },
  tsvector: { parameter: String, return: String },
  void: { parameter: Void, return: Void },

  // JSON types
  json: { parameter: Json, return: Json },
  jsonb: { parameter: Json, return: Json },

  // Bytes
  bytea: { parameter: Bytes, return: Bytes },

  // Postgis types
  // Returned as `{ x, y }`. Neither that object nor the `[x, y]` this used to
  // declare can be sent back as a parameter — both serialise to something the
  // server rejects — so the only input form is the literal text, '(1,2)'.
  point: { parameter: String, return: PgPoint },

  // Array types whose elements are *not* parsed the way the scalar type is,
  // and so cannot be derived by wrapping it (see `TypeAllocator.use`).
  //
  // A lone `numeric` is returned as a string, to keep the arbitrary precision
  // that is the reason to choose the type at all. The elements of a
  // `numeric[]` are nevertheless run through `parseFloat`. A sweep of 21 array
  // types against PostgreSQL 17 found this to be the only one that disagrees
  // with its own scalar, so it is the only exception listed here (#552).
  //
  // The parameter direction needs no exception: the server accepts both
  // numbers and strings as elements, exactly as it does for a lone `numeric`.
  _numeric: { parameter: getArray(NumberOrString), return: getArray(Number) },
});

export type BuiltinTypes = keyof typeof DefaultTypeMapping;

export type TypeDefinition = { parameter: Type; return: Type };

export type TypeMapping = Record<BuiltinTypes, TypeDefinition> &
  Record<string, TypeDefinition>;

export function TypeMapping(
  overrides: Record<string, Partial<TypeDefinition>> = {},
): TypeMapping {
  const output = { ...overrides };

  for (const typeName of Object.keys(DefaultTypeMapping)) {
    output[typeName] = {
      parameter:
        overrides[typeName]?.parameter ??
        DefaultTypeMapping[typeName as BuiltinTypes].parameter,
      return:
        overrides[typeName]?.return ??
        DefaultTypeMapping[typeName as BuiltinTypes].return,
    };
  }

  return output as TypeMapping;
}

export function declareImport(
  imports: ImportedType[],
  decsFileName: string,
): string {
  // name => alias
  const names = new Map<string, string>();
  let defaultImportAlias: string | null = null;

  for (const imp of imports) {
    if (imp.aliasOf === 'default') {
      defaultImportAlias ??= imp.name;

      if (imp.name !== defaultImportAlias) {
        throw new Error(
          `Default import from package "${imp.from}" is aliased differently multiple times (${imp.name} and ${defaultImportAlias})`,
        );
      }

      continue;
    }

    const namedImport = imp.aliasOf ?? imp.name;

    if (!names.has(namedImport)) {
      names.set(namedImport, imp.name);
    } else if (names.get(namedImport) !== imp.name) {
      throw new Error(
        `Import ${namedImport} from package "${
          imp.from
        }" is aliased differently multiple times (${imp.name} and ${names.get(
          namedImport,
        )})`,
      );
    }
  }

  let from = imports[0].from;

  if (from.startsWith('.')) {
    from = path.relative(path.dirname(decsFileName), imports[0].from);
    if (os.platform() === 'win32') {
      // make sure we use posix separators in TS import declarations (see #533)
      from = from.split(path.sep).join(path.posix.sep);
    }

    if (!from.startsWith('.')) {
      from = './' + from;
    }
  }

  const lines = [];

  if (defaultImportAlias) {
    const defaultImportDec = `import type ${defaultImportAlias} from ${quoteString(
      from,
    )};`;
    if (names.size > 0) {
      // A type-only import can specify a default import or named bindings, but not both.
      lines.push(defaultImportDec);
    } else {
      return `${defaultImportDec}\n`;
    }
  }

  // Handle named bindings

  const parts = ['import'];

  if (from !== RUNTIME_MODULE) {
    parts.push('type');
  }

  const subParts = [];

  if (names.size) {
    subParts.push(
      `{ ${[...names.entries()]
        .map(([name, alias]) => (name === alias ? name : `${name} as ${alias}`))
        .join(', ')} }`,
    );
  }

  parts.push(subParts.join(', '));
  parts.push(`from ${quoteString(from)};\n`);

  lines.push(parts.join(' '));

  return lines.join('\n');
}

function declareAlias(name: string, definition: string): string {
  return `export type ${name} = ${definition};\n`;
}

/**
 * `value` as a TypeScript string literal.
 *
 * Interpolating it raw emits a file that does not parse — an enum value
 * containing an apostrophe used to generate `'car's'` while codegen still
 * exited 0 (#611). `JSON.stringify` does the escaping, including backslashes
 * and control characters; the result is re-quoted so that generated files keep
 * the single-quoted style they have always had, and so that fixing this
 * changes no output that was valid before.
 */
function quoteString(value: string): string {
  const escaped = JSON.stringify(value)
    .slice(1, -1)
    // Inside single quotes the escaping JSON needs is the other way round: a
    // double quote stands for itself, an apostrophe has to be escaped.
    .replace(/\\"/g, '"')
    .replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function declareStringUnion(name: string, values: string[]) {
  return declareAlias(name, values.sort().map(quoteString).join(' | '));
}

export enum TypeScope {
  Parameter = 'parameter',
  Return = 'return',
}

type importsType = { [k: string]: ImportedType[] };

export type TypeDefinitions = {
  imports: importsType;
  enums: EnumType[];
  aliases: AliasedType[];
};

/** Wraps a TypeMapping to track which types have been used, to accumulate errors,
 * and emit necessary type definitions. */
export class TypeAllocator {
  errors: Error[] = [];
  // from -> ImportedType[]
  imports: { [k: string]: ImportedType[] } = {};
  // name -> definition (if any)
  types: { [k: string]: Type } = {};

  constructor(
    private mapping: TypeMapping,
    private allowUnmappedTypes?: boolean,
  ) {}

  isMappedType(name: string): name is keyof TypeMapping {
    return name in this.mapping;
  }

  /** Lookup a database-provided type name in the allocator's map */
  use(typeNameOrType: MappableType, scope: TypeScope): string {
    let typ: Type | null;

    if (typeof typeNameOrType == 'string') {
      if (this.mapping[typeNameOrType]?.[scope]) {
        // An entry naming the type exactly wins over the array derivation
        // below. Deriving an array type from its element type is right for
        // almost all of them, but not for every one — `_numeric` is parsed
        // into numbers while a lone `numeric` is a string — and a
        // `typesOverrides` entry naming an array type was previously ignored,
        // because the `_` branch ran before the mapping was ever consulted.
        typ = this.mapping[typeNameOrType][scope];
      } else if (typeNameOrType[0] === '_') {
        // If starts with _ it is an PG Array type

        const arrayValueType = typeNameOrType.slice(1);
        // ^ Converts _varchar -> varchar, then wraps the type in an array

        const mappedType = this.use(arrayValueType, scope);
        typ = getArray({ name: mappedType });
      } else {
        if (!this.isMappedType(typeNameOrType)) {
          if (this.allowUnmappedTypes) {
            return typeNameOrType;
          }
          this.errors.push(
            new Error(
              `Postgres type '${typeNameOrType}' is not supported by mapping`,
            ),
          );
          return 'unknown';
        }
        typ = this.mapping[typeNameOrType][scope];
      }
    } else {
      if (isDomain(typeNameOrType)) {
        // The domain's own name is offered to the mapping first: that is the
        // whole point of recovering it, and a `typesOverrides` entry naming a
        // domain never fired before (#503, #594).
        //
        // When nothing claims the name, the type resolves to its base — which
        // is what a domain column generated before this existed, and is what
        // keeps every project that has domain columns and no override for them
        // compiling. Upstream PR #637 stops one step short of this, leaving
        // the bare domain name to reach the mapping and fail: `contact:
        // string` becomes `contact: unknown` plus a codegen error.
        const mapped = this.mapping[typeNameOrType.name]?.[scope];
        if (!mapped) {
          return this.use(typeNameOrType.baseType, scope);
        }
        typ = mapped;
      } else if (isEnumArray(typeNameOrType)) {
        if (this.mapping[typeNameOrType.elementType.name]?.[scope]) {
          typ = getArray({
            name: typeNameOrType.elementType.name,
            definition:
              this.mapping[typeNameOrType.elementType.name][scope].name,
          });
        } else {
          typ = getArray(typeNameOrType.elementType);
        }
        // make sure the element type is used so it appears in the declaration
        this.use(typeNameOrType.elementType, scope);
      } else {
        typ = this.mapping[typeNameOrType.name]?.[scope] ?? typeNameOrType;
      }
    }

    // Track type on first occurrence
    this.types[typ.name] = this.types[typ.name] ?? typ;

    // Merge imports
    if (isImport(typ)) {
      this.imports[typ.from] = this.imports[typ.from] ?? [];
      this.imports[typ.from].push(typ);
    }

    return typ.name;
  }

  // A plain, serializable view of the allocated types
  public toTypeDefinitions(): TypeDefinitions {
    return {
      imports: this.imports,
      enums: Object.values(this.types).filter(isEnum),
      aliases: Object.values(this.types).filter(isAlias),
    };
  }

  // Static so we can also use this for serialized typeDefinitions
  public static typeDefinitionDeclarations(
    decsFileName: string,
    types: TypeDefinitions,
  ): string {
    return [
      Object.values(types.imports)
        .map((i) => declareImport(i, decsFileName))
        .join('\n'),
      types.enums
        .map((t) => declareStringUnion(t.name, t.enumValues))
        .sort()
        .join('\n'),
      types.aliases
        .map((t) => declareAlias(t.name, t.definition))
        .sort()
        .join('\n'),
    ]
      .filter((s) => s)
      .join('\n');
  }

  /** Emit a typescript definition for all types that have been used */
  declaration(decsFileName: string): string {
    return TypeAllocator.typeDefinitionDeclarations(
      decsFileName,
      this.toTypeDefinitions(),
    );
  }
}
