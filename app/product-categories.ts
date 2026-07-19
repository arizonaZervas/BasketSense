import type { ReceiptCategory, TaxStatus } from "./basketsense-data";

export type ProductCategoryKey =
  | "groceries_beverages"
  | "clothing_accessories"
  | "household_supplies"
  | "health_personal_care"
  | "home_kitchen_seasonal"
  | "toys_books_activities"
  | "fuel"
  | "optical_services"
  | "needs_review";

export type ClassificationStatus =
  | "reviewed"
  | "rule_based"
  | "needs_review";

export const PRODUCT_CATEGORY_PRESENTATION = [
  {
    key: "groceries_beverages",
    label: "Groceries & beverages",
    shortLabel: "Groceries",
    color: "var(--forest)",
  },
  {
    key: "clothing_accessories",
    label: "Clothing & accessories",
    shortLabel: "Clothing",
    color: "var(--apricot)",
  },
  {
    key: "household_supplies",
    label: "Household supplies & cleaning",
    shortLabel: "Household",
    color: "var(--sky)",
  },
  {
    key: "health_personal_care",
    label: "Health, beauty & personal care",
    shortLabel: "Health & care",
    color: "var(--lilac)",
  },
  {
    key: "home_kitchen_seasonal",
    label: "Home, kitchen & seasonal",
    shortLabel: "Home & kitchen",
    color: "var(--sand)",
  },
  {
    key: "toys_books_activities",
    label: "Toys, books & activities",
    shortLabel: "Toys & books",
    color: "var(--rose)",
  },
  {
    key: "fuel",
    label: "Fuel",
    shortLabel: "Fuel",
    color: "var(--slate)",
  },
  {
    key: "optical_services",
    label: "Optical & services",
    shortLabel: "Optical",
    color: "var(--plum)",
  },
  {
    key: "needs_review",
    label: "Needs review",
    shortLabel: "Needs review",
    color: "var(--review)",
  },
] as const satisfies readonly {
  key: ProductCategoryKey;
  label: string;
  shortLabel: string;
  color: string;
}[];

const CATEGORY_BY_ITEM_NUMBER: Readonly<Record<string, ProductCategoryKey>> = {
  // High-value abbreviations reviewed against the receipt image/data audit.
  "2990": "groceries_beverages",
  "782796": "groceries_beverages",
  "891742": "groceries_beverages",
  "1925833": "groceries_beverages",
  "2022263": "groceries_beverages",
  // These abbreviations otherwise collide with broad apparel/health tokens:
  // PSTOPSTASLD contains "TOP" and FRITOLAY contains "OLAY".
  "14110": "groceries_beverages",
  "188140": "groceries_beverages",
  "1935002": "household_supplies",
  "1725952": "household_supplies",
  "1739998": "household_supplies",
  "1919326": "household_supplies",
  "1963239": "household_supplies",
  "2700048": "household_supplies",
  "2727590": "household_supplies",
  "3247022": "household_supplies",
  "4165769": "household_supplies",
  "5161251": "household_supplies",
  "5247022": "household_supplies",
  "870735": "health_personal_care",
  "1129909": "health_personal_care",
  "1257371": "health_personal_care",
  "1285702": "health_personal_care",
  "1689295": "health_personal_care",
  "1737189": "health_personal_care",
  "1806649": "health_personal_care",
  "1861502": "health_personal_care",
  "1917654": "health_personal_care",
  "1928295": "health_personal_care",
  "1948682": "health_personal_care",
  "1966263": "health_personal_care",
  "2021189": "health_personal_care",
  "1600273": "home_kitchen_seasonal",
  "1796258": "home_kitchen_seasonal",
  "1796303": "home_kitchen_seasonal",
  "1796314": "home_kitchen_seasonal",
  "1825596": "home_kitchen_seasonal",
  "1851163": "home_kitchen_seasonal",
  "1900505": "home_kitchen_seasonal",
  "1901810": "home_kitchen_seasonal",
  "1959031": "home_kitchen_seasonal",
  "1973216": "home_kitchen_seasonal",
  "2004991": "home_kitchen_seasonal",
  "2031674": "home_kitchen_seasonal",
  "1784848": "toys_books_activities",
  "1806393": "toys_books_activities",
  "1851481": "toys_books_activities",
  "1851573": "toys_books_activities",
  "1851588": "toys_books_activities",
  "1851658": "toys_books_activities",
  "2016761": "toys_books_activities",
  "2056026": "toys_books_activities",
  // Receipt abbreviations that were manually resolved as apparel/accessories.
  "1359296": "clothing_accessories",
  "1471275": "clothing_accessories",
  "1564302": "clothing_accessories",
  "1673236": "clothing_accessories",
  "1741596": "clothing_accessories",
  "1748375": "clothing_accessories",
  "1816344": "clothing_accessories",
  "1816488": "clothing_accessories",
  "1851746": "clothing_accessories",
  "1859936": "clothing_accessories",
  "1863710": "clothing_accessories",
  "1864954": "clothing_accessories",
  "1868328": "clothing_accessories",
  "1873251": "clothing_accessories",
  "1875357": "clothing_accessories",
  "1878619": "clothing_accessories",
  "1899482": "clothing_accessories",
  "1902104": "clothing_accessories",
  "1906572": "clothing_accessories",
  "1906573": "clothing_accessories",
  "1908050": "clothing_accessories",
  "1934932": "clothing_accessories",
  "1934959": "clothing_accessories",
  "1943125": "clothing_accessories",
  "1951107": "clothing_accessories",
  "1953511": "clothing_accessories",
  "1954382": "clothing_accessories",
  "1955377": "clothing_accessories",
  "1955429": "clothing_accessories",
  "1955439": "clothing_accessories",
  "1957651": "clothing_accessories",
  "1957935": "clothing_accessories",
  "1959114": "clothing_accessories",
  "1960112": "clothing_accessories",
  "1961236": "clothing_accessories",
  "1961564": "clothing_accessories",
  "1961924": "clothing_accessories",
  "1962938": "clothing_accessories",
  // "THMENSCREW" strongly resembles apparel, but the exact SKU has not been
  // resolved to a product. Keep its dollars visible without treating it as
  // reviewed apparel.
  "1965987": "needs_review",
  "1966621": "clothing_accessories",
  "1966645": "clothing_accessories",
  "1967472": "clothing_accessories",
  "1969316": "clothing_accessories",
  "1970146": "clothing_accessories",
  "1970722": "clothing_accessories",
  "1970817": "clothing_accessories",
  "1974258": "clothing_accessories",
  "1974728": "clothing_accessories",
  "1536795": "clothing_accessories",
  "1573805": "clothing_accessories",
  "1589403": "clothing_accessories",
  "1608541": "clothing_accessories",
  "1723798": "clothing_accessories",
  "1768123": "clothing_accessories",
  "1819385": "clothing_accessories",
  "1852806": "clothing_accessories",
  "1854625": "clothing_accessories",
  "7772005": "clothing_accessories",
};

