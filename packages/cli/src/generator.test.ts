import { IQueryTypes } from './db/types.js';
import {
  ParameterTransform,
  parseSqlFile,
  type QueryIR,
} from '@pelotech/pgtyped-runtime/internal';
import { ParsedConfig } from './config.js';
import {
  escapeComment,
  generateDeclarations,
  generateInterface,
  generateTypedecsFromFile,
  queryToTypeDeclarations,
} from './generator.js';
import type { TypeDb } from './db/type-db.js';
import { parseCode as parseTypeScriptFile } from './parseTypescript.js';
import { TypeAllocator, TypeMapping, TypeScope } from './types.js';

const partialConfig = { hungarianNotation: true } as ParsedConfig;

/** A database that describes every query as taking and returning nothing. */
const emptyDb: TypeDb = {
  describe: async () => ({ params: [], fields: [] }),
  rows: async () => [],
};

type Mode = 'sql' | 'ts';

/** Runs the same front-end codegen uses, so the tests exercise the real IR. */
function parsedQuery(mode: Mode, queryString: string): QueryIR {
  if (mode === 'sql') {
    const { queries, errors } = parseSqlFile(queryString);
    expect(errors).toEqual([]);
    return queries[0];
  }
  const { queries, errors } = parseTypeScriptFile(queryString);
  expect(errors).toEqual([]);
  return queries[0];
}

