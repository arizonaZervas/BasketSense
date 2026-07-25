import { authEnv, secureCookie, signedState, sameOrigin } from "../../../lib/auth";

export const dynamic = "force-dynamic";
const SENT = "/sign-in?sent=1";

export async function POST(request: Request) {
  try {
    const config = await authEnv();
    if (!sameOrigin(request, config.GOOD_CART_DAY_APP_ORIGIN)) return new Response("Not found", { status: 404 });
    const form = await request.formData(); const email = typeof form.get("email") === "string" ? String(form.get("email")).trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect(SENT);
    const state = crypto.randomUUID(); const verifier = token(); const stateCookie = await signedState(`${state}:${verifier}`, config.GOOD_CART_DAY_AUTH_STATE_SECRET);
    const callback = new URL(`${config.GOOD_CART_DAY_APP_ORIGIN}/api/auth/callback`); callback.searchParams.set("state", state);
    const response = await fetch(`${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/otp`, { method: "POST", headers: { apikey: config.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${config.SUPABASE_PUBLISHABLE_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ email, create_user: false, options: { emailRedirectTo: callback.toString() } }) });
    if (!response.ok) return redirect(SENT);
    return redirect(SENT, { "set-cookie": secureCookie("__Host-gcd-auth-state", stateCookie, 600) });
  } catch { return redirect(SENT); }
}

function redirect(location: string, headers?: HeadersInit) { return new Response(null, { status: 303, headers: { location, ...headers, "cache-control": "no-store" } }); }
function token() { const bytes = new Uint8Array(48); crypto.getRandomValues(bytes); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
