/** Types generated for queries found in "src/notifications/notifications.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

import type { DateOrString, Json, notification_type } from '../pgtyped-shared.js';

/** 'SendNotifications' parameters type */
export interface SendNotificationsParams {
  notifications: readonly ({
    user_id: number,
    payload: Json,
    type: notification_type
  })[];
}

/** 'SendNotifications' return type */
export interface SendNotificationsResult {
  notification_id: number;
}

/** 'SendNotifications' query type */
export interface SendNotificationsQuery {
  params: SendNotificationsParams;
  result: SendNotificationsResult;
}

const sendNotificationsIR: any = {"queryName":"SendNotifications","statement":"INSERT INTO notifications (user_id, payload, type)\nVALUES :notifications RETURNING id as notification_id","params":[{"name":"notifications","transform":{"type":"pick_array_spread","keys":[{"name":"user_id","required":true},{"name":"payload","required":true},{"name":"type","required":true}]},"required":false,"locs":[{"a":58,"b":72}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO notifications (user_id, payload, type)
 * VALUES :notifications RETURNING id as notification_id
 * ```
 */
export const sendNotifications = new TypedQuery<SendNotificationsParams,SendNotificationsResult>(sendNotificationsIR);


/** 'GetNotifications' parameters type */
export interface GetNotificationsParams {
  date: DateOrString;
  userId?: number | null | void;
}

/** 'GetNotifications' return type */
export interface GetNotificationsResult {
  created_at: string;
  id: number;
  payload: Json;
  type: notification_type;
  user_id: number | null;
}

/** 'GetNotifications' query type */
export interface GetNotificationsQuery {
  params: GetNotificationsParams;
  result: GetNotificationsResult;
}

const getNotificationsIR: any = {"queryName":"GetNotifications","statement":"SELECT *\n  FROM notifications\n WHERE user_id = :userId\n AND created_at > :date!","params":[{"name":"userId","transform":{"type":"scalar"},"required":false,"locs":[{"a":47,"b":54}]},{"name":"date","transform":{"type":"scalar"},"required":true,"locs":[{"a":73,"b":79}]}],"columns":[],"name":"GetNotifications_32a391fa"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 *   FROM notifications
 *  WHERE user_id = :userId
 *  AND created_at > :date!
 * ```
 */
export const getNotifications = new TypedQuery<GetNotificationsParams,GetNotificationsResult>(getNotificationsIR);


/** 'ThresholdFrogs' parameters type */
export interface ThresholdFrogsParams {
  numFrogs: number;
}

/** 'ThresholdFrogs' return type */
export interface ThresholdFrogsResult {
  payload: Json;
  type: notification_type;
  user_name: string;
}

/** 'ThresholdFrogs' query type */
export interface ThresholdFrogsQuery {
  params: ThresholdFrogsParams;
  result: ThresholdFrogsResult;
}

const thresholdFrogsIR: any = {"queryName":"ThresholdFrogs","statement":"SELECT u.user_name, n.payload, n.type\nFROM notifications n\nINNER JOIN users u on n.user_id = u.id\nWHERE CAST (n.payload->'num_frogs' AS int) > :numFrogs!","params":[{"name":"numFrogs","transform":{"type":"scalar"},"required":true,"locs":[{"a":143,"b":153}]}],"columns":[],"name":"ThresholdFrogs_6137d9bc"};

/**
 * Query generated from SQL:
 * ```
 * SELECT u.user_name, n.payload, n.type
 * FROM notifications n
 * INNER JOIN users u on n.user_id = u.id
 * WHERE CAST (n.payload->'num_frogs' AS int) > :numFrogs!
 * ```
 */
export const thresholdFrogs = new TypedQuery<ThresholdFrogsParams,ThresholdFrogsResult>(thresholdFrogsIR);


