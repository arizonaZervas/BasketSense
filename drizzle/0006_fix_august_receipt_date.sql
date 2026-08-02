UPDATE receipt_transactions
SET purchased_at = '2026-08-01T00:00:00.000Z'
WHERE source_type = 'receipt_photo'
  AND total_cents = 17181
  AND substr(purchased_at, 1, 10) = '2020-08-01'
  AND trip_id IN (
    SELECT id
    FROM trips
    WHERE scheduled_for = '2026-08-01'
  );
