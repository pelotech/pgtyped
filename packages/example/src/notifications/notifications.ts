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

// Named on purpose: this one renders a fixed SQL text, so it can carry a
// canonical statement name and be prepared server-side. The variable is
// camelCase of the name, which is what codegen expects.
export const getAllNotifications = sql.named<GetAllNotificationsQuery>(
  'GetAllNotifications',
)`
  SELECT * FROM notifications
`;
