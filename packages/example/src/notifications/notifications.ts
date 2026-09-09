import { sql } from '@pelotech/pgtyped-runtime';
import {
  InsertNotificationQuery,
  InsertNotificationsQuery,
  GetAllNotificationsQuery,
  CountNotificationsQuery,
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

// Prepared on purpose: this one renders a fixed SQL text, so it can carry a
// canonical statement name and be prepared server-side. The name is explicit,
// so the statement reads as `GetAllNotifications_<hash>` in
// pg_stat_statements. The variable is camelCase of it, which is what codegen
// expects.
export const getAllNotifications = sql.prepared<GetAllNotificationsQuery>(
  'GetAllNotifications',
)`
  SELECT * FROM notifications
`;

// The same opt-in without a name: the runtime derives `pgtyped_<16 hex of the
// statement hash>`. Nothing to keep in sync, at the cost of an identifier that
// says nothing about the query when you meet it on the server.
export const countNotifications = sql.prepared<CountNotificationsQuery>()`
  SELECT count(*)::int AS total FROM notifications
`;
