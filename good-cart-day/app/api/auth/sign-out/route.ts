import { clearCookie } from "../../../lib/auth";
export async function POST() { const headers = new Headers({ location: "/", "cache-control": "no-store" }); headers.append("set-cookie", clearCookie("__Host-gcd-access")); headers.append("set-cookie", clearCookie("__Host-gcd-refresh")); return new Response(null, { status: 303, headers }); }
