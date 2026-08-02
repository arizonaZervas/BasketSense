import { buildDashboardViewData } from "./basketsense-dashboard-data";
import { generatedProductIllustration } from "./generated-product-illustrations";

export const PRODUCT_ILLUSTRATION_PROMPT_VERSION = "warm-editorial-v1";

export type ProductIllustrationManifestEntry = {
  itemNumber: string;
  productName: string;
  promptVersion: typeof PRODUCT_ILLUSTRATION_PROMPT_VERSION;
  generatedAssetPath: string | null;
  acceptanceStatus: "accepted" | "pending" | "excluded";
  errorState: null;
  retryCount: number;
};

// The signed-in household gained these receipt-backed products after the
// checked-in history fixture. Keeping this small live delta explicit lets the
// production worklist mirror the 272 Products-tab entries until the fixture is
// refreshed from D1.
const LIVE_PRODUCTS_ADDED_AFTER_HISTORY_FIXTURE = [
  // The live Products view currently contains a second IQ BAR VRTY row for
  // the same item number. It intentionally remains a separate manifest entry:
  // one illustration resolves both rows, while the checkpoint still mirrors
  // every visible Products-tab row.
  ["1788968", "IQ BAR VRTY"],
  ["1796317", "Accent rug"],
  ["1966432", "Apparel blouse"],
  ["1973589", "Basmati rice"],
  ["2060112", "Book sticker"],
  ["0000", "Discounts"],
  ["283169", "Fresh roses"],
  ["1925186", "Jojo’s chocolate"],
  ["1638461", "Organic smoothie"],
  ["1875256", "Peanut butter granola"],
  ["1664090", "Pekkle four-pack T-shirts"],
  ["2068175", "Mango tapioca"],
  ["1847239", "Suja digestion shots"],
] as const;

export function productIllustrationManifest(): readonly ProductIllustrationManifestEntry[] {
  return [
    ...buildDashboardViewData().products.map((product) => [
      product.itemNumber,
      product.name,
    ] as const),
    ...LIVE_PRODUCTS_ADDED_AFTER_HISTORY_FIXTURE,
  ]
    .sort(
      ([firstItemNumber, firstName], [secondItemNumber, secondName]) =>
        firstItemNumber.localeCompare(secondItemNumber, undefined, { numeric: true }) ||
        firstName.localeCompare(secondName),
    )
    .map(([itemNumber, productName]) => {
      const generated = generatedProductIllustration(itemNumber);
      const isDiscountAdjustment = itemNumber === "0000";
      return {
        itemNumber,
        productName,
        promptVersion: PRODUCT_ILLUSTRATION_PROMPT_VERSION,
        generatedAssetPath: generated?.imageUrl ?? null,
        acceptanceStatus: isDiscountAdjustment
          ? "excluded"
          : generated
            ? "accepted"
            : "pending",
        errorState: null,
        retryCount: 0,
      };
    });
}
