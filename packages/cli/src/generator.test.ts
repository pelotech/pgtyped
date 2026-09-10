import { format } from 'node:util';
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
  explain: async () => undefined,
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
        'src/queries.sql',
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
        'src/queries.sql',
        typeSource,
        types,
        partialConfig,
      );
      const expected = `/** 'InsertNotifications' parameters type */
export interface IInsertNotificationsParams {
  notification: {
    payload?: Json | null | void,
    user_id?: string | null | void,
    type?: string | null | void
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

    /**
     * A pick key that was not marked `!` got no `?`, so the only way to omit
     * one was to spell out `key: undefined` — while the scalar branch three
     * lines above had been marking non-required params optional since 3.0.
     * `render` reads the key off the object and binds whatever it finds, so an
     * absent key and an explicit `undefined` both reach the server as NULL.
     * Upstream #573.
     */
    test(`Optional pick keys are optional, required ones are not (${mode})`, async () => {
      const queryStringSQL = `
    /*
      @name Get573
      @param address -> (line1!, line2, city!)
    */
    INSERT INTO postal_codes (line1, line2, city) VALUES :address RETURNING code;
    `;
      const queryStringTS = `const get573 = sql\`INSERT INTO postal_codes (line1, line2, city) VALUES $address(line1, line2, city) RETURNING code\`;`;
      const queryString = mode === 'sql' ? queryStringSQL : queryStringTS;
      const mockTypes: IQueryTypes = {
        returnTypes: [],
        paramMetadata: {
          params: ['text', 'text', 'text'],
          mapping: [
            {
              name: 'address',
              type: ParameterTransform.Pick,
              dict: {
                line1: {
                  name: 'line1',
                  assignedIndex: 1,
                  required: true,
                  type: ParameterTransform.Scalar,
                },
                line2: {
                  name: 'line2',
                  assignedIndex: 2,
                  required: false,
                  type: ParameterTransform.Scalar,
                },
                city: {
                  name: 'city',
                  assignedIndex: 3,
                  required: true,
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
        'src/queries.sql',
        typeSource,
        types,
        {} as ParsedConfig,
      );

      expect(result).toContain(`  address: {
    line1: string,
    line2?: string | null | void,
    city: string
  };`);
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
        'src/queries.sql',
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
        'src/queries.sql',
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
        'src/queries.sql',
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
        'src/queries.sql',
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
        'src/queries.sql',
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
        'src/queries.sql',
        typeSource,
        types,
        { nonEmptyArrayParams: true, hungarianNotation: true } as ParsedConfig,
      );
      const expected = `/** 'InsertNotifications' parameters type */
export interface IInsertNotificationsParams {
  notification: readonly [{
    payload?: Json | null | void,
    user_id?: string | null | void,
    type?: string | null | void
  }, ...({
    payload?: Json | null | void,
    user_id?: string | null | void,
    type?: string | null | void
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
        'src/queries.sql',
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
        'src/queries.sql',
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
        'src/queries.sql',
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
        'src/queries.sql',
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
    'src/queries.sql',
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

/**
 * With the default failOnError: false, this console.error is the only signal a
 * broken query produces — the file is still written, with `never` types. Files
 * are processed at MAX_CONCURRENCY, so the interleaved `Processing …` lines
 * cannot attribute it either. Upstream #526, #584.
 */
test('a query the server rejects is reported with its file and query name', async () => {
  const queryString = `
    /* @name BadQueryTwo */
    SELECT * FROM no_such_table;
    `;
  const typeSource = async (_: any) => ({
    errorCode: '42P01',
    message: 'relation "no_such_table" does not exist',
    position: '15',
  });
  const types = new TypeAllocator(TypeMapping());
  // Rendered through util.format, so the assertions are against what a user
  // actually reads rather than against the format string.
  const errors: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: [unknown]) => {
      errors.push(format(...args));
    });

  try {
    await queryToTypeDeclarations(
      parsedQuery('sql', queryString),
      'src/deep/nested/a.sql',
      typeSource as any,
      types,
      partialConfig,
    );
  } finally {
    spy.mockRestore();
  }

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('BadQueryTwo');
  expect(errors[0]).toContain('src/deep/nested/a.sql');
  expect(errors[0]).toContain('no_such_table');
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
      'src/queries.sql',
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
      'src/queries.sql',
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

// The type argument names the interface codegen generates for the query, so a
// mismatch means the tag is typed as some other query.
describe('the type argument lint', () => {
  const generate = (contents: string, failOnError = false) =>
    generateTypedecsFromFile(
      contents,
      'queries.ts',
      emptyDb,
      { mode: 'ts', include: '*.ts' },
      new TypeAllocator(TypeMapping()),
      { hungarianNotation: false, failOnError } as ParsedConfig,
    );

  test('warns on a stale type argument, and still generates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generate(
        `const getUsers = sql<FindBooksQuery>\`SELECT 1 AS n\`;`,
      );

      expect(result.typedQueries).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('`FindBooksQuery`');
      expect(warn.mock.calls[0][0]).toContain('`GetUsersQuery`');
    } finally {
      warn.mockRestore();
    }
  });

  test('says nothing about an inline params/result pair', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generate(
        `const getUsers = sql<{ params: void; result: { n: number } }>\`SELECT 1 AS n\`;`,
      );

      expect(result.typedQueries).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('failOnError promotes it to a failed run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        generate(
          `const getUsers = sql<FindBooksQuery>\`SELECT 1 AS n\`;`,
          true,
        ),
      ).rejects.toThrow('expected `GetUsersQuery`');
    } finally {
      warn.mockRestore();
    }
  });
});

