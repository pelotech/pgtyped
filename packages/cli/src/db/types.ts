import type { DatabaseError } from 'pg';
import type {
  InterpolatedQuery,
  QueryParameter,
} from '@pelotech/pgtyped-runtime/internal';
import type { DescribedField } from './describe.js';
import type { TypeDb } from './type-db.js';
import { DatabaseTypeKind, isEnum, MappableType } from './type.js';

export interface IQueryTypes {
  paramMetadata: {
    mapping: QueryParameter[];
    params: MappableType[];
  };
  returnTypes: Array<{
    returnName: string;
    columnName: string;
    type: MappableType;
    nullable?: boolean;
    comment?: string;
  }>;
}

export interface IParseError {
  errorCode: string;
  hint?: string;
  message: string;
  position?: string;
}

export type TypeSource = (
  queryData: InterpolatedQuery,
) => Promise<IQueryTypes | IParseError>;

/**
 * Maps a failure from pg onto IParseError. Anything that is not an Error did
 * not come from the driver, so it is rethrown rather than reported as a query
 * problem.
 *
 * `errorCode` was the erroring server routine's name (the 'R' error field) when
 * this went over the hand-rolled wire client, and is now the SQLSTATE. Nothing
 * reads the value: it is the `'errorCode' in typeData` discriminant, and the
 * generator prints the whole object with %o.
 */
function toParseError(err: unknown): IParseError {
  if (!(err instanceof Error)) {
    throw err;
  }
  const { code, hint, position } = err as DatabaseError;
  return { errorCode: code ?? 'UNKNOWN', message: err.message, hint, position };
}

enum TypeCategory {
  ARRAY = 'A',
  BOOLEAN = 'B',
  COMPOSITE = 'C',
  DATE_TIME = 'D',
  ENUM = 'E',
  GEOMETRIC = 'G',
  NETWORK_ADDRESS = 'I',
  NUMERIC = 'N',
  PSEUDO = 'P',
  STRING = 'S',
  TIMESPAN = 'T',
  USERDEFINED = 'U',
  BITSTRING = 'V',
  UNKNOWN = 'X',
}

interface TypeRow {
  oid: number;
  typeName: string;
  typeKind: string;
  enumLabel: string;
  typeCategory?: TypeCategory;
  elementTypeOid?: number;
  /** `pg_type.typbasetype`: set (non-zero) only for a domain. */
  baseTypeOid?: number;
}

/**
 * Resolves one domain OID to a DomainType carrying its base type, following a
 * domain over a domain down to whatever the chain ends in.
 *
 * Falls back to the bare domain name if the base type is missing from the
 * catalog rows, which is what this returned before domains were resolved at
 * all: an overridden name still works, an un-overridden one is reported as
 * unmapped rather than resolved to something invented here.
 */
function resolveDomain(
  oid: number,
  domainRows: Map<number, TypeRow>,
  typeMap: Record<string, MappableType>,
  seen: Set<number>,
): MappableType {
  const row = domainRows.get(oid)!;
  // Postgres rejects a circular domain, so `seen` only guards against a
  // catalog this code has misread.
  if (seen.has(oid) || !row.baseTypeOid) {
    return row.typeName;
  }
  seen.add(oid);
  const baseType = domainRows.has(row.baseTypeOid)
    ? resolveDomain(row.baseTypeOid, domainRows, typeMap, seen)
    : typeMap[row.baseTypeOid];
  return baseType === undefined
    ? row.typeName
    : { name: row.typeName, baseType };
}

// Aggregate rows from database types catalog into MappableTypes
export function reduceTypeRows(
  typeRows: TypeRow[],
): Record<string, MappableType> {
  const enumTypes = typeRows
    .filter((r) => r.typeKind === DatabaseTypeKind.Enum)
    .reduce(
      (typeMap, { oid, typeName, enumLabel }) => {
        const typ = typeMap[oid] ?? typeName;

        // We should get one row per enum value
        return {
          ...typeMap,
          [oid]: {
            name: typeName,
            // Merge enum values
            enumValues: [...(isEnum(typ) ? typ.enumValues : []), enumLabel],
          },
        };
      },
      {} as Record<string, MappableType>,
    );
  const baseTypes = typeRows.reduce(
    (typeMap, { oid, typeName, typeCategory, elementTypeOid }) => {
      // Attempt to merge any partially defined types
      const typ = typeMap[oid] ?? typeName;

      if (oid in enumTypes) {
        return { ...typeMap, [oid]: enumTypes[oid] };
      }

      if (
        typeCategory === TypeCategory.ARRAY &&
        elementTypeOid &&
        elementTypeOid in enumTypes
      ) {
        return {
          ...typeMap,
          [oid]: {
            name: typeName,
            elementType: enumTypes[elementTypeOid],
          },
        };
      }

      return { ...typeMap, [oid]: typ };
    },
    {} as Record<string, MappableType>,
  );

  // Domains resolve last: each one needs the type it is built over, which may
  // be another domain, an enum, or anything else in the map above.
  const domainRows = new Map(
    typeRows
      .filter((r) => r.typeKind === DatabaseTypeKind.Domain)
      .map((r) => [r.oid, r] as const),
  );
  const domainTypes: Record<string, MappableType> = {};
  for (const oid of domainRows.keys()) {
    domainTypes[oid] = resolveDomain(oid, domainRows, baseTypes, new Set());
  }

  return { ...baseTypes, ...domainTypes };
}

