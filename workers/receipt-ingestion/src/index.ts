import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  extractReceiptWithGemini,
  RECEIPT_EXTRACTION_SCHEMA_VERSION,
} from "./extraction";

type ReceiptIngestionRow = {
  id: string;
  household_id: string;
  trip_id: string;
  source_storage_key: string;
  source_content_type: string;
  source_byte_size: number;
  revision: number;
  status: string;
};

type OutboxRow = {
  id: string;
  household_id: string;
  trip_id: string;
  recipient_member_id: string;
  status: string;
};

type TripReportRow = {
  household_id: string;
  scheduled_for: string;
  status: string;
  estimated_total_cents: number | null;
  total_cents: number | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  discount_cents: number | null;
  planned_item_count: number;
  matched_item_count: number;
  extra_item_count: number;
  discounted_item_count: number;
  recipient_email: string;
  recipient_name: string;
};

type IngestionParams = { ingestionId: string };
type ReportParams = { outboxId: string };

const ARTIFACT_PREFIX = "receipt-ingestion-artifacts";

function nowIso() {
  return new Date().toISOString();
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown worker error";
}

function nonRetryableExtractionError(error: unknown) {
  if (!(error instanceof Error)) return null;
  if (
    /HTTP (400|401|403|404)\b/.test(error.message) ||
    error.message.includes("Receipt source object is missing") ||
    error.message.includes("Receipt source size no longer matches") ||
    /Receipt provider did not return|must be an integer or null|outside the permitted range|must be a date string or null|lines must contain|warnings must be|itemNumber is invalid|taxStatus is invalid|needsReview must be boolean|rawDescription must be/.test(error.message)
  ) {
    return new NonRetryableError(error.message);
  }
  return null;
}

function cents(value: number | null) {
  return value === null ? "—" : `$${(value / 100).toFixed(2)}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return replacements[character] ?? character;
  });
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function hasInternalAccess(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const presented = request.headers.get("x-basketsense-internal-token");
  if (!presented) return false;
  return bytesEqual(await digest(presented), await digest(secret));
}

function ingestionArtifactKey(ingestion: ReceiptIngestionRow) {
  return `${ARTIFACT_PREFIX}/${ingestion.household_id}/${ingestion.id}/revision-${ingestion.revision}.json`;
}

async function readIngestion(db: D1Database, ingestionId: string) {
  return db
    .prepare(`SELECT * FROM receipt_ingestions WHERE id = ? LIMIT 1`)
    .bind(ingestionId)
    .first<ReceiptIngestionRow>();
}

async function claimIngestion(db: D1Database, ingestionId: string) {
  const claimed = await db
    .prepare(
      `UPDATE receipt_ingestions
       SET status = 'extracting', attempt_count = attempt_count + 1,
           error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .bind(nowIso(), ingestionId)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return readIngestion(db, ingestionId);
}

async function failIngestion(db: D1Database, ingestionId: string, error: unknown) {
  await db
    .prepare(
      `UPDATE receipt_ingestions
       SET status = 'failed', error_code = ?, updated_at = ?
       WHERE id = ? AND status = 'extracting'`
    )
    .bind(errorMessage(error), nowIso(), ingestionId)
    .run();
}

async function persistDraft(
  env: Env,
  ingestion: ReceiptIngestionRow,
  artifact: Record<string, unknown>,
) {
  const artifactKey = ingestionArtifactKey(ingestion);
  await env.RECEIPTS.put(artifactKey, JSON.stringify(artifact), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      householdId: ingestion.household_id,
      ingestionId: ingestion.id,
      artifact: "receipt-extraction-draft",
    },
  });
  const stored = await env.DB
    .prepare(
      `UPDATE receipt_ingestions
       SET status = 'awaiting_review', provider = 'gemini', model = ?,
           prompt_version = ?, schema_version = ?, extraction_artifact_key = ?,
           error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'extracting'`
    )
    .bind(
      env.GEMINI_MODEL,
      "costco-receipt-extraction-v1",
      RECEIPT_EXTRACTION_SCHEMA_VERSION,
      artifactKey,
      nowIso(),
      ingestion.id,
    )
    .run();
  if ((stored.meta.changes ?? 0) !== 1) {
    throw new Error("Receipt extraction lost its processing claim before it could be stored");
  }
  return artifactKey;
}