// In 2.x, `AS "total!"` was how nullability was declared, and the runtime
// stripped the suffix off every row key. 3.0 reads hints from `@column` and
// strips nothing, so such an alias now names a column that really is `total!`.
describe('the nullability-suffix alias lint', () => {
  /**
   * A database that reports one `int4` result column under `name`, so a test
   * can drive the whole pipeline over a column Postgres really did call
   * `total!`. The column belongs to no table, so it has no `pg_attribute` row
   * and comes back with unknown nullability.
   */
  const dbReturning = (name: string): TypeDb => ({
    describe: async () => ({
      params: [],
      fields: [
        {
          name,
          tableOID: 0,
          columnAttrNumber: 0,
          typeOID: 23,
          typeSize: 4,
          typeModifier: -1,
          formatCode: 0,
        },
      ],
    }),
    rows: async (sql) =>
      sql.includes('FROM pg_type')
        ? [
            {
              oid: 23,
              typname: 'int4',
              typtype: 'b',
              enumlabel: null,
              typelem: 0,
              typcategory: 'N',
            },
          ]
        : [],
    explain: async () => undefined,
  });

  const sqlFile = (alias: string) => `
    /* @name CountBooks */
    SELECT count(*)::int AS "${alias}" FROM books;
  `;
  const sqlTag = (alias: string) =>
    `const countBooks = sql\`SELECT count(*)::int AS "${alias}" FROM books\`;`;

  const generate = (mode: Mode, alias: string, failOnError = false) =>
    generateTypedecsFromFile(
      mode === 'sql' ? sqlFile(alias) : sqlTag(alias),
      mode === 'sql' ? 'queries.sql' : 'queries.ts',
      // The alias reaches the server verbatim, so the server names the column
      // after it.
      dbReturning(alias),
      mode === 'sql'
        ? { mode: 'sql', include: '*.sql' }
        : { mode: 'ts', include: '*.ts' },
      new TypeAllocator(TypeMapping()),
      { hungarianNotation: false, failOnError } as ParsedConfig,
    );

  // The lint lives in queryToTypeDeclarations, the one point both front ends
  // pass through, so a tag aliasing a column is caught just like a .sql file.
  (['sql', 'ts'] as const).forEach((mode) => {
    test(`warns on a \`!\` suffix, and still generates (${mode})`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await generate(mode, 'total!');

        expect(result.typedQueries).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0];
        expect(message).toContain('"total!"');
        expect(message).toContain('@column total!');
        expect(message).toContain('CountBooks');
      } finally {
        warn.mockRestore();
      }
    });

    test(`says nothing about a plain alias (${mode})`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await generate(mode, 'total');

        expect(result.typedQueries).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  test('covers the `?` suffix too, and suggests the matching hint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await generate('sql', 'maybe?');

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('"maybe?"');
      expect(warn.mock.calls[0][0]).toContain('@column maybe?');
    } finally {
      warn.mockRestore();
    }
  });

  test('failOnError promotes it to a failed run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(generate('sql', 'total!', true)).rejects.toThrow(
        'Column alias "total!"',
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The trap the warning exists to catch: `camelCase('total!')` is `'total'`,
  // so with camelCaseColumnNames on the generated type promises a field the
  // rows do not have, and `row.total` is `undefined` with nothing to show for
  // it. Without camelCasing the field keeps the odd name and at least matches.
  test('camelCasing hides the mismatch: `total!` generates the field `total`', async () => {
    const mockTypes: IQueryTypes = {
      returnTypes: [
        {
          returnName: 'total!',
          columnName: 'total!',
          type: 'int4',
          nullable: false,
        },
      ],
      paramMetadata: { params: [], mapping: [] },
    };
    const typeSource = async (_: any) => mockTypes;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = parsedQuery('sql', sqlFile('total!'));

      const camelCased = await queryToTypeDeclarations(
        ir,
        'src/queries.sql',
        typeSource,
        new TypeAllocator(TypeMapping()),
        { camelCaseColumnNames: true, hungarianNotation: true } as ParsedConfig,
      );
      // Postgres returns the row under `total!`; the type says `total`.
      expect(camelCased).toContain('total: number;');
      expect(camelCased).not.toContain('"total!"');

      const asIs = await queryToTypeDeclarations(
        ir,
        'src/queries.sql',
        typeSource,
        new TypeAllocator(TypeMapping()),
        {
          camelCaseColumnNames: false,
          hungarianNotation: true,
        } as ParsedConfig,
      );
      expect(asIs).toContain('"total!": number;');
    } finally {
      warn.mockRestore();
    }
  });
});

