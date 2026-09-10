/** Types generated for queries found in "src/driverTypes/driverTypes.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

export type DateOrString = Date | string;

export type NumberOrString = number | string;

export type NumberOrStringArray = (number | string)[];

export type PgInterval = {
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
};

export type PgPoint = { x: number; y: number };

export type numberArray = (number)[];

/** 'GetDriverTypes' parameters type */
export type GetDriverTypesParams = void;

/** 'GetDriverTypes' return type */
export interface GetDriverTypesResult {
  amount: string;
  amounts: numberArray;
  duration: PgInterval;
  flags: string;
  id: number;
  location: PgPoint;
  recorded_at: Date;
  start_time: string;
  start_time_tz: string;
}

/** 'GetDriverTypes' query type */
export interface GetDriverTypesQuery {
  params: GetDriverTypesParams;
  result: GetDriverTypesResult;
}

const getDriverTypesIR: any = {"queryName":"GetDriverTypes","statement":"SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, recorded_at\nFROM driver_types","params":[],"columns":[],"name":"GetDriverTypes_eaf9eb78"};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, recorded_at
 * FROM driver_types
 * ```
 */
export const getDriverTypes = new TypedQuery<GetDriverTypesParams,GetDriverTypesResult>(getDriverTypesIR);


/** 'InsertDriverTypes' parameters type */
export interface InsertDriverTypesParams {
  amount: NumberOrString;
  amounts: NumberOrStringArray;
  duration: string;
  flags: string;
  location: string;
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

const insertDriverTypesIR: any = {"queryName":"InsertDriverTypes","statement":"INSERT INTO driver_types\n  (duration, start_time, start_time_tz, flags, amounts, amount, location, recorded_at)\nVALUES\n  (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :recordedAt!)\nRETURNING id","params":[{"name":"duration","transform":{"type":"scalar"},"required":true,"locs":[{"a":122,"b":132}]},{"name":"startTime","transform":{"type":"scalar"},"required":true,"locs":[{"a":134,"b":145}]},{"name":"startTimeTz","transform":{"type":"scalar"},"required":true,"locs":[{"a":147,"b":160}]},{"name":"flags","transform":{"type":"scalar"},"required":true,"locs":[{"a":162,"b":169}]},{"name":"amounts","transform":{"type":"scalar"},"required":true,"locs":[{"a":171,"b":180}]},{"name":"amount","transform":{"type":"scalar"},"required":true,"locs":[{"a":182,"b":190}]},{"name":"location","transform":{"type":"scalar"},"required":true,"locs":[{"a":192,"b":202}]},{"name":"recordedAt","transform":{"type":"scalar"},"required":true,"locs":[{"a":204,"b":216}]}],"columns":[],"name":"InsertDriverTypes_986d50d8"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO driver_types
 *   (duration, start_time, start_time_tz, flags, amounts, amount, location, recorded_at)
 * VALUES
 *   (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :recordedAt!)
 * RETURNING id
 * ```
 */
export const insertDriverTypes = new TypedQuery<InsertDriverTypesParams,InsertDriverTypesResult>(insertDriverTypesIR);


