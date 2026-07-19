import type { Metadata } from "next";
import { BasketSenseDashboard } from "./basket-sense-dashboard";
import { buildDashboardViewData } from "./basketsense-dashboard-data";
import { requireChatGPTUser } from "./chatgpt-auth";

export const metadata: Metadata = {
  title: "BasketSense — Our Costco companion",
  description:
    "A private household dashboard for understanding Costco trips, planning Saturday, and learning what is worth buying again.",
  openGraph: {
    title: "BasketSense",
    description: "Our Costco companion",
    type: "website",
    images: [
      {
        url: "/basketsense-social-card.png",
        width: 1200,
        height: 630,
        alt: "BasketSense — Our Costco companion",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "BasketSense",
    description: "Our Costco companion",
    images: ["/basketsense-social-card.png"],
  },
};

export default async function Home() {
  const user = await requireChatGPTUser("/");
  const viewData = buildDashboardViewData();

  return (
    <BasketSenseDashboard
      user={{ displayName: user.displayName, email: user.email }}
      viewData={viewData}
    />
  );
}
