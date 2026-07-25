import { cookies } from "next/headers";
import Link from "next/link";
import { verifyAccessToken } from "../lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your household — Good Cart Day" };

export default async function ProductGate() {
  const token = (await cookies()).get("__Host-gcd-access")?.value;
  if (!token) return <SignInRequired />;
  let email: string | null = null;
  try { email = (await verifyAccessToken(token)).email; } catch { return <ExpiredSession />; }
  return <InviteOnly email={email} />;
}

function SignInRequired() { return <main className="gcd-legal"><Link href="/">← Good Cart Day</Link><h1>Sign in to continue.</h1><p>This product is invite-only while we validate the beta.</p><Link className="gcd-primary" href="/sign-in">Sign in →</Link></main>; }
function ExpiredSession() { return <main className="gcd-legal"><Link href="/">← Good Cart Day</Link><h1>Sign in to continue.</h1><p>Your secure session has expired.</p><Link className="gcd-primary" href="/sign-in">Sign in again →</Link></main>; }
function InviteOnly({ email }: { email: string | null }) { return <main className="gcd-legal"><Link href="/">← Good Cart Day</Link><p className="gcd-kicker" style={{ marginTop: 48 }}>Private beta</p><h1>Access is invite-only.</h1><p>{email ?? "This account"} is signed in, but it does not yet have an active Good Cart Day household invitation.</p><p>We keep this state intentionally neutral: signing in never creates a household or exposes another household’s data.</p><form action="/api/auth/sign-out" method="post"><button className="gcd-primary" type="submit">Sign out</button></form></main>; }