/** A row of the pg_type catalog query below, as pg parses it: oids are numbers. */
interface TypeCatalogRow {
  oid: number;
  typname: string;
  typtype: string;
  enumlabel: string | null;
  typelem: number;
  typcategory: TypeCategory;
  typbasetype: number;
}

// TODO: self-host
async function queryTypeRows(
  typeOIDs: number[],
  db: TypeDb,
): Promise<TypeRow[]> {
  if (typeOIDs.length === 0) {
    return [];
  }
  const concatenatedTypeOids = typeOIDs.join(',');
  const rows = (await db.rows(
    `
SELECT pt.oid, pt.typname, pt.typtype, pe.enumlabel, pt.typelem, pt.typcategory, pt.typbasetype
FROM pg_type pt
LEFT JOIN pg_enum pe ON pt.oid = pe.enumtypid
WHERE pt.oid IN (${concatenatedTypeOids})
OR pt.oid IN (SELECT typelem FROM pg_type ptn WHERE ptn.oid IN (${concatenatedTypeOids}));
`,
  )) as unknown as TypeCatalogRow[];
  return rows.map(
    ({
      oid,
      typname,
      typtype,
      enumlabel,
      typelem,
      typcategory,
      typbasetype,
    }) => ({
      oid,
      typeName: typname,
      typeKind: typtype,
      // enumlabel is NULL for every non-enum row (it comes from a LEFT JOIN);
      // only enum rows read it, and those always have one.
      enumLabel: enumlabel ?? '',
      elementTypeOid: typelem,
      typeCategory: typcategory,
      baseTypeOid: typbasetype,
    }),
  );
}

/**
 * The catalog rows for `typeOIDs`, plus the base type of every domain among
 * them, and so on down a chain of domains over domains.
 *
 * A domain that nothing overrides has to resolve to its base type, so the base
 * type has to be in the map — and a domain's base is not otherwise reachable
 * from the OIDs a describe reports. Each extra level costs one round trip, and
 * a query with no domain-typed column or parameter makes none of them.
 */
async function runTypesCatalogQuery(
  typeOIDs: number[],
  db: TypeDb,
): Promise<TypeRow[]> {
  const rows: TypeRow[] = [];
  // Requesting an OID at most once is what bounds this loop, whatever the
  // catalog answers with.
  const requested = new Set<number>();
  let pending = [...new Set(typeOIDs)];
  while (pending.length > 0) {
    pending.forEach((oid) => requested.add(oid));
    const batch = await queryTypeRows(pending, db);
    rows.push(...batch);
    pending = batch
      .filter(
        (r): r is TypeRow & { baseTypeOid: number } =>
          r.typeKind === DatabaseTypeKind.Domain && !!r.baseTypeOid,
      )
      .map((r) => r.baseTypeOid)
      .filter((oid) => !requested.has(oid));
  }
  return rows;
}

interface ColumnComment {
  tableOID: number;
  columnAttrNumber: number;
  comment: string;
}

/** A row of the pg_description query below: objoid and objsubid are numbers. */
interface DescriptionRow {
  objoid: number;
  objsubid: number;
  description: string;
}

async function getComments(
  fields: DescribedField[],
  db: TypeDb,
): Promise<ColumnComment[]> {
  const columnFields = fields.filter((f) => f.columnAttrNumber > 0);
  if (columnFields.length === 0) {
    return [];
  }

  const matchers = columnFields.map(
    (f) => `(objoid=${f.tableOID} and objsubid=${f.columnAttrNumber})`,
  );
  const selection = matchers.join(' or ');

  const descriptionRows = (await db.rows(
    `SELECT
      objoid, objsubid, description
     FROM pg_description WHERE ${selection};`,
  )) as unknown as DescriptionRow[];

  return descriptionRows.map((row) => ({
    tableOID: row.objoid,
    columnAttrNumber: row.objsubid,
    comment: row.description,
  }));
}

