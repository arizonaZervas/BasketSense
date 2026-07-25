import { MarketingPage } from "./marketing-page";

export default function Page() {
  return <MarketingPage turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />;
}
