import Link from "next/link";

export const metadata = { title: "Sign in — Good Cart Day" };

export default function SignInPage() {
  return <main className="gcd-legal"><Link href="/">← Good Cart Day</Link><p className="gcd-kicker" style={{ marginTop: 48 }}>Private beta</p><h1>Welcome back.</h1><p>Good Cart Day is invite-only. Sign in if your household has already been invited.</p><form action="/api/auth/start" method="post" className="gcd-form"><button className="gcd-primary" type="submit">Continue with Google →</button></form><p style={{ marginTop: 28 }}>Prefer email? We’ll send a one-time sign-in link.</p><form action="/api/auth/magic-link" method="post" className="gcd-form"><label htmlFor="email">Email address</label><input id="email" name="email" type="email" required autoComplete="email" /><button className="gcd-primary" type="submit">Email me a link →</button></form></main>;
}