async function queueTripReports(db: D1Database, tripId: string) {
  const trip = await db
    .prepare(
      `SELECT trips.id, trips.household_id
       FROM trips
       INNER JOIN receipt_transactions
         ON receipt_transactions.trip_id = trips.id
       WHERE trips.id = ?
         AND trips.status = 'completed'
         AND receipt_transactions.source_type = 'receipt_photo'
         AND receipt_transactions.parse_status = 'reconciled'
       LIMIT 1`
    )
    .bind(tripId)
    .first<{ id: string; household_id: string }>();
  if (!trip) throw new Error("Trip report requires a completed, reconciled receipt");
  const members = await db
    .prepare(`SELECT id FROM household_members WHERE household_id = ?`)
    .bind(trip.household_id)
    .all<{ id: string }>();
  const now = nowIso();
  const statements = members.results.map((member) =>
    db
      .prepare(
        `INSERT INTO email_outbox (
          id, household_id, trip_id, recipient_member_id, kind, dedupe_key,
          status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'trip_summary', ?, 'queued', 0, ?, ?)
        ON CONFLICT(dedupe_key) DO NOTHING`
      )
      .bind(
        crypto.randomUUID(),
        trip.household_id,
        trip.id,
        member.id,
        `trip-summary:${trip.id}:${member.id}:v2`,
        now,
        now,
      )
  );
  if (statements.length) await db.batch(statements);
  return db
    .prepare(
      `SELECT id FROM email_outbox
       WHERE trip_id = ? AND kind = 'trip_summary' AND status = 'queued'
         AND dedupe_key LIKE 'trip-summary:%:v2'`
    )
    .bind(trip.id)
    .all<{ id: string }>();
}

