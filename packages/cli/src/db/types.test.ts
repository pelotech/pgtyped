import { getTypes, reduceTypeRows } from './types.js';
import type { TypeDb } from './type-db.js';

test('reduce type rows to MappableTypes', () => {
  expect(
    reduceTypeRows([
      {
        oid: 25,
        typeName: 'text',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 23,
        typeName: 'int4',
        typeKind: 'b',
        enumLabel: '',
      },
    ]),
  ).toMatchSnapshot();

  expect(
    reduceTypeRows([
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'notification',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'reminder',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'deadline',
      },
      {
        oid: 23,
        typeName: 'int4',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 3802,
        typeName: 'jsonb',
        typeKind: 'b',
        enumLabel: '',
      },
    ]),
  ).toMatchSnapshot();

  expect(
    reduceTypeRows([
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'notification',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'reminder',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'deadline',
      },
      {
        oid: 23,
        typeName: 'int4',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 3802,
        typeName: 'jsonb',
        typeKind: 'b',
        enumLabel: '',
      },
    ]),
  ).toMatchSnapshot();

  expect(
    reduceTypeRows([
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'notification',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'reminder',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'deadline',
      },
      {
        oid: 25,
        typeName: 'text',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 23,
        typeName: 'int4',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 3802,
        typeName: 'jsonb',
        typeKind: 'b',
        enumLabel: '',
      },
    ]),
  ).toMatchSnapshot();

  expect(
    reduceTypeRows([
      {
        oid: 20,
        typeName: 'int8',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 25,
        typeName: 'text',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 1082,
        typeName: 'date',
        typeKind: 'b',
        enumLabel: '',
      },
      {
        oid: 23,
        typeName: 'int4',
        typeKind: 'b',
        enumLabel: '',
      },
    ]),
  ).toMatchSnapshot();

  expect(
    reduceTypeRows([
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'notification',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'reminder',
      },
      {
        oid: 16398,
        typeName: 'notification_type',
        typeKind: 'e',
        enumLabel: 'deadline',
      },
      {
        oid: 24,
        typeName: '_enum',
        typeKind: 'b',
        enumLabel: '',
        typeCategory: 'A' as any,
        elementTypeOid: 16398,
      },
    ]),
  ).toMatchSnapshot();
});

test('getTypes reads pg-parsed catalog rows: boolean attnotnull, numeric oids', async () => {
  const db: TypeDb = {
    describe: async () => ({
      params: [],
      fields: [
        {
          name: 'id',
          tableOID: 100,
          columnAttrNumber: 1,
          typeOID: 23,
          typeSize: 4,
          typeModifier: -1,
          formatCode: 0,
        },
      ],
    }),
    rows: async (sql) => {
      if (sql.includes('FROM pg_type'))
        return [
          {
            oid: 23,
            typname: 'int4',
            typtype: 'b',
            enumlabel: null,
            typelem: 0,
            typcategory: 'N',
          },
        ];
      if (sql.includes('FROM pg_description')) return [];
      if (sql.includes('FROM pg_attribute'))
        return [{ attid: '100:1', attname: 'id', attnotnull: true }];
      throw new Error(`unexpected catalog query: ${sql}`);
    },
  };
  const result = await getTypes(
    { query: 'SELECT id FROM t', mapping: [], bindings: [] },
    db,
  );
  expect('errorCode' in result).toBe(false);
  if ('errorCode' in result) return;
  // No `comment` key at all: the row builder spreads `{ comment }` only when one
  // exists, and toStrictEqual distinguishes absent from undefined.
  expect(result.returnTypes).toStrictEqual([
    { returnName: 'id', columnName: 'id', type: 'int4', nullable: false },
  ]);
});
