import type { Metadata } from "next";
import { BasketSenseDashboard } from "./basket-sense-dashboard";

export const metadata: Metadata = {
  title: "BasketSense — Our Costco companion",
  description:
    "A private household dashboard for understanding Costco trips, planning Saturday, and learning what is worth buying again.",
};

export default function Home() {
  return <BasketSenseDashboard />;
}