// `failOnError` has to mean one thing whichever kind of file a query lives in,
// so a `.sql` file's warnings are promoted exactly as a `ts` file's are.
describe('failOnError over a sql file warning', () => {
  // A declared-but-unused `@param` is the warning `.sql` files actually emit.
  const unusedParam = `
    /*
      @name GetUsers
      @param ages -> (...)
    */
    SELECT 1 AS n;
  `;

  const generate = (contents: string, failOnError = false) =>
    generateTypedecsFromFile(
      contents,
      'queries.sql',
      emptyDb,
      { mode: 'sql', include: '*.sql' },
      new TypeAllocator(TypeMapping()),
      { hungarianNotation: false, failOnError } as ParsedConfig,
    );

  test('warns and still generates by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generate(unusedParam);

      expect(result.typedQueries).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(
        'Parameter "ages" is defined but never used',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('failOnError promotes it to a failed run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(generate(unusedParam, true)).rejects.toThrow(
        'Parameter "ages" is defined but never used',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('the thrown message keeps the file name and offset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(generate(unusedParam, true)).rejects.toThrow(
        /^queries\.sql: .* \(offset \d+\)$/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('a file with no warnings is unaffected by failOnError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generate(
        `/* @name GetUsers */ SELECT 1 AS n;`,
        true,
      );

      expect(result.typedQueries).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Issue #317. `SELECT ROW(1,2) AS r` logs
 * `Postgres type 'record' is not supported by mapping` and emits
 * `r: unknown | null` — and `failOnError: true` used to exit **0** anyway, so
 * a build that had asked to fail on errors reported success and wrote a type
 * nothing would ever complain about.
 */
describe('a type the mapping does not support', () => {
  const unmapped: IQueryTypes = {
    returnTypes: [
      {
        returnName: 'r',
        columnName: 'r',
        type: 'record',
        nullable: false,
      },
    ],
    paramMetadata: { params: [], mapping: [] },
  };

  const generate = (
    failOnError: boolean,
    types = new TypeAllocator(TypeMapping()),
  ) =>
    queryToTypeDeclarations(
      parsedQuery('sql', '/* @name GetRecord */ SELECT ROW(1,2) AS r;'),
      'src/queries.sql',
      async () => unmapped,
      types,
      { hungarianNotation: false, failOnError } as ParsedConfig,
    );

  /**
   * Deliberately `unknown` rather than the `never` the old comment claimed:
   * `never` is assignable to *every* type, so `const total: number = row.r`
   * would compile silently, where `unknown` forces the caller to narrow it.
   */
  test('generates unknown, and says so, by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await generate(false);

      expect(result).toContain('r: unknown');
      expect(log).toHaveBeenCalledTimes(1);
      expect(format(log.mock.calls[0][0])).toContain(
        "Postgres type 'record' is not supported by mapping",
      );
    } finally {
      log.mockRestore();
    }
  });

  test('fails the run under failOnError', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(generate(true)).rejects.toThrow(
        /Query "GetRecord" in src\/queries\.sql uses types the mapping does not support/,
      );
      await expect(generate(true)).rejects.toThrow(
        /Postgres type 'record' is not supported by mapping/,
      );
    } finally {
      log.mockRestore();
    }
  });

  /**
   * The allocator is shared by every query in a file and accumulates errors,
   * so reporting the whole array printed each one again for every query that
   * followed it.
   */
  test('reports each error once, not once per query after it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const types = new TypeAllocator(TypeMapping());
      await generate(false, types);
      await generate(false, types);

      expect(types.errors).toHaveLength(2);
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  test('a later query is not failed by an earlier query`s error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const types = new TypeAllocator(TypeMapping());
      await expect(generate(true, types)).rejects.toThrow();

      // Same allocator, still carrying the first error: a query of its own
      // that maps cleanly still generates.
      const result = await queryToTypeDeclarations(
        parsedQuery('sql', '/* @name GetOne */ SELECT 1 AS n;'),
        'src/queries.sql',
        async () => ({
          returnTypes: [
            { returnName: 'n', columnName: 'n', type: 'int4', nullable: false },
          ],
          paramMetadata: { params: [], mapping: [] },
        }),
        types,
        { hungarianNotation: false, failOnError: true } as ParsedConfig,
      );
      expect(result).toContain('n: number');
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * Two result columns landing on the same generated field emitted an interface
 * declaring the same key twice — `id: number; id: number;` — which is TS2300,
 * with codegen exiting 0 and the failure surfacing as a compile error in a
 * file the user did not write. Pre-existing, not a 3.0 regression: 2.x had no
 * dedup either.
 */
describe('duplicate keys in a generated interface', () => {
  const describing = (names: string[]) => async () => ({
    returnTypes: names.map((returnName) => ({
      returnName,
      columnName: returnName,
      type: 'int4' as const,
      nullable: false,
    })),
    paramMetadata: { params: [], mapping: [] },
  });

  const generate = (
    queryString: string,
    columns: string[],
    config: Partial<ParsedConfig> = {},
  ) =>
    queryToTypeDeclarations(
      parsedQuery('sql', queryString),
      'src/queries.sql',
      describing(columns) as any,
      new TypeAllocator(TypeMapping()),
      { hungarianNotation: false, ...config } as ParsedConfig,
    );

  const collect = async (run: () => Promise<string>) => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: [unknown]) => {
        errors.push(format(...args));
      });
    try {
      return { result: await run(), errors };
    } finally {
      spy.mockRestore();
    }
  };

  // The collision the user cannot see in their SQL, because in their SQL the
  // two columns have different names.
  test('camelCaseColumnNames collapsing two columns names both of them', async () => {
    const { result, errors } = await collect(() =>
      generate(
        '/* @name Dup */ SELECT "userName", user_name FROM mixed;',
        ['userName', 'user_name'],
        { camelCaseColumnNames: true },
      ),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      `Query 'Dup' has 2 result columns that camelCaseColumnNames collapses onto the field ` +
        `"userName": "userName", "user_name". A TypeScript interface cannot declare the same key ` +
        `twice, so no result type can be generated for it. Alias one of them to a name that does ` +
        `not collide, or turn camelCaseColumnNames off.`,
    );
    expect(result).toContain('export type DupResult = never;');
    expect(result).not.toContain('userName: number;');
  });

  // Two columns genuinely named the same thing, which is also the case a
  // `@column id!` hint cannot disambiguate: it matches by name, so it applies
  // to both.
  test('two columns of the same name are reported without blaming camelCase', async () => {
    const { result, errors } = await collect(() =>
      generate(
        `/*
           @name DupHint
           @column id!
         */
         SELECT a.id, b."aId" AS id FROM "A" a LEFT JOIN "B" b ON a.id = b."aId";`,
        ['id', 'id'],
      ),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      `Query 'DupHint' has 2 result columns named "id". A TypeScript interface cannot declare ` +
        `the same key twice, so no result type can be generated for it. Alias one of them to a ` +
        `different name.`,
    );
    expect(errors[0]).not.toContain('camelCase');
    expect(result).toContain('export type DupHintResult = never;');
  });

  test('failOnError promotes it to a failed run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        generate('/* @name DupHint */ SELECT 1 AS id, 2 AS id;', ['id', 'id'], {
          failOnError: true,
        }),
      ).rejects.toThrow(`Query 'DupHint' has 2 result columns named "id"`);
    } finally {
      error.mockRestore();
    }
  });

  // The guard has to stay quiet for the columns that merely look alike.
  test('columns that camelCase to distinct fields still generate', async () => {
    const { result, errors } = await collect(() =>
      generate(
        '/* @name Fine */ SELECT user_name, user_id FROM mixed;',
        ['user_name', 'user_id'],
        { camelCaseColumnNames: true },
      ),
    );

    expect(errors).toEqual([]);
    expect(result).toContain('userName: number;');
    expect(result).toContain('userId: number;');
  });
});

