/* @name GetDriverTypes */
SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at
FROM driver_types;

/* @name InsertDriverTypes */
INSERT INTO driver_types
  (duration, start_time, start_time_tz, flags, amounts, amount, location, period, recorded_at)
VALUES
  (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :period!, :recordedAt!)
RETURNING id;