async function claimOutbox(db: D1Database, outboxId: string) {
  const claimed = await db
    .prepare(
      `UPDATE email_outbox
       SET status = 'sending', attempt_count = attempt_count + 1,
           locked_at = ?, last_error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .bind(nowIso(), nowIso(), outboxId)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return db
    .prepare(`SELECT * FROM email_outbox WHERE id = ? LIMIT 1`)
    .bind(outboxId)
    .first<OutboxRow>();
}

async function loadTripReport(db: D1Database, outbox: OutboxRow) {
  return db
    .prepare(
      `SELECT trips.household_id, trips.scheduled_for, trips.status,
              trip_intent_snapshots.estimated_total_cents,
              receipt_transactions.total_cents, receipt_transactions.subtotal_cents,
              receipt_transactions.tax_cents, receipt_transactions.discount_cents,
              (SELECT COUNT(*) FROM trip_intent_items
               WHERE trip_intent_items.trip_id = trips.id
                 AND trip_intent_items.included = 1) AS planned_item_count,
              (SELECT COUNT(*) FROM trip_item_matches
               WHERE trip_item_matches.trip_id = trips.id
                 AND trip_item_matches.receipt_transaction_id = receipt_transactions.id) AS matched_item_count,
              (SELECT COUNT(*) FROM receipt_items
               LEFT JOIN trip_item_matches
                 ON trip_item_matches.receipt_item_id = receipt_items.id
               WHERE receipt_items.receipt_transaction_id = receipt_transactions.id
                 AND receipt_items.is_return = 0
                 AND trip_item_matches.id IS NULL) AS extra_item_count,
              (SELECT COUNT(*) FROM receipt_items
               WHERE receipt_items.receipt_transaction_id = receipt_transactions.id
                 AND receipt_items.discount_cents > 0) AS discounted_item_count,
              household_members.user_email AS recipient_email,
              household_members.display_name AS recipient_name
       FROM trips
       INNER JOIN receipt_transactions
         ON receipt_transactions.trip_id = trips.id
       LEFT JOIN trip_intent_snapshots ON trip_intent_snapshots.trip_id = trips.id
       INNER JOIN household_members ON household_members.id = ?
       WHERE trips.id = ?
         AND trips.household_id = ?
         AND trips.status = 'completed'
         AND receipt_transactions.source_type = 'receipt_photo'
         AND receipt_transactions.parse_status = 'reconciled'
       ORDER BY receipt_transactions.updated_at DESC
       LIMIT 1`
    )
    .bind(outbox.recipient_member_id, outbox.trip_id, outbox.household_id)
    .first<TripReportRow>();
}

function reportMessage(report: TripReportRow, appUrl: string) {
  const variance =
    report.estimated_total_cents === null || report.total_cents === null
      ? null
      : report.total_cents - report.estimated_total_cents;
  const subject = "BasketSense: your Costco replay is ready";
  const varianceLine =
    variance === null
      ? "There was no frozen estimate to compare this trip."
      : variance === 0
        ? "Checkout landed exactly on the saved estimate."
        : `${variance > 0 ? "Checkout ran over" : "Checkout came in under"} the saved estimate by ${cents(Math.abs(variance))}.`;
  const recapUrl = `${appUrl.replace(/\/$/, "")}/recap`;
  const text = [
    `Hi ${report.recipient_name},`,
    "",
    `Your ${report.scheduled_for} Costco replay is ready.`,
    `Checkout: ${cents(report.total_cents)} · saved plan: ${cents(report.estimated_total_cents)}.`,
    varianceLine,
    `${report.matched_item_count} of ${report.planned_item_count} planned items matched the receipt. ${report.extra_item_count} pickup${report.extra_item_count === 1 ? "" : "s"} went beyond the saved list.`,
    report.discounted_item_count
      ? `${report.discounted_item_count} item${report.discounted_item_count === 1 ? "" : "s"} had a receipt discount, saving ${cents(report.discount_cents)}.`
      : `Receipt discounts: ${cents(report.discount_cents)}.`,
    "",
    `Open your private BasketSense recap: ${recapUrl}`,
  ].join("\n");
  const html = `<div style="background:#f5f8f4;padding:28px 16px;font-family:Arial,sans-serif;color:#173326">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px;border:1px solid #d8e5d9">
    <p style="margin:0 0 8px;color:#4b7d59;font-weight:700">BasketSense · latest trip recap</p>
    <h1 style="margin:0 0 16px;font-size:30px;line-height:1.1">Plan → checkout</h1>
    <p>Hi ${escapeHtml(report.recipient_name)}, your <strong>${escapeHtml(report.scheduled_for)}</strong> Costco replay is ready.</p>
    <table role="presentation" width="100%" style="border-collapse:separate;border-spacing:8px 0;margin:20px -8px"><tr>
      <td style="width:50%;padding:16px;background:#eff7ef;border-radius:12px"><span style="color:#567060;font-size:12px">SAVED PLAN</span><br><strong style="font-size:24px">${cents(report.estimated_total_cents)}</strong></td>
      <td style="width:50%;padding:16px;background:#173326;color:#ffffff;border-radius:12px"><span style="color:#c7dfcc;font-size:12px">CHECKOUT</span><br><strong style="font-size:24px">${cents(report.total_cents)}</strong></td>
    </tr></table>
    <p style="margin:20px 0 8px;font-weight:700">${escapeHtml(varianceLine)}</p>
    <ul style="padding-left:20px;line-height:1.6">
      <li>${report.matched_item_count} of ${report.planned_item_count} planned items matched.</li>
      <li>${report.extra_item_count} pickup${report.extra_item_count === 1 ? "" : "s"} beyond the saved list.</li>
      <li>${report.discounted_item_count} discounted item${report.discounted_item_count === 1 ? "" : "s"} · ${cents(report.discount_cents)} saved.</li>
    </ul>
    <p style="margin:24px 0 0"><a href="${escapeHtml(recapUrl)}" style="display:inline-block;background:#8bc9a1;color:#102117;text-decoration:none;padding:14px 18px;border-radius:10px;font-weight:700">Open private recap</a></p>
    <p style="margin:18px 0 0;color:#607365;font-size:13px">The detailed item cards and any useful follow-ups stay inside your private BasketSense household.</p>
  </div>
</div>`;
  return { subject, text, html };
}

async function startQueuedTripReports(env: Env) {
  const queued = await env.DB
    .prepare(
      `SELECT id FROM email_outbox
       WHERE kind = 'trip_summary' AND status = 'queued'
         AND dedupe_key LIKE 'trip-summary:%:v2'
       ORDER BY created_at ASC
       LIMIT 50`,
    )
    .all<{ id: string }>();
  await Promise.all(
    queued.results.map((entry) =>
      env.TRIP_REPORT.create({ params: { outboxId: entry.id } }),
    ),
  );
  return queued.results.length;
}

async function markOutboxSent(db: D1Database, outboxId: string, messageId: string | null) {
  await db
    .prepare(
      `UPDATE email_outbox
       SET status = 'sent', provider_message_id = ?, sent_at = ?,
           locked_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'sending'`
    )
    .bind(messageId, nowIso(), nowIso(), outboxId)
    .run();
}

async function markOutboxUnknown(db: D1Database, outboxId: string, error: unknown) {
  await db
    .prepare(
      `UPDATE email_outbox
       SET status = 'unknown', last_error_code = ?, updated_at = ?
       WHERE id = ? AND status = 'sending'`
    )
    .bind(errorMessage(error), nowIso(), outboxId)
    .run();
}

export class ReceiptIngestionWorkflow extends WorkflowEntrypoint<Env> {
  override async run(event: WorkflowEvent<IngestionParams>, step: WorkflowStep) {
    const ingestion = await step.do("claim receipt ingestion", () =>
      claimIngestion(this.env.DB, event.payload.ingestionId)
    );
    if (!ingestion) return { status: "not_claimed" };

    try {
      const artifactKey = await step.do(
        "extract receipt into review draft",
        {
          // Provider limits should not leave a household receipt in an
          // indefinite processing state. A user can explicitly retry a failed
          // ingestion after resolving the provider issue.
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          timeout: "2 minutes",
        },
        async () => {
          try {
            const source = await this.env.RECEIPTS.get(ingestion.source_storage_key);
            if (!source) throw new Error("Receipt source object is missing");
            if (source.size !== ingestion.source_byte_size) {
              throw new Error("Receipt source size no longer matches its ingestion record");
            }
            const bytes = await source.arrayBuffer();
            const result = await extractReceiptWithGemini({
              apiKey: this.env.GEMINI_API_KEY,
              model: this.env.GEMINI_MODEL,
              contentType: ingestion.source_content_type,
              bytes,
            });
            return persistDraft(this.env, ingestion, {
              ingestionId: ingestion.id,
              householdId: ingestion.household_id,
              tripId: ingestion.trip_id,
              revision: ingestion.revision,
              provider: "gemini",
              model: this.env.GEMINI_MODEL,
              responseId: result.responseId,
              schemaVersion: RECEIPT_EXTRACTION_SCHEMA_VERSION,
              createdAt: nowIso(),
              draft: result.draft,
            });
          } catch (error) {
            throw nonRetryableExtractionError(error) ?? error;
          }
        }
      );
      return { status: "awaiting_review", artifactKey };
    } catch (error) {
      await step.do("record extraction failure", () =>
        failIngestion(this.env.DB, ingestion.id, error)
      );
      return { status: "failed" };
    }
  }
}

export class TripReportWorkflow extends WorkflowEntrypoint<Env> {
  override async run(event: WorkflowEvent<ReportParams>, step: WorkflowStep) {
    const outbox = await step.do("claim trip summary email", () =>
      claimOutbox(this.env.DB, event.payload.outboxId)
    );
    if (!outbox) return { status: "not_claimed" };
    try {
      const message = await step.do("build trip summary", async () => {
        const report = await loadTripReport(this.env.DB, outbox);
        if (!report) throw new Error("Trip report no longer has confirmed household evidence");
        return { report, message: reportMessage(report, this.env.APP_URL) };
      });
      const delivery = await step.do("send trip summary", () =>
        this.env.EMAIL.send({
          to: message.report.recipient_email,
          from: { email: this.env.EMAIL_FROM, name: "BasketSense" },
          subject: message.message.subject,
          text: message.message.text,
          html: message.message.html,
        })
      );
      const providerMessageId = isRecord(delivery) && typeof delivery.messageId === "string"
        ? delivery.messageId
        : null;
      await step.do("mark trip summary sent", () =>
        markOutboxSent(this.env.DB, outbox.id, providerMessageId)
      );
      return { status: "sent" };
    } catch (error) {
      await step.do("mark delivery unknown", () =>
        markOutboxUnknown(this.env.DB, outbox.id, error)
      );
      return { status: "unknown" };
    }
  }
}

async function queueIngestion(db: D1Database, ingestionId: string) {
  const update = await db
    .prepare(
      `UPDATE receipt_ingestions
       SET status = 'queued', error_code = NULL, updated_at = ?
       WHERE id = ? AND status IN ('uploaded', 'failed')`
    )
    .bind(nowIso(), ingestionId)
    .run();
  return (update.meta.changes ?? 0) === 1;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return response({ service: "basketsense-receipt-ingestion", environment: env.ENVIRONMENT });
    }
    if (!await hasInternalAccess(request, env.INGESTION_INTERNAL_TOKEN)) {
      return response({ error: "Not found" }, 404);
    }
    const ingestionMatch = url.pathname.match(/^\/internal\/ingestions\/([^/]+)\/run$/);
    if (request.method === "POST" && ingestionMatch) {
      const ingestionId = decodeURIComponent(ingestionMatch[1]);
      if (!(await queueIngestion(env.DB, ingestionId))) {
        return response({ error: "Ingestion is not ready to run" }, 409);
      }
      const instance = await env.RECEIPT_INGESTION.create({ params: { ingestionId } });
      return response({ accepted: true, workflowInstanceId: instance.id }, 202);
    }
    const reportMatch = url.pathname.match(/^\/internal\/trips\/([^/]+)\/report$/);
    if (request.method === "POST" && reportMatch) {
      const tripId = decodeURIComponent(reportMatch[1]);
      try {
        const outbox = await queueTripReports(env.DB, tripId);
        const instances = await Promise.all(
          outbox.results.map((entry) => env.TRIP_REPORT.create({ params: { outboxId: entry.id } }))
        );
        return response({ accepted: true, workflowInstanceIds: instances.map((instance) => instance.id) }, 202);
      } catch (error) {
        return response({ error: errorMessage(error) }, 409);
      }
    }
    return response({ error: "Not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(startQueuedTripReports(env));
  },
} satisfies ExportedHandler<Env>;