describe('query-to-interface translation', () => {
  (['sql', 'ts'] as const).forEach((mode) => {
    test(`TypeMapping and declarations (${mode})`, async () => {
      const queryStringSQL = `
    /* @name GetNotifications */
    SELECT payload, type FROM notifications WHERE id = :userId;
    `;
      const queryStringTS = `
      const getNotifications = sql\`SELECT payload, type FROM notifications WHERE id = $userId\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'payload',
            columnName: 'payload',
            type: 'json',
            nullable: false,
            comment: 'Notification contents @type {Notification}',
          },
          {
            returnName: 'type',
            columnName: 'type',
            type: { name: 'PayloadType', enumValues: ['message', 'dynamite'] },
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userId',
              type: ParameterTransform.Scalar,
              assignedIndex: 1,
              required: false,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      // Test out imports
      types.use(
        { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
        TypeScope.Return,
      );
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        partialConfig,
      );
      const expectedTypes = `import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type PayloadType = 'dynamite' | 'message';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

      expect(types.declaration('file.ts')).toEqual(expectedTypes);
      const expected = `/** 'GetNotifications' parameters type */
export interface IGetNotificationsParams {
  userId?: string | null | void;
}

/** 'GetNotifications' return type */
export interface IGetNotificationsResult {
  /** Notification contents @type {Notification} */
  payload: Json;
  type: PayloadType;
}

/** 'GetNotifications' query type */
export interface IGetNotificationsQuery {
  params: IGetNotificationsParams;
  result: IGetNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    test(`Insert notification query (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name InsertNotifications
      @param notification -> (payload, user_id, type)
    */
    INSERT INTO notifications (payload, user_id, type) VALUES :notification;
    `;
      const queryStringTS = `const insertNotifications = sql\`INSERT INTO notifications (payload, user_id, type) VALUES $notification(payload, user_id, type)\`;`;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [],
        paramMetadata: {
          params: ['json', 'uuid', 'text'],
          mapping: [
            {
              name: 'notification',
              type: ParameterTransform.Pick,
              dict: {
                payload: {
                  name: 'payload',
                  assignedIndex: 1,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
                user_id: {
                  name: 'user_id',
                  assignedIndex: 2,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
                type: {
                  name: 'type',
                  assignedIndex: 3,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
              },
            },
          ],
        },
      };
      const types = new TypeAllocator(TypeMapping());
      const typeSource = async (_: any) => mockTypes;
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        partialConfig,
      );
      const expected = `/** 'InsertNotifications' parameters type */
export interface IInsertNotificationsParams {
  notification: {
    payload: Json | null | void,
    user_id: string | null | void,
    type: string | null | void
  };
}

/** 'InsertNotifications' return type */
export type IInsertNotificationsResult = void;

/** 'InsertNotifications' query type */
export interface IInsertNotificationsQuery {
  params: IInsertNotificationsParams;
  result: IInsertNotificationsResult;
}

`;
      expect(result).toEqual(expected);
    });

    test(`DeleteUsers by UUID (${mode})`, async () => {
      const queryStringSQL = `
    /* @name DeleteUsers */
      delete from users * where name = :userName and id = :userId and note = :userNote returning id, id, name, note as bote;
    `;
      const queryStringTS = `const deleteUsers = sql\`delete from users * where name = $userName and id = $userId and note = $userNote returning id, id, name, note as bote\``;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'id',
            columnName: 'id',
            type: 'uuid',
            nullable: false,
          },
          {
            returnName: 'name',
            columnName: 'name',
            type: 'text',
            nullable: false,
          },
          {
            returnName: 'bote',
            columnName: 'note',
            type: 'text',
            nullable: true,
          },
        ],
        paramMetadata: {
          params: ['text', 'uuid', 'text'],
          mapping: [
            {
              name: 'userName',
              type: ParameterTransform.Scalar,
              required: false,
              assignedIndex: 1,
            },
            {
              name: 'userId',
              type: ParameterTransform.Scalar,
              required: false,
              assignedIndex: 2,
            },
            {
              name: 'userNote',
              type: ParameterTransform.Scalar,
              required: false,
              assignedIndex: 3,
            },
          ],
        },
      };
      const types = new TypeAllocator(TypeMapping());
      const typeSource = async (_: any) => mockTypes;
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        partialConfig,
      );
      const expected = `/** 'DeleteUsers' parameters type */
export interface IDeleteUsersParams {
  userId?: string | null | void;
  userName?: string | null | void;
  userNote?: string | null | void;
}

/** 'DeleteUsers' return type */
export interface IDeleteUsersResult {
  bote: string | null;
  id: string;
  name: string;
}

/** 'DeleteUsers' query type */
export interface IDeleteUsersQuery {
  params: IDeleteUsersParams;
  result: IDeleteUsersResult;
}

`;
      expect(result).toEqual(expected);
    });

    test(`TypeMapping and declarations camelCase (${mode})`, async () => {
      const queryStringSQL = `
    /* @name GetNotifications */
    SELECT payload, type FROM notifications WHERE id = :userId;
    `;
      const queryStringTS = `
      const getNotifications = sql\`SELECT payload, type FROM notifications WHERE id = $userId\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'payload_camel_case',
            columnName: 'payload',
            type: 'json',
            nullable: false,
          },
          {
            returnName: 'type_camel_case',
            columnName: 'type',
            type: { name: 'PayloadType', enumValues: ['message', 'dynamite'] },
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userId',
              type: ParameterTransform.Scalar,
              required: false,
              assignedIndex: 1,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      // Test out imports
      types.use(
        { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
        TypeScope.Return,
      );
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        { camelCaseColumnNames: true, hungarianNotation: true } as ParsedConfig,
      );
      const expectedTypes = `import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type PayloadType = 'dynamite' | 'message';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

      expect(types.declaration('file.ts')).toEqual(expectedTypes);
      const expected = `/** 'GetNotifications' parameters type */
export interface IGetNotificationsParams {
  userId?: string | null | void;
}

/** 'GetNotifications' return type */
export interface IGetNotificationsResult {
  payloadCamelCase: Json;
  typeCamelCase: PayloadType;
}

/** 'GetNotifications' query type */
export interface IGetNotificationsQuery {
  params: IGetNotificationsParams;
  result: IGetNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    test(`readonly array params (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name GetNotifications
      @param userIds -> (...)
    */
    SELECT payload, type FROM notifications WHERE id in :userIds
    `;
      const queryStringTS = `
      const getNotifications = sql\`SELECT payload, type FROM notifications WHERE id in $userIds\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'payload_camel_case',
            columnName: 'payload',
            type: 'json',
            nullable: false,
          },
          {
            returnName: 'type_camel_case',
            columnName: 'type',
            type: { name: 'PayloadType', enumValues: ['message', 'dynamite'] },
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userIds',
              type: ParameterTransform.Spread,
              assignedIndex: 1,
              required: false,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      // Test out imports
      types.use(
        { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
        TypeScope.Return,
      );
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        { camelCaseColumnNames: true, hungarianNotation: true } as ParsedConfig,
      );
      const expectedTypes = `import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type PayloadType = 'dynamite' | 'message';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

      expect(types.declaration('file.ts')).toEqual(expectedTypes);
      const expected = `/** 'GetNotifications' parameters type */
export interface IGetNotificationsParams {
  userIds: readonly (string | null | void)[];
}

/** 'GetNotifications' return type */
export interface IGetNotificationsResult {
  payloadCamelCase: Json;
  typeCamelCase: PayloadType;
}

/** 'GetNotifications' query type */
export interface IGetNotificationsQuery {
  params: IGetNotificationsParams;
  result: IGetNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    test(`Non-empty array parameters (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name GetNotifications
      @param userIds -> (...)
    */
    SELECT payload, type FROM notifications WHERE id in :userIds;
    `;
      const queryStringTS = `
      const getNotifications = sql\`SELECT payload, type FROM notifications WHERE id in $userIds\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'payload',
            columnName: 'payload',
            type: 'json',
            nullable: false,
          },
          {
            returnName: 'type',
            columnName: 'type',
            type: { name: 'PayloadType', enumValues: ['message', 'dynamite'] },
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userIds',
              type: ParameterTransform.Spread,
              assignedIndex: 1,
              required: false,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      // Test out imports
      types.use(
        { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
        TypeScope.Return,
      );
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        { nonEmptyArrayParams: true, hungarianNotation: true } as ParsedConfig,
      );
      const expectedTypes = `import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type PayloadType = 'dynamite' | 'message';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

      expect(types.declaration('file.ts')).toEqual(expectedTypes);
      const expected = `/** 'GetNotifications' parameters type */
export interface IGetNotificationsParams {
  userIds: readonly [string | null | void, ...(string | null | void)[]];
}

/** 'GetNotifications' return type */
export interface IGetNotificationsResult {
  payload: Json;
  type: PayloadType;
}

/** 'GetNotifications' query type */
export interface IGetNotificationsQuery {
  params: IGetNotificationsParams;
  result: IGetNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    test(`Required non-empty array parameters (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name GetNotifications
      @param userIds -> (...)
    */
    SELECT payload, type FROM notifications WHERE id in :userIds!;
    `;
      const queryStringTS = `
      const getNotifications = sql\`SELECT payload, type FROM notifications WHERE id in $userIds!\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'payload',
            columnName: 'payload',
            type: 'json',
            nullable: false,
          },
          {
            returnName: 'type',
            columnName: 'type',
            type: { name: 'PayloadType', enumValues: ['message', 'dynamite'] },
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userIds',
              type: ParameterTransform.Spread,
              assignedIndex: 1,
              required: true,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      // Test out imports
      types.use(
        { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
        TypeScope.Return,
      );
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        { nonEmptyArrayParams: true, hungarianNotation: true } as ParsedConfig,
      );
      const expectedTypes = `import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type PayloadType = 'dynamite' | 'message';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

      expect(types.declaration('file.ts')).toEqual(expectedTypes);
      const expected = `/** 'GetNotifications' parameters type */
export interface IGetNotificationsParams {
  userIds: readonly [string, ...(string)[]];
}

/** 'GetNotifications' return type */
export interface IGetNotificationsResult {
  payload: Json;
  type: PayloadType;
}

/** 'GetNotifications' query type */
export interface IGetNotificationsQuery {
  params: IGetNotificationsParams;
  result: IGetNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    test(`Non-empty object spread insert (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name InsertNotifications
      @param notification -> ((payload, user_id, type)...)
    */
    INSERT INTO notifications (payload, user_id, type) VALUES :notification;
    `;
      const queryStringTS = `const insertNotifications = sql\`INSERT INTO notifications (payload, user_id, type) VALUES $notification(payload, user_id, type)\`;`;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [],
        paramMetadata: {
          params: ['json', 'uuid', 'text'],
          mapping: [
            {
              name: 'notification',
              type: ParameterTransform.PickSpread,
              dict: {
                payload: {
                  name: 'payload',
                  assignedIndex: 1,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
                user_id: {
                  name: 'user_id',
                  assignedIndex: 2,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
                type: {
                  name: 'type',
                  assignedIndex: 3,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
              },
            },
          ],
        },
      };
      const types = new TypeAllocator(TypeMapping());
      const typeSource = async (_: any) => mockTypes;
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        { nonEmptyArrayParams: true, hungarianNotation: true } as ParsedConfig,
      );
      const expected = `/** 'InsertNotifications' parameters type */
export interface IInsertNotificationsParams {
  notification: readonly [{
    payload: Json | null | void,
    user_id: string | null | void,
    type: string | null | void
  }, ...({
    payload: Json | null | void,
    user_id: string | null | void,
    type: string | null | void
  })[]];
}

/** 'InsertNotifications' return type */
export type IInsertNotificationsResult = void;

/** 'InsertNotifications' query type */
export interface IInsertNotificationsQuery {
  params: IInsertNotificationsParams;
  result: IInsertNotificationsResult;
}

`;
      expect(result).toEqual(expected);
    });

    test(`Columns without nullable info should be nullable (${mode})`, async () => {
      const queryStringSQL = `
    /* @name GetNotifications */
    SELECT payload, type FROM notifications WHERE id = :userId;
    `;
      const queryStringTS = `
      const getNotifications = sql\`SELECT payload, type FROM notifications WHERE id = $userId\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'payload',
            columnName: 'payload',
            type: 'json',
          },
          {
            returnName: 'type',
            columnName: 'type',
            type: { name: 'PayloadType', enumValues: ['message', 'dynamite'] },
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userId',
              type: ParameterTransform.Scalar,
              required: false,
              assignedIndex: 1,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      // Test out imports
      types.use(
        { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
        TypeScope.Return,
      );
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        partialConfig,
      );
      const expectedTypes = `import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type PayloadType = 'dynamite' | 'message';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

      expect(types.declaration('file.ts')).toEqual(expectedTypes);
      const expected = `/** 'GetNotifications' parameters type */
export interface IGetNotificationsParams {
  userId?: string | null | void;
}

/** 'GetNotifications' return type */
export interface IGetNotificationsResult {
  payload: Json | null;
  type: PayloadType;
}

/** 'GetNotifications' query type */
export interface IGetNotificationsQuery {
  params: IGetNotificationsParams;
  result: IGetNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    // `@column name!` / `@column name?` in the comment block override the
    // catalog. The hint names the Postgres result column, never the camelCased
    // field, and the suffix never reaches the server.
    test(`Columns with nullability hints (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name CountNotifications
      @column total!
      @column maybe?
    */
    SELECT count(*)::int AS total, 1 AS maybe FROM notifications WHERE id = :userId;
    `;
      const queryStringTS = `
      const countNotifications = sql\`/* @column total! @column maybe? */ SELECT count(*)::int AS total, 1 AS maybe FROM notifications WHERE id = $userId\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'total',
            columnName: 'total',
            type: 'int4',
            // The catalog cannot prove an aggregate is non-null; the hint can.
            nullable: true,
          },
          {
            returnName: 'maybe',
            columnName: 'maybe',
            type: 'int4',
            nullable: false,
          },
        ],
        paramMetadata: {
          params: ['uuid'],
          mapping: [
            {
              name: 'userId',
              type: ParameterTransform.Scalar,
              required: false,
              assignedIndex: 1,
            },
          ],
        },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        partialConfig,
      );
      const expected = `/** 'CountNotifications' parameters type */
export interface ICountNotificationsParams {
  userId?: string | null | void;
}

/** 'CountNotifications' return type */
export interface ICountNotificationsResult {
  maybe: number | null;
  total: number;
}

/** 'CountNotifications' query type */
export interface ICountNotificationsQuery {
  params: ICountNotificationsParams;
  result: ICountNotificationsResult;
}\n\n`;
      expect(result).toEqual(expected);
    });

    // An unhinted column still follows the catalog, so a hint on one column
    // cannot quietly change its neighbours.
    test(`Hints apply only to the column they name (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name CountNotifications
      @column total!
    */
    SELECT count(*)::int AS total, 1 AS other FROM notifications;
    `;
      const queryStringTS = `
      const countNotifications = sql\`/* @column total! */ SELECT count(*)::int AS total, 1 AS other FROM notifications\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'total',
            columnName: 'total',
            type: 'int4',
            nullable: true,
          },
          { returnName: 'other', columnName: 'other', type: 'int4' },
        ],
        paramMetadata: { params: [], mapping: [] },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        partialConfig,
      );
      expect(result).toContain('total: number;');
      expect(result).toContain('other: number | null;');
    });

    // Hints are matched before camelCaseColumnNames runs, so a user writes the
    // Postgres column name and never the generated field name.
    test(`Hints match the pre-camelCase column name (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name CountNotifications
      @column total_count!
    */
    SELECT count(*)::int AS total_count FROM notifications;
    `;
      const queryStringTS = `
      const countNotifications = sql\`/* @column total_count! */ SELECT count(*)::int AS total_count FROM notifications\`;
      `;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [
          {
            returnName: 'total_count',
            columnName: 'total_count',
            type: 'int4',
            nullable: true,
          },
        ],
        paramMetadata: { params: [], mapping: [] },
      };
      const typeSource = async (_: any) => mockTypes;
      const types = new TypeAllocator(TypeMapping());
      const result = await queryToTypeDeclarations(
        parsedQuery(mode, queryString),
        typeSource,
        types,
        { camelCaseColumnNames: true, hungarianNotation: true } as ParsedConfig,
      );
      expect(result).toContain('totalCount: number;');
    });
  });
});

test('comment escaping', () => {
  expect(escapeComment('simple comment')).toEqual('simple comment');
  expect(escapeComment('nested /* comment */')).toEqual(
    'nested /* comment *\\/',
  );
  expect(escapeComment('nested /* nested /* comment */ */')).toEqual(
    'nested /* nested /* comment *\\/ *\\/',
  );
});

test('interface generation with escaped keys', () => {
  const expected = `export interface ExplainResult {
  "QUERY PLAN": string;
}

`;
  const fields = [
    {
      fieldName: 'QUERY PLAN',
      fieldType: 'string',
    },
  ];
  const result = generateInterface('ExplainResult', fields);
  expect(result).toEqual(expected);
});

test('interface generation', () => {
  const expected = `export interface User {
  age: number;
  name: string;
}

`;
  const fields = [
    {
      fieldName: 'name',
      fieldType: 'string',
    },
    {
      fieldName: 'age',
      fieldType: 'number',
    },
  ];
  const result = generateInterface('User', fields);
  expect(result).toEqual(expected);
});

test(`Fail on anonymous column return type`, async () => {
  const queryString = `
    /* @name GetNotifications */
    SELECT COUNT(*) FROM notifications;
    `;
  const mockTypes: IQueryTypes = {
    returnTypes: [
      {
        returnName: '?column?',
        columnName: '?column?',
        type: 'integer',
      },
    ],
    paramMetadata: {
      params: [],
      mapping: [],
    },
  };
  const typeSource = async (_: any) => mockTypes;
  const types = new TypeAllocator(TypeMapping());
  // Test out imports
  types.use(
    { name: 'TypedQuery', from: '@pelotech/pgtyped-runtime' },
    TypeScope.Return,
  );
  const result = await queryToTypeDeclarations(
    parsedQuery('sql', queryString),
    typeSource,
    types,
    partialConfig,
  );
  const expected = `/** Query 'GetNotifications' is invalid, so its result is assigned type 'never'.
 * Query contains an anonymous column. Consider giving the column an explicit name. */
export type IGetNotificationsResult = never;

/** Query 'GetNotifications' is invalid, so its parameters are assigned type 'never'.
 * Query contains an anonymous column. Consider giving the column an explicit name. */
export type IGetNotificationsParams = never;

`;
  expect(result).toEqual(expected);
});

describe('generateDeclarations', () => {
  test('emits a TypedQuery constructed from the serialised IR', () => {
    const ir = parseSqlFile(`
      /*
        @name FindBookById
        @column title!
      */
      SELECT title FROM books WHERE id = :id!;
    `).queries[0];
    const result = generateDeclarations([
      {
        mode: 'sql',
        fileName: 'books.sql',
        query: {
          name: 'findBookById',
          ir: { ...ir, name: 'FindBookById_abc12345' },
          paramTypeAlias: 'IFindBookByIdParams',
          returnTypeAlias: 'IFindBookByIdResult',
        },
        typeDeclaration: '/* types */\n',
      },
    ]);

    expect(result).toEqual(
      `/* types */
const findBookByIdIR: any = {"queryName":"FindBookById","statement":"SELECT title FROM books WHERE id = :id!","params":[{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":35,"b":39}]}],"columns":[{"name":"title","nullable":false}],"name":"FindBookById_abc12345"};

/**
 * Query generated from SQL:
 * \`\`\`
 * SELECT title FROM books WHERE id = :id!
 * \`\`\`
 */
export const findBookById = new TypedQuery<IFindBookByIdParams,IFindBookByIdResult>(findBookByIdIR);


`,
    );
  });

  // A block comment in the SQL reaches the doc comment verbatim, where an
  // unescaped `*/` would close it early and break the whole generated file.
  test('escapes a block comment terminator in the doc comment', () => {
    const ir = parseSqlFile(`
      /*
        @name UpdateBooks
      */
      UPDATE books
      /* ignored comment */
      SET name = :name;
    `).queries[0];
    const result = generateDeclarations([
      {
        mode: 'sql',
        fileName: 'books.sql',
        query: {
          name: 'updateBooks',
          ir,
          paramTypeAlias: 'UpdateBooksParams',
          returnTypeAlias: 'UpdateBooksResult',
        },
        typeDeclaration: '',
      },
    ]);

    expect(result).toContain('ignored comment *\\/');
    expect(result).not.toMatch(/^ \* .*\*\/$/m);
  });

  // A tagged query builds its own TypedQuery at runtime, so codegen emits its
  // types and nothing else.
  test('emits only the type declaration for a tagged query', () => {
    expect(
      generateDeclarations([
        {
          mode: 'ts',
          fileName: 'books.ts',
          query: { name: 'findBookById', queryTypeAlias: 'IFindBookByIdQuery' },
          typeDeclaration: '/* types */\n',
        },
      ]),
    ).toEqual('/* types */\n');
  });
});

// `sql.prepared('X')` carries its own statement name, which the runtime sends
// to Postgres. Codegen follows that name rather than the variable, exactly as
// it follows `@name` in a `.sql` file.
describe('a sql.prepared tag with an explicit name', () => {
  const namedTag = `const users = sql.prepared<GetUsersQuery>('GetUsers')\`SELECT id FROM users WHERE id = $id\`;`;

  test('names the generated types after the statement, not the variable', async () => {
    const mockTypes: IQueryTypes = {
      returnTypes: [
        {
          returnName: 'id',
          columnName: 'id',
          type: 'uuid',
          nullable: false,
        },
      ],
      paramMetadata: {
        params: ['uuid'],
        mapping: [
          {
            name: 'id',
            type: ParameterTransform.Scalar,
            assignedIndex: 1,
            required: false,
          },
        ],
      },
    };

    const result = await queryToTypeDeclarations(
      parsedQuery('ts', namedTag),
      async () => mockTypes,
      new TypeAllocator(TypeMapping()),
      { hungarianNotation: false } as ParsedConfig,
    );

    expect(result).toContain('export interface GetUsersParams');
    expect(result).toContain('export interface GetUsersResult');
    expect(result).toContain('export interface GetUsersQuery');
    expect(result).not.toContain('interface UsersParams');
  });

  test('warns when the variable disagrees with the statement name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generateTypedecsFromFile(
        `const users = sql.prepared<GetUsersQuery>('GetUsers')\`SELECT 1 AS n\`;`,
        'queries.ts',
        emptyDb,
        { mode: 'ts', include: '*.ts' },
        new TypeAllocator(TypeMapping()),
        { hungarianNotation: false, failOnError: false } as ParsedConfig,
      );

      // Advisory only: the types are still generated, under the name.
      expect(result.typedQueries).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('`users`');
      expect(warn.mock.calls[0][0]).toContain('`getUsers`');
    } finally {
      warn.mockRestore();
    }
  });

  test('fails the file on a mismatch under failOnError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        generateTypedecsFromFile(
          `const users = sql.prepared<GetUsersQuery>('GetUsers')\`SELECT 1 AS n\`;`,
          'queries.ts',
          emptyDb,
          { mode: 'ts', include: '*.ts' },
          new TypeAllocator(TypeMapping()),
          { hungarianNotation: false, failOnError: true } as ParsedConfig,
        ),
      ).rejects.toThrow('expected `getUsers`');
    } finally {
      warn.mockRestore();
    }
  });

  test('reports an unreadable name as an error and generates nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await generateTypedecsFromFile(
        `const users = sql.prepared<GetUsersQuery>(name)\`SELECT 1 AS n\`;`,
        'queries.ts',
        emptyDb,
        { mode: 'ts', include: '*.ts' },
        new TypeAllocator(TypeMapping()),
        { hungarianNotation: false, failOnError: false } as ParsedConfig,
      );

      expect(result.typedQueries).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('string literal');
    } finally {
      error.mockRestore();
    }
  });

  test('an empty name is unreadable too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await generateTypedecsFromFile(
        `const users = sql.prepared<UsersQuery>('')\`SELECT 1 AS n\`;`,
        'queries.ts',
        emptyDb,
        { mode: 'ts', include: '*.ts' },
        new TypeAllocator(TypeMapping()),
        { hungarianNotation: false, failOnError: false } as ParsedConfig,
      );

      expect(result.typedQueries).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('string literal');
    } finally {
      error.mockRestore();
    }
  });
});

