import type { Metadata } from "next";
import { headers } from "next/headers";
import "./marketing.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "goodcartday.com";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: "Good Cart Day — Came for milk?",
    description: "A private, shared household companion for the weekly Costco trip.",
    robots: { index: true, follow: true },
    openGraph: { title: "Came for milk. Left with a $400 cart?", description: "Plan the trip. Keep the treasure hunt.", type: "website", images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Good Cart Day shared-list illustration" }] },
    twitter: { card: "summary_large_image", title: "Came for milk. Left with a $400 cart?", description: "Plan the trip. Keep the treasure hunt.", images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
