/* @name GetDriverTypes */
SELECT id, duration, start_time, start_time_tz, flags, amounts, amount, location, recorded_at
FROM driver_types;

/* @name InsertDriverTypes */
INSERT INTO driver_types
  (duration, start_time, start_time_tz, flags, amounts, amount, location, recorded_at)
VALUES
  (:duration!, :startTime!, :startTimeTz!, :flags!, :amounts!, :amount!, :location!, :recordedAt!)
RETURNING id;
