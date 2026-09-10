import { getTypes, reduceTypeRows } from './types.js';
import type { TypeDb } from './type-db.js';
import type { DescribedField } from './describe.js';

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

/**
 * Domains, issues #503 and #594.
 *
 * Postgres reports a domain-typed result column as its *base* type in
 * RowDescription — the domain's own OID never reaches the client that way — so
 * a `typesOverrides` entry naming the domain silently never fired. The domain
 * is recovered from `pg_attribute.atttypid`, which the same query already
 * reads for `attnotnull`.
 */
describe('domain types', () => {
  const text = { oid: 25, typname: 'text', typtype: 'b', typcategory: 'S' };
  const varchar = {
    oid: 1043,
    typname: 'varchar',
    typtype: 'b',
    typcategory: 'S',
  };
  const int4 = { oid: 23, typname: 'int4', typtype: 'b', typcategory: 'N' };
  const email = {
    oid: 16385,
    typname: 'email',
    typtype: 'd',
    typbasetype: 25,
    typcategory: 'S',
  };
  const email2 = {
    oid: 16402,
    typname: 'email2',
    typtype: 'd',
    typbasetype: 16385,
    typcategory: 'S',
  };

  type CatalogRow = Record<string, unknown> & { oid: number };

  const field = (over: Partial<DescribedField> = {}): DescribedField => ({
    name: 'contact',
    tableOID: 100,
    columnAttrNumber: 2,
    typeOID: 25,
    typeSize: -1,
    typeModifier: -1,
    formatCode: 0,
    ...over,
  });

  /**
   * A fake server that answers the catalog queries the way the real one does,
   * including the `IN (…)` filter — so a base type that was not asked for is
   * not returned, and the extra round trip that fetches it is observable.
   */
  const fakeDb = (opts: {
    fields?: DescribedField[];
    params?: { oid: number }[];
    types: CatalogRow[];
    attributes?: Record<string, unknown>[];
  }) => {
    const typeQueries: number[][] = [];
    const db: TypeDb = {
      describe: async () => ({
        params: opts.params ?? [],
        fields: opts.fields ?? [],
      }),
      rows: async (sql) => {
        if (sql.includes('FROM pg_type')) {
          const requested = [...sql.matchAll(/pt\.oid IN \(([^)]*)\)/g)][0][1]
            .split(',')
            .map(Number);
          typeQueries.push(requested);
          const elements = opts.types
            .filter((t) => requested.includes(t.oid))
            .map((t) => t.typelem as number)
            .filter(Boolean);
          return opts.types
            .filter(
              (t) => requested.includes(t.oid) || elements.includes(t.oid),
            )
            .map((t) => ({
              enumlabel: null,
              typelem: 0,
              typbasetype: 0,
              ...t,
            }));
        }
        if (sql.includes('FROM pg_description')) return [];
        if (sql.includes('FROM pg_attribute')) return opts.attributes ?? [];
        throw new Error(`unexpected catalog query: ${sql}`);
      },
    };
    return { db, typeQueries };
  };

  const attribute = (over: Record<string, unknown> = {}) => ({
    attid: '100:2',
    attname: 'contact',
    attnotnull: true,
    atttypid: 16385,
    ...over,
  });

  const run = (db: TypeDb) =>
    getTypes({ query: 'SELECT contact FROM t', mapping: [], bindings: [] }, db);

  test('a result column is typed by its domain, not by the base type reported', async () => {
    const { db } = fakeDb({
      fields: [field()],
      types: [text, email],
      attributes: [attribute()],
    });
    const result = await run(db);
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.returnTypes).toStrictEqual([
      {
        returnName: 'contact',
        columnName: 'contact',
        nullable: false,
        type: { name: 'email', baseType: 'text' },
      },
    ]);
  });

  test('an aliased column is still the column it came from', async () => {
    const { db } = fakeDb({
      fields: [field({ name: 'c1' })],
      types: [text, email],
      attributes: [attribute()],
    });
    const result = await run(db);
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.returnTypes[0].type).toStrictEqual({
      name: 'email',
      baseType: 'text',
    });
  });

  test('a domain over a domain carries the whole chain', async () => {
    const { db } = fakeDb({
      fields: [field()],
      types: [text, email, email2],
      attributes: [attribute({ atttypid: 16402 })],
    });
    const result = await run(db);
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.returnTypes[0].type).toStrictEqual({
      name: 'email2',
      baseType: { name: 'email', baseType: 'text' },
    });
  });

  /**
   * `SELECT contact::text` reports no source column at all — tableOID and
   * columnAttrNumber are both 0 — so a cast cannot be mistaken for the column
   * it was applied to.
   */
  test('an expression has no source column, so nothing is remapped', async () => {
    const { db } = fakeDb({
      fields: [field({ tableOID: 0, columnAttrNumber: 0 })],
      types: [text, email],
      attributes: [],
    });
    const result = await run(db);
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.returnTypes[0].type).toEqual('text');
  });

  /**
   * The second check on the remap: the domain's base type has to be the type
   * the server reported. If it is not, this field is not the column it appears
   * to name and the reported type stands.
   */
  test('a column whose base type disagrees with the reported type is left alone', async () => {
    const { db } = fakeDb({
      fields: [field({ typeOID: 1043 })],
      types: [text, varchar, email],
      attributes: [attribute()],
    });
    const result = await run(db);
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.returnTypes[0].type).toEqual('varchar');
  });

  test('a non-domain column is not remapped, and costs no extra query', async () => {
    const { db, typeQueries } = fakeDb({
      fields: [field({ name: 'id', columnAttrNumber: 1, typeOID: 23 })],
      types: [int4],
      attributes: [attribute({ attid: '100:1', attname: 'id', atttypid: 23 })],
    });
    const result = await run(db);
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.returnTypes[0].type).toEqual('int4');
    expect(typeQueries).toHaveLength(1);
  });

  /**
   * A domain-typed *parameter* is the one direction Postgres does report the
   * domain for (an `INSERT … VALUES ($1)` into a domain column), and it used to
   * fail the mapping outright: `Postgres type 'email' is not supported by
   * mapping`, and `unknown`. Its base type is not among the OIDs the describe
   * reports, so it takes the one extra round trip this asserts.
   */
  test('a domain parameter resolves, at the cost of one more catalog query', async () => {
    const { db, typeQueries } = fakeDb({
      params: [{ oid: 16385 }],
      types: [text, email],
    });
    const result = await getTypes(
      {
        query: 'INSERT INTO t (contact) VALUES ($1)',
        mapping: [],
        bindings: [],
      },
      db,
    );
    if ('errorCode' in result) throw new Error('unexpected parse error');
    expect(result.paramMetadata.params).toStrictEqual([
      { name: 'email', baseType: 'text' },
    ]);
    expect(typeQueries).toStrictEqual([[16385], [25]]);
  });
});

