export const dynamic = "force-dynamic";

const RESET_DATE = "2026-07-25";
const RESET_CONFIRMATION = "RESET_JULY_25_RECEIPT";
const OWNER_EMAIL = "harwaniharsh@gmail.com";

interface RuntimeEnv {
  DB?: D1Database;
  RECEIPTS?: R2Bucket;
}

type ResetRow = {
  id: string;
  source_storage_key: string | null;
  extraction_artifact_key: string | null;
};

function responseJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authenticatedOwner(request: Request) {
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (email !== OWNER_EMAIL) {
    throw new Error("Only the BasketSense household owner can reset this receipt");
  }
  return email;
}

async function runtime() {
  const workersRuntime = (await import("cloudflare:workers")) as unknown as {
    env: RuntimeEnv;
  };
  if (!workersRuntime.env.DB || !workersRuntime.env.RECEIPTS) {
    throw new Error("Household storage is unavailable");
  }
  return { db: workersRuntime.env.DB, bucket: workersRuntime.env.RECEIPTS };
}

async function resetScope(db: D1Database, email: string) {
  const trip = await db
    .prepare(`SELECT trips.id, trips.household_id, trips.status, trips.frozen_at
      FROM trips
      INNER JOIN household_members ON household_members.household_id = trips.household_id
      WHERE trips.scheduled_for = ? AND lower(household_members.user_email) = ?
      LIMIT 1`)
    .bind(RESET_DATE, email)
    .first<{ id: string; household_id: string; status: string; frozen_at: string | null }>();
  if (!trip) throw new Error("The July 25 trip was not found");
  const snapshot = await db
    .prepare(`SELECT id FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(trip.id)
    .first<{ id: string }>();
  if (!snapshot) throw new Error("The pre-trip intent snapshot is unavailable; reset stopped");
  return { trip, snapshot };
}

async function receiptIds(db: D1Database, householdId: string, tripId: string) {
  return db
    .prepare(`SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?`)
    .bind(householdId, tripId)
    .all<{ id: string }>();
}

async function resetPreview(db: D1Database, email: string) {
  const { trip, snapshot } = await resetScope(db, email);
  const receipts = await receiptIds(db, trip.household_id, trip.id);
  const receiptIdList = receipts.results.map((receipt) => receipt.id);
  const counts = await db.batch([
    db.prepare(`SELECT count(*) AS count FROM receipt_transactions WHERE household_id = ? AND trip_id = ?`)
      .bind(trip.household_id, trip.id),
    db.prepare(`SELECT count(*) AS count FROM receipt_ingestions WHERE household_id = ? AND trip_id = ?`)
      .bind(trip.household_id, trip.id),
    db.prepare(`SELECT count(*) AS count FROM receipt_uploads WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
      .bind(trip.household_id, trip.id),
    db.prepare(`SELECT count(*) AS count FROM trip_item_matches WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
      .bind(trip.household_id, trip.id),
    db.prepare(`SELECT count(*) AS count FROM review_questions WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
      .bind(trip.household_id, trip.id),
    db.prepare(`SELECT count(*) AS count FROM feedback WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
      .bind(trip.household_id, trip.id),
    db.prepare(`SELECT count(*) AS count FROM email_outbox WHERE household_id = ? AND trip_id = ?`)
      .bind(trip.household_id, trip.id),
  ]);
  return {
    trip: { id: trip.id, status: trip.status, frozenAt: trip.frozen_at, intentSnapshotId: snapshot.id },
    receiptIds: receiptIdList,
    counts: counts.map((result) => Number((result.results[0] as { count?: number } | undefined)?.count ?? 0)),
  };
}

export async function POST(request: Request) {
  try {
    const email = authenticatedOwner(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || (body.action !== "preview" && body.action !== "reset")) {
      return responseJson({ error: "Unsupported reset action" }, 400);
    }
    const { db, bucket } = await runtime();
    const preview = await resetPreview(db, email);
    if (body.action === "preview") return responseJson({ preview });
    if (body.confirmation !== RESET_CONFIRMATION) {
      return responseJson({ error: "Reset confirmation is required" }, 400);
    }

    const { trip } = await resetScope(db, email);
    const ingestionObjects = await db
      .prepare(`SELECT id, source_storage_key, extraction_artifact_key
        FROM receipt_ingestions WHERE household_id = ? AND trip_id = ?`)
      .bind(trip.household_id, trip.id)
      .all<ResetRow>();
    const uploadedObjects = await db
      .prepare(`SELECT receipt_uploads.id, receipt_uploads.storage_key AS source_storage_key, NULL AS extraction_artifact_key
        FROM receipt_uploads
        INNER JOIN receipt_transactions ON receipt_transactions.id = receipt_uploads.receipt_transaction_id
        WHERE receipt_transactions.household_id = ? AND receipt_transactions.trip_id = ?`)
      .bind(trip.household_id, trip.id)
      .all<ResetRow>();
    const objectKeys = [...ingestionObjects.results, ...uploadedObjects.results]
      .flatMap((row) => [row.source_storage_key, row.extraction_artifact_key])
      .filter((key): key is string => Boolean(key));
    await Promise.all(objectKeys.map((key) => bucket.delete(key)));

    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`DELETE FROM feedback WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
        .bind(trip.household_id, trip.id),
      db.prepare(`DELETE FROM review_questions WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
        .bind(trip.household_id, trip.id),
      db.prepare(`DELETE FROM trip_item_matches WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
        .bind(trip.household_id, trip.id),
      db.prepare(`DELETE FROM receipt_uploads WHERE receipt_transaction_id IN (SELECT id FROM receipt_transactions WHERE household_id = ? AND trip_id = ?)`)
        .bind(trip.household_id, trip.id),
      db.prepare(`DELETE FROM receipt_ingestions WHERE household_id = ? AND trip_id = ?`)
        .bind(trip.household_id, trip.id),
      db.prepare(`DELETE FROM receipt_transactions WHERE household_id = ? AND trip_id = ?`)
        .bind(trip.household_id, trip.id),
      db.prepare(`DELETE FROM email_outbox WHERE household_id = ? AND trip_id = ?`)
        .bind(trip.household_id, trip.id),
      db.prepare(`UPDATE trips SET status = 'frozen', completed_at = NULL, updated_at = ? WHERE id = ? AND household_id = ?`)
        .bind(now, trip.id, trip.household_id),
    ]);
    const verified = await resetPreview(db, email);
    if (verified.counts.some((count) => count !== 0)) {
      throw new Error("Reset verification found remaining receipt records");
    }
    return responseJson({ reset: true, trip: verified.trip, deletedObjectCount: objectKeys.length });
  } catch (error) {
    return responseJson(
      { error: error instanceof Error ? error.message : "Unable to reset the July 25 receipt" },
      500,
    );
  }
}
