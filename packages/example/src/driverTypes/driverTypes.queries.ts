/** Types generated for queries found in "src/driverTypes/driverTypes.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

import type { DateOrString, EmailAddress, NumberOrString, NumberOrStringArray, PgInterval, PgPoint, nullableNumberArray } from '../pgtyped-shared.js';

/** 'GetDriverTypes' parameters type */
export type GetDriverTypesParams = void;

/** 'GetDriverTypes' return type */
export interface GetDriverTypesResult {
  amount: string;
  amounts: nullableNumberArray;
  contact: EmailAddress;
  duration: PgInterval;
  flags: string;
  id: number;
  location: PgPoint;
  period: string;
  recorded_at: Date;
  start_time: string;
  start_time_tz: string;
}

/** 'GetDriverTypes' query type */
export interface GetDriverTypesQuery {
  params: GetDriverTypesParams;
  result: GetDriverTypesResult;
}

const getDriverTypesIR: any = {"queryName":"GetDriverTypes","statement":"SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at, contact\nFROM driver_types","params":[],"columns":[],"name":"GetDriverTypes_294fb4b2"};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at, contact
 * FROM driver_types
 * ```
 */
export const getDriverTypes = new TypedQuery<GetDriverTypesParams,GetDriverTypesResult>(getDriverTypesIR);


/** 'InsertDriverTypes' parameters type */
export interface InsertDriverTypesParams {
  amount: NumberOrString;
  amounts: NumberOrStringArray;
  contact: EmailAddress;
  duration: string;
  flags: string;
  location: string;
  period: string;
  recordedAt: DateOrString;
  startTime: string;
  startTimeTz: string;
}

/** 'InsertDriverTypes' return type */
export interface InsertDriverTypesResult {
  id: number;
}

/** 'InsertDriverTypes' query type */
export interface InsertDriverTypesQuery {
  params: InsertDriverTypesParams;
  result: InsertDriverTypesResult;
}

const insertDriverTypesIR: any = {"queryName":"InsertDriverTypes","statement":"INSERT INTO driver_types\n  (duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at, contact)\nVALUES\n  (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :period!, :recordedAt!, :contact!)\nRETURNING id","params":[{"name":"duration","transform":{"type":"scalar"},"required":true,"locs":[{"a":139,"b":149}]},{"name":"startTime","transform":{"type":"scalar"},"required":true,"locs":[{"a":151,"b":162}]},{"name":"startTimeTz","transform":{"type":"scalar"},"required":true,"locs":[{"a":164,"b":177}]},{"name":"flags","transform":{"type":"scalar"},"required":true,"locs":[{"a":179,"b":186}]},{"name":"amounts","transform":{"type":"scalar"},"required":true,"locs":[{"a":188,"b":197}]},{"name":"amount","transform":{"type":"scalar"},"required":true,"locs":[{"a":199,"b":207}]},{"name":"location","transform":{"type":"scalar"},"required":true,"locs":[{"a":209,"b":219}]},{"name":"period","transform":{"type":"scalar"},"required":true,"locs":[{"a":221,"b":229}]},{"name":"recordedAt","transform":{"type":"scalar"},"required":true,"locs":[{"a":231,"b":243}]},{"name":"contact","transform":{"type":"scalar"},"required":true,"locs":[{"a":245,"b":254}]}],"columns":[],"name":"InsertDriverTypes_099e016d"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO driver_types
 *   (duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at, contact)
 * VALUES
 *   (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :period!, :recordedAt!, :contact!)
 * RETURNING id
 * ```
 */
export const insertDriverTypes = new TypedQuery<InsertDriverTypesParams,InsertDriverTypesResult>(insertDriverTypesIR);