/**
 * Postgres checks table and column privileges at execute time, so a query the
 * connecting role may not run is described perfectly well and generated
 * cleanly. `checkPrivileges` plans it too; this is what the generator does
 * with the answer.
 */
describe('the pre-flight privilege check', () => {
  const denied = 'permission denied for table secrets';

  /**
   * A database that describes one nullable int4 column and refuses to plan the
   * statement, which is what a missing GRANT looks like from here.
   */
  const deniedDb: TypeDb = {
    describe: async () => ({
      params: [],
      fields: [
        {
          name: 'id',
          tableOID: 0,
          columnAttrNumber: 0,
          typeOID: 23,
          typeSize: 4,
          typeModifier: -1,
          formatCode: 0,
        },
      ],
    }),
    rows: async (sql) =>
      sql.includes('FROM pg_type')
        ? [
            {
              oid: 23,
              typname: 'int4',
              typtype: 'b',
              enumlabel: null,
              typelem: 0,
              typcategory: 'N',
              typbasetype: 0,
            },
          ]
        : [],
    explain: async () => {
      throw Object.assign(new Error(denied), { code: '42501' });
    },
  };

  const generate = (config: Partial<ParsedConfig>) =>
    generateTypedecsFromFile(
      '/* @name GetSecrets */\nSELECT id FROM secrets;\n',
      'secrets.sql',
      deniedDb,
      { mode: 'sql', include: '*.sql' },
      new TypeAllocator(TypeMapping()),
      {
        hungarianNotation: false,
        failOnError: false,
        ...config,
      } as ParsedConfig,
    );

  test('says nothing unless the config asks for it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generate({ checkPrivileges: false });

      expect(warn).not.toHaveBeenCalled();
      expect(result.typedQueries[0].typeDeclaration).toContain('id: number');
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Advisory, and the declarations are the real ones: the query is valid SQL
   * and its types are an accurate description of it, so emitting `never` — as
   * an unparseable query does — would break every call site over something
   * only a GRANT can fix.
   */
  test('warns, names the query and the file, and still generates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generate({ checkPrivileges: true });

      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0];
      expect(message).toContain('GetSecrets');
      expect(message).toContain('secrets.sql');
      expect(message).toContain(denied);
      expect(message).toContain('42501');
      expect(result.typedQueries[0].typeDeclaration).toContain('id: number');
      expect(result.typedQueries[0].typeDeclaration).not.toContain('never');
    } finally {
      warn.mockRestore();
    }
  });

  test('failOnError promotes it to a failed run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        generate({ checkPrivileges: true, failOnError: true }),
      ).rejects.toThrow(denied);
    } finally {
      warn.mockRestore();
    }
  });
});