describe('reduceTypeRows resolves domains', () => {
  test('a domain over an enum keeps the enum', () => {
    expect(
      reduceTypeRows([
        {
          oid: 16391,
          typeName: 'mood',
          typeKind: 'e',
          enumLabel: 'sad',
        },
        {
          oid: 16391,
          typeName: 'mood',
          typeKind: 'e',
          enumLabel: 'happy',
        },
        {
          oid: 16398,
          typeName: 'mood_d',
          typeKind: 'd',
          enumLabel: '',
          baseTypeOid: 16391,
        },
      ]),
    ).toStrictEqual({
      16391: { name: 'mood', enumValues: ['sad', 'happy'] },
      16398: {
        name: 'mood_d',
        baseType: { name: 'mood', enumValues: ['sad', 'happy'] },
      },
    });
  });

  /**
   * Only reachable if the catalog answered with less than it was asked for.
   * The bare name is what this produced before domains were resolved at all:
   * an override still applies to it, and without one it is reported as an
   * unmapped type rather than resolved to something invented here.
   */
  test('a domain whose base type is missing stays a bare name', () => {
    expect(
      reduceTypeRows([
        {
          oid: 16385,
          typeName: 'email',
          typeKind: 'd',
          enumLabel: '',
          baseTypeOid: 25,
        },
      ]),
    ).toStrictEqual({ 16385: 'email' });
  });
});
