import { authEnv, clearCookie, parseCookies, readSignedState, secureCookie } from "../../../lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url); const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
  try {
    const config = await authEnv(); const unsigned = await readSignedState(parseCookies(request)["__Host-gcd-auth-state"], config.GOOD_CART_DAY_AUTH_STATE_SECRET);
    const [storedState, verifier] = unsigned?.split(":") ?? []; if (!code || !storedState || !verifier || (state && state !== storedState)) return redirect("/sign-in?error=expired", [clearCookie("__Host-gcd-auth-state")]);
    const response = await fetch(`${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=pkce`, { method: "POST", headers: { apikey: config.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${config.SUPABASE_PUBLISHABLE_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ auth_code: code, code_verifier: verifier }) });
    const session = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }; if (!response.ok || !session.access_token || !session.refresh_token) return redirect("/sign-in?error=expired", [clearCookie("__Host-gcd-auth-state")]);
    return redirect("/app", [clearCookie("__Host-gcd-auth-state"), secureCookie("__Host-gcd-access", session.access_token, Math.max(60, session.expires_in ?? 3600)), secureCookie("__Host-gcd-refresh", session.refresh_token, 60 * 60 * 24 * 30)]);
  } catch { return redirect("/sign-in?error=unavailable", [clearCookie("__Host-gcd-auth-state")]); }
}

function redirect(location: string, cookies: string[]) { const headers = new Headers({ location, "cache-control": "no-store" }); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(null, { status: 303, headers }); }