const APPAREL_PATTERN =
  /(?:PANT|JGR|JOGGER|CREW|SWEAT|TEE|SHIRT|POLO|JEAN|TOP|DRESS|HOODIE|V-?NECK|BIKINI|BOXBRIEF|SWIM|\bPJ\b|GOWN|TANK|LEGGING|SHORT|TUTU|1\/4ZIP|1\/2ZIP|KIDS.*SET|KIDS.*TEE)/i;
const HOUSEHOLD_PATTERN =
  /(?:TIDE|CASCADE|BOUNTY|TISSUE|AIRWICK|UNSTPBL|LAUNDRY|DETERGENT|DISHWASH|PAPER TOWEL|TRASH BAG|WRAP 3PK)/i;
const HEALTH_PATTERN =
  /(?:MULTI|VITAMIN|LAX|OLAY|AVEENO|NEUTROGENA|HYDRO BOOST|TOOTH|TBRUSH|BODY WASH|\bDOVE\b|AG1|SUPPLEMENT)/i;
const HOME_PATTERN =
  /(?:TUPPERWARE|FLATWARE|BATH MAT|TOWEL|BLANKET|BLNKT|CANDLE|FLOOR|TOOLS?|MICROFBR|PILLOW|GREENMADE)/i;
const TOYS_PATTERN =
  /(?:BUBBLE BLAST|HUGALUMPS|PAINT SET|FOAM BLASTER|ACTIVITY|PANORAMA|20PC BUCKET|BOB REUSE|\bBOOK\b)/i;
const TAXABLE_GROCERY_PATTERN =
  /(?:COKE|WATER|WTR40|ENERGY12|CHI ?FOREST|HONEST K)/i;

export function categoryPresentation(key: ProductCategoryKey) {
  return (
    PRODUCT_CATEGORY_PRESENTATION.find((category) => category.key === key) ??
    PRODUCT_CATEGORY_PRESENTATION.at(-1)!
  );
}

export function classifyReceiptItem(input: {
  channel: ReceiptCategory;
  itemNumber: string;
  rawDescription: string;
  canonicalName: string;
  taxStatus: TaxStatus;
}): { key: ProductCategoryKey; status: ClassificationStatus } {
  if (input.channel === "gas") {
    return { key: "fuel", status: "reviewed" };
  }
  if (input.channel === "optical") {
    return { key: "optical_services", status: "reviewed" };
  }

  const reviewed = CATEGORY_BY_ITEM_NUMBER[input.itemNumber];
  if (reviewed) {
    return {
      key: reviewed,
      status: reviewed === "needs_review" ? "needs_review" : "reviewed",
    };
  }

  const text = `${input.rawDescription} ${input.canonicalName}`;
  if (APPAREL_PATTERN.test(text)) {
    return { key: "clothing_accessories", status: "rule_based" };
  }
  if (HOUSEHOLD_PATTERN.test(text)) {
    return { key: "household_supplies", status: "rule_based" };
  }
  if (HEALTH_PATTERN.test(text)) {
    return { key: "health_personal_care", status: "rule_based" };
  }
  if (HOME_PATTERN.test(text)) {
    return { key: "home_kitchen_seasonal", status: "rule_based" };
  }
  if (TOYS_PATTERN.test(text)) {
    return { key: "toys_books_activities", status: "rule_based" };
  }
  if (input.taxStatus === "non_taxable" || TAXABLE_GROCERY_PATTERN.test(text)) {
    return { key: "groceries_beverages", status: "rule_based" };
  }
  return { key: "needs_review", status: "needs_review" };
}
