import type { Metadata } from "next";
import { BasketSenseDashboard } from "./basket-sense-dashboard";
import { buildDashboardViewData } from "./basketsense-dashboard-data";
import { requireChatGPTUser } from "./chatgpt-auth";

export const metadata: Metadata = {
  title: "BasketSense — Our Costco companion",
  description:
    "A private household dashboard for understanding Costco trips, planning Saturday, and learning what is worth buying again.",
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
