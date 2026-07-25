export const dynamic = "force-dynamic";

interface RuntimeEnv { BETA_INTEREST?: D1Database; TURNSTILE_SECRET_KEY?: string; BETA_INTEREST_HASH_PEPPER?: string; GOOD_CART_DAY_ORIGIN?: string; }
const SUCCESS = { accepted: true };

function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function genericSuccess() { return json(SUCCESS, 202); }
function text(value: string) { return new TextEncoder().encode(value); }
async function digest(value: string) { const bytes = await crypto.subtle.digest("SHA-256", text(value)); return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function env() { const runtime = (await import("cloudflare:workers")) as unknown as { env: RuntimeEnv }; if (!runtime.env.BETA_INTEREST) throw new Error("Beta interest storage is unavailable"); return runtime.env; }
function allowedOrigin(request: Request, configuredOrigin?: string) { const origin = request.headers.get("origin"); if (!origin) return false; const expected = configuredOrigin ?? new URL(request.url).origin; return origin === expected; }
async function ensureSchema(db: D1Database) { await db.batch([
  db.prepare(`CREATE TABLE IF NOT EXISTS beta_interest (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, email_hash TEXT NOT NULL UNIQUE, consent_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`),
  db.prepare(`CREATE TABLE IF NOT EXISTS beta_interest_rate_limits (rate_key TEXT PRIMARY KEY NOT NULL, window_start TEXT NOT NULL, request_count INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`),
]); }
async function verifiedTurnstile(token: string, secret: string, request: Request) { const body = new FormData(); body.set("secret", secret); body.set("response", token); const ip = request.headers.get("CF-Connecting-IP"); if (ip) body.set("remoteip", ip); const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body }); const result = await response.json() as { success?: boolean }; return result.success === true; }

export async function POST(request: Request) {
  try {
    const runtime = await env();
    if (!allowedOrigin(request, runtime.GOOD_CART_DAY_ORIGIN)) return genericSuccess();
    const body = await request.json() as { email?: unknown; consent?: unknown; company?: unknown; turnstileToken?: unknown };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
    if (typeof body.company === "string" && body.company.trim()) return genericSuccess();
    if (!body.consent || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return genericSuccess();
    if (!runtime.TURNSTILE_SECRET_KEY || !runtime.BETA_INTEREST_HASH_PEPPER || !token) return json({ accepted: false, error: "Beta signup is temporarily unavailable." }, 503);
    if (!(await verifiedTurnstile(token, runtime.TURNSTILE_SECRET_KEY, request))) return genericSuccess();
    const db = runtime.BETA_INTEREST; await ensureSchema(db);
    const now = new Date(); const windowStart = new Date(Math.floor(now.getTime() / 600_000) * 600_000).toISOString();
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const rateKey = await digest(`${ip}|${windowStart}|${runtime.BETA_INTEREST_HASH_PEPPER}`);
    const existing = await db.prepare("SELECT request_count FROM beta_interest_rate_limits WHERE rate_key = ?").bind(rateKey).first<{ request_count: number }>();
    if ((existing?.request_count ?? 0) >= 5) return genericSuccess();
    await db.prepare(`INSERT INTO beta_interest_rate_limits (rate_key, window_start, request_count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(rate_key) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at`).bind(rateKey, windowStart, now.toISOString()).run();
    const emailHash = await digest(`${email}|${runtime.BETA_INTEREST_HASH_PEPPER}`);
    await db.prepare(`INSERT INTO beta_interest (id, email, email_hash, consent_at) VALUES (?, ?, ?, ?) ON CONFLICT(email_hash) DO NOTHING`).bind(crypto.randomUUID(), email, emailHash, now.toISOString()).run();
    return genericSuccess();
  } catch { return json({ accepted: false, error: "Beta signup is temporarily unavailable." }, 503); }
}
