import { authEnv, secureCookie, sha256Base64Url, signedState, sameOrigin } from "../../../lib/auth";

export const dynamic = "force-dynamic";

function redirect(location: string, headers?: HeadersInit) { return new Response(null, { status: 303, headers: { location, ...headers, "cache-control": "no-store" } }); }

export async function POST(request: Request) {
  try {
    const config = await authEnv();
    if (!sameOrigin(request, config.GOOD_CART_DAY_APP_ORIGIN)) return new Response("Not found", { status: 404 });
    const state = crypto.randomUUID(); const verifier = base64Url(48); const challenge = await sha256Base64Url(verifier);
    const stateCookie = await signedState(`${state}:${verifier}`, config.GOOD_CART_DAY_AUTH_STATE_SECRET);
    const url = new URL(`${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/authorize`);
    url.searchParams.set("provider", "google"); url.searchParams.set("redirect_to", `${config.GOOD_CART_DAY_APP_ORIGIN}/api/auth/callback`);
    url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256"); url.searchParams.set("state", state);
    return redirect(url.toString(), { "set-cookie": secureCookie("__Host-gcd-auth-state", stateCookie, 600) });
  } catch { return redirect("/sign-in?error=unavailable"); }
}

function base64Url(length: number) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
