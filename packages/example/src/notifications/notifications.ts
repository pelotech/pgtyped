import { sql } from '@pelotech/pgtyped-runtime';
import {
  InsertNotificationQuery,
  InsertNotificationsQuery,
  GetAllNotificationsQuery,
} from './notifications.types.js';

// Table order is (user_id, payload, type)
export const insertNotifications = sql<InsertNotificationsQuery>`
INSERT INTO notifications (payload, user_id, type)
values $$params(payload!, user_id!, type!)
`;

export const insertNotification = sql<InsertNotificationQuery>`
    INSERT INTO notifications (payload, user_id, type)
    values $notification(payload!, user_id!, type!)
`;

export const getAllNotifications = sql<GetAllNotificationsQuery>`
  SELECT * FROM notifications
`;
