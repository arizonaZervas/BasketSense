import Link from "next/link";

export const metadata = { title: "Privacy — Good Cart Day" };

export default function PrivacyPage() {
  return <main className="gcd-legal"><Link href="/">← Good Cart Day</Link><h1>Privacy</h1><p>Good Cart Day is a household-private planning tool. We collect a beta-interest email only with your explicit consent; it does not create an account or household.</p><h2>Product data</h2><p>When invited, receipt records and uploaded images are private to the authorized household. We do not collect Costco credentials, automate Costco sign-in, sell household purchase history, or create public spending dashboards.</p><h2>Your choices</h2><p>Beta data export and deletion controls are being completed before households beyond the private test are admitted. Until then, email privacy@goodcartday.com to request beta-interest deletion.</p><h2>Contact</h2><p>Questions: privacy@goodcartday.com.</p></main>;
}
