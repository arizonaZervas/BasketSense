import { BasketSenseDashboard } from "../basket-sense-dashboard";
import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";
import { emptyDashboardViewData } from "../empty-dashboard-view";

export default async function RecapPage() {
  const user = await requireChatGPTUser("/recap");
  const viewData = emptyDashboardViewData();

  return (
    <BasketSenseDashboard
      user={{ displayName: user.displayName, email: user.email }}
      viewData={viewData}
      signOutHref={chatGPTSignOutPath("/recap")}
      initialTab="review"
    />
  );
}