/** A row of the pg_attribute query below: attnotnull is a boolean. */
interface AttributeRow {
  attid: string;
  attname: string;
  attnotnull: boolean;
  /**
   * The column's *declared* type. For a domain-typed column this is the domain
   * itself, which is the one place it can be recovered from: RowDescription
   * reports the base type instead (#503, #594).
   */
  atttypid: number;
}

export async function getTypes(
  queryData: InterpolatedQuery,
  db: TypeDb,
): Promise<IQueryTypes | IParseError> {
  const typeData = await db
    .describe(queryData.query)
    .catch((err: unknown) => toParseError(err));
  if ('errorCode' in typeData) {
    return typeData;
  }

  const { params, fields } = typeData;

  const attrMatcher = ({
    tableOID,
    columnAttrNumber,
  }: {
    tableOID: number;
    columnAttrNumber: number;
  }) => `(attrelid = ${tableOID} and attnum = ${columnAttrNumber})`;

  const attrSelection =
    fields.length > 0 ? fields.map(attrMatcher).join(' or ') : false;

  // Before the catalog query, not after: the declared type of each column is
  // one of the OIDs that query has to cover.
  const attributeRows = (await db.rows(
    `SELECT
      (attrelid || ':' || attnum) AS attid, attname, attnotnull, atttypid
     FROM pg_attribute WHERE ${attrSelection};`,
  )) as unknown as AttributeRow[];
  const attrMap: {
    [attid: string]: {
      columnName: string;
      nullable: boolean;
    };
  } = {};
  const declaredTypeOIDs: { [attid: string]: number } = {};
  for (const { attid, attname, attnotnull, atttypid } of attributeRows) {
    attrMap[attid] = {
      columnName: attname,
      // pg parses bool for us, so this is a real boolean: comparing it to the
      // wire client's 't' would make every column nullable.
      nullable: !attnotnull,
    };
    declaredTypeOIDs[attid] = atttypid;
  }

  const getAttid = (
    col: Pick<DescribedField, 'tableOID' | 'columnAttrNumber'>,
  ) => `${col.tableOID}:${col.columnAttrNumber}`;

  const paramTypeOIDs = params.map((p) => p.oid);
  const returnTypesOIDs = fields.map((f) => f.typeOID);
  const usedTypesOIDs = paramTypeOIDs
    .concat(returnTypesOIDs)
    .concat(Object.values(declaredTypeOIDs));
  const typeRows = await runTypesCatalogQuery(usedTypesOIDs, db);
  const commentRows = await getComments(fields, db);
  const typeMap = reduceTypeRows(typeRows);

  /** The OID of every domain in the catalog rows, mapped to its base type. */
  const domainBases = new Map(
    typeRows
      .filter((r) => r.typeKind === DatabaseTypeKind.Domain && r.baseTypeOid)
      .map((r) => [r.oid, r.baseTypeOid!] as const),
  );
  const ultimateBase = (oid: number): number => {
    const seen = new Set<number>();
    let current = oid;
    while (domainBases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = domainBases.get(current)!;
    }
    return current;
  };

  /**
   * The type OID to describe a result column by.
   *
   * RowDescription flattens a domain to its base type, so the domain's own
   * name — the thing a `typesOverrides` entry names — is only reachable
   * through the column it came from. A cast (`contact::text`) reports no
   * source column at all, so it cannot be mistaken for one here; the base
   * types being required to agree is a second check that the column really is
   * the one this field was read from.
   */
  const fieldTypeOID = (f: DescribedField): number => {
    const declared = declaredTypeOIDs[getAttid(f)];
    if (declared === undefined || !domainBases.has(declared)) {
      return f.typeOID;
    }
    return ultimateBase(declared) === f.typeOID ? declared : f.typeOID;
  };

  const commentMap: { [attid: string]: string | undefined } = {};
  for (const c of commentRows) {
    commentMap[`${c.tableOID}:${c.columnAttrNumber}`] = c.comment;
  }

  const returnTypes = fields.map((f) => ({
    ...attrMap[getAttid(f)],
    ...(commentMap[getAttid(f)] ? { comment: commentMap[getAttid(f)] } : {}),
    returnName: f.name,
    type: typeMap[fieldTypeOID(f)],
  }));

  const paramMetadata = {
    params: params.map(({ oid }) => typeMap[oid]),
    mapping: queryData.mapping,
  };

  return { paramMetadata, returnTypes };
}
