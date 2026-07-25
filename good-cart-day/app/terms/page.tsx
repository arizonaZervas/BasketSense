import Link from "next/link";

export const metadata = { title: "Terms — Good Cart Day" };

export default function TermsPage() {
  return <main className="gcd-legal"><Link href="/">← Good Cart Day</Link><h1>Terms</h1><p>Good Cart Day is an independent, invite-only beta for household planning. It is not affiliated with, endorsed by, or connected to Costco.</p><h2>No guarantees</h2><p>Estimates and insights are planning aids, not guarantees of price, savings, availability, product value, or household consumption. Review receipt details before relying on them.</p><h2>Beta access</h2><p>Access may be limited, changed, or removed while the service is being evaluated. Do not upload information you are not authorized to share.</p><h2>Contact</h2><p>Questions: hello@goodcartday.com.</p></main>;
}
