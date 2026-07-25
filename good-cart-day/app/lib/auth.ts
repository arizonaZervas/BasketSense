import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

interface RuntimeEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  GOOD_CART_DAY_APP_ORIGIN?: string;
  GOOD_CART_DAY_AUTH_STATE_SECRET?: string;
}

export interface GoodCartDayIdentity { subject: string; email: string | null; payload: JWTPayload; }

export async function authEnv(): Promise<Required<Pick<RuntimeEnv, "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY" | "GOOD_CART_DAY_APP_ORIGIN" | "GOOD_CART_DAY_AUTH_STATE_SECRET">>> {
  const runtime = (await import("cloudflare:workers")) as unknown as { env: RuntimeEnv };
  const values = runtime.env;
  if (!values.SUPABASE_URL || !values.SUPABASE_PUBLISHABLE_KEY || !values.GOOD_CART_DAY_APP_ORIGIN || !values.GOOD_CART_DAY_AUTH_STATE_SECRET) {
    throw new Error("Good Cart Day authentication is not configured");
  }
  return values as Required<Pick<RuntimeEnv, "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY" | "GOOD_CART_DAY_APP_ORIGIN" | "GOOD_CART_DAY_AUTH_STATE_SECRET">>;
}

function base64Url(bytes: Uint8Array) {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Base64Url(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

export async function signedState(value: string, secret: string) { return `${value}.${await signature(value, secret)}`; }
export async function readSignedState(value: string | undefined, secret: string) {
  if (!value) return null; const separator = value.lastIndexOf("."); if (separator < 1) return null;
  const unsigned = value.slice(0, separator); const supplied = value.slice(separator + 1); const expected = await signature(unsigned, secret);
  if (supplied.length !== expected.length) return null;
  let mismatch = 0; for (let index = 0; index < supplied.length; index += 1) mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0 ? unsigned : null;
}

export function parseCookies(request: Request) {
  return Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map((piece) => piece.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value ?? "")]));
}

export function secureCookie(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearCookie(name: string) { return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }

export async function verifyAccessToken(token: string): Promise<GoodCartDayIdentity> {
  const config = await authEnv();
  const issuer = `${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const verified = await jwtVerify(token, jwks, { issuer, audience: "authenticated" });
  if (!verified.payload.sub) throw new Error("Missing Supabase subject");
  return { subject: verified.payload.sub, email: typeof verified.payload.email === "string" ? verified.payload.email : null, payload: verified.payload };
}

export function sameOrigin(request: Request, expectedOrigin: string) { return request.headers.get("origin") === expectedOrigin; }
