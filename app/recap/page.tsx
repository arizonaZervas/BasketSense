import { BasketSenseDashboard } from "../basket-sense-dashboard";
import { buildDashboardViewData } from "../basketsense-dashboard-data";
import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";

export default async function RecapPage() {
  const user = await requireChatGPTUser("/recap");
  const viewData = buildDashboardViewData();

  return (
    <BasketSenseDashboard
      user={{ displayName: user.displayName, email: user.email }}
      viewData={viewData}
      signOutHref={chatGPTSignOutPath("/recap")}
      initialTab="review"
    />
  );
}
