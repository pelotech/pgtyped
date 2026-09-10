/* @name GetDriverTypes */
SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at, contact
FROM driver_types;

/* @name InsertDriverTypes */
INSERT INTO driver_types
  (duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at, contact)
VALUES
  (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :period!, :recordedAt!, :contact!)
RETURNING id;
