/** Types generated for queries found in "src/notifications/notifications.ts" */
export type notification_type = 'deadline' | 'notification' | 'reminder';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 'InsertNotifications' parameters type */
export interface InsertNotificationsParams {
  params: readonly ({
    payload: Json,
    user_id: number,
    type: notification_type
  })[];
}

/** 'InsertNotifications' return type */
export type InsertNotificationsResult = void;

/** 'InsertNotifications' query type */
export interface InsertNotificationsQuery {
  params: InsertNotificationsParams;
  result: InsertNotificationsResult;
}

/** 'InsertNotification' parameters type */
export interface InsertNotificationParams {
  notification: {
    payload: Json,
    user_id: number,
    type: notification_type
  };
}

/** 'InsertNotification' return type */
export type InsertNotificationResult = void;

/** 'InsertNotification' query type */
export interface InsertNotificationQuery {
  params: InsertNotificationParams;
  result: InsertNotificationResult;
}

/** 'GetAllNotifications' parameters type */
export type GetAllNotificationsParams = void;

/** 'GetAllNotifications' return type */
export interface GetAllNotificationsResult {
  created_at: string;
  id: number;
  payload: Json;
  type: notification_type;
  user_id: number | null;
}

/** 'GetAllNotifications' query type */
export interface GetAllNotificationsQuery {
  params: GetAllNotificationsParams;
  result: GetAllNotificationsResult;
}

/** 'CountNotifications' parameters type */
export type CountNotificationsParams = void;

/** 'CountNotifications' return type */
export interface CountNotificationsResult {
  total: number | null;
}

/** 'CountNotifications' query type */
export interface CountNotificationsQuery {
  params: CountNotificationsParams;
  result: CountNotificationsResult;
}