// `sql.prepared()` derives its statement name from the SQL text at runtime, so
// codegen has no name to read and falls back to the variable — the same name a
// plain `sql` tag gets, and the same generated types.
describe('a sql.prepared tag with no name', () => {
  test('names the generated types after the variable', async () => {
    const mockTypes: IQueryTypes = {
      returnTypes: [
        { returnName: 'id', columnName: 'id', type: 'uuid', nullable: false },
      ],
      paramMetadata: { params: [], mapping: [] },
    };

    const result = await queryToTypeDeclarations(
      parsedQuery(
        'ts',
        `const getUsers = sql.prepared<GetUsersQuery>()\`SELECT id FROM users\`;`,
      ),
      async () => mockTypes,
      new TypeAllocator(TypeMapping()),
      { hungarianNotation: false } as ParsedConfig,
    );

    expect(result).toContain('export type GetUsersParams');
    expect(result).toContain('export interface GetUsersResult');
    expect(result).toContain('export interface GetUsersQuery');
  });

  test('generates without warning or error, unlike the unreadable name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await generateTypedecsFromFile(
        `const getUsers = sql.prepared<GetUsersQuery>()\`SELECT 1 AS n\`;`,
        'queries.ts',
        emptyDb,
        { mode: 'ts', include: '*.ts' },
        new TypeAllocator(TypeMapping()),
        { hungarianNotation: false, failOnError: true } as ParsedConfig,
      );

      expect(result.typedQueries).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
