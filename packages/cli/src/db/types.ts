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
  return typeRows.reduce(
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
}

/** A row of the pg_type catalog query below, as pg parses it: oids are numbers. */
interface TypeCatalogRow {
  oid: number;
  typname: string;
  typtype: string;
  enumlabel: string | null;
  typelem: number;
  typcategory: TypeCategory;
}

// TODO: self-host
async function runTypesCatalogQuery(
  typeOIDs: number[],
  db: TypeDb,
): Promise<TypeRow[]> {
  if (typeOIDs.length === 0) {
    return [];
  }
  const concatenatedTypeOids = typeOIDs.join(',');
  const rows = (await db.rows(
    `
SELECT pt.oid, pt.typname, pt.typtype, pe.enumlabel, pt.typelem, pt.typcategory
FROM pg_type pt
LEFT JOIN pg_enum pe ON pt.oid = pe.enumtypid
WHERE pt.oid IN (${concatenatedTypeOids})
OR pt.oid IN (SELECT typelem FROM pg_type ptn WHERE ptn.oid IN (${concatenatedTypeOids}));
`,
  )) as unknown as TypeCatalogRow[];
  return rows.map(
    ({ oid, typname, typtype, enumlabel, typelem, typcategory }) => ({
      oid,
      typeName: typname,
      typeKind: typtype,
      // enumlabel is NULL for every non-enum row (it comes from a LEFT JOIN);
      // only enum rows read it, and those always have one.
      enumLabel: enumlabel ?? '',
      elementTypeOid: typelem,
      typeCategory: typcategory,
    }),
  );
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

  const paramTypeOIDs = params.map((p) => p.oid);
  const returnTypesOIDs = fields.map((f) => f.typeOID);
  const usedTypesOIDs = paramTypeOIDs.concat(returnTypesOIDs);
  const typeRows = await runTypesCatalogQuery(usedTypesOIDs, db);
  const commentRows = await getComments(fields, db);
  const typeMap = reduceTypeRows(typeRows);

  const attrMatcher = ({
    tableOID,
    columnAttrNumber,
  }: {
    tableOID: number;
    columnAttrNumber: number;
  }) => `(attrelid = ${tableOID} and attnum = ${columnAttrNumber})`;

  const attrSelection =
    fields.length > 0 ? fields.map(attrMatcher).join(' or ') : false;

  const attributeRows = (await db.rows(
    `SELECT
      (attrelid || ':' || attnum) AS attid, attname, attnotnull
     FROM pg_attribute WHERE ${attrSelection};`,
  )) as unknown as AttributeRow[];
  const attrMap: {
    [attid: string]: {
      columnName: string;
      nullable: boolean;
    };
  } = attributeRows.reduce(
    (acc, { attid, attname, attnotnull }) => ({
      ...acc,
      [attid]: {
        columnName: attname,
        // pg parses bool for us, so this is a real boolean: comparing it to the
        // wire client's 't' would make every column nullable.
        nullable: !attnotnull,
      },
    }),
    {},
  );

  const getAttid = (
    col: Pick<DescribedField, 'tableOID' | 'columnAttrNumber'>,
  ) => `${col.tableOID}:${col.columnAttrNumber}`;

  const commentMap: { [attid: string]: string | undefined } = {};
  for (const c of commentRows) {
    commentMap[`${c.tableOID}:${c.columnAttrNumber}`] = c.comment;
  }

  const returnTypes = fields.map((f) => ({
    ...attrMap[getAttid(f)],
    ...(commentMap[getAttid(f)] ? { comment: commentMap[getAttid(f)] } : {}),
    returnName: f.name,
    type: typeMap[f.typeOID],
  }));

  const paramMetadata = {
    params: params.map(({ oid }) => typeMap[oid]),
    mapping: queryData.mapping,
  };

  return { paramMetadata, returnTypes };
}
