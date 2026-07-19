/**
 * Sanitized, audited Costco receipt facts through 2026-07-18.
 *
 * Money is stored as integer cents. These records intentionally exclude member
 * numbers, payment details, raw receipt identifiers, source paths, and location
 * coordinates. Internal IDs are deterministic labels created for BasketSense.
 */

export type ReceiptCategory = "warehouse" | "gas" | "optical";
export type TaxStatus = "taxable" | "non_taxable";
export type AuditFlag =
  | "none"
  | "external_funding_split"
  | "page_overlap_deduped"
  | "photo_value_inferred";

export type ReceiptTransactionSeed = {
  id: string;
  purchasedOn: string;
  category: ReceiptCategory;
  sourceType: "digital_receipt" | "fuel_receipt" | "receipt_photo";
  itemGrossCents: number;
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  receiptTotalCents: number;
  householdFundedCents: number;
  externalFundingCents: number;
  itemCount: number;
  auditFlag: AuditFlag;
};

export type ReceiptItemSeed = {
  id: string;
  transactionId: string;
  itemNumber: string;
  rawDescription: string;
  canonicalName: string;
  normalizationStatus: "receipt_abbreviation" | "normalized_from_history";
  quantity: number;
  unitPriceCents: number | null;
  unitPriceMills: number | null;
  grossAmountCents: number;
  discountCents: number;
  netAmountCents: number;
  taxStatus: TaxStatus;
};

type TransactionRow = readonly [
  id: string,
  purchasedOn: string,
  category: ReceiptCategory,
  sourceType: ReceiptTransactionSeed["sourceType"],
  itemGrossCents: number,
  discountCents: number,
  subtotalCents: number,
  taxCents: number,
  receiptTotalCents: number,
  householdFundedCents: number,
  externalFundingCents: number,
  itemCount: number,
  auditFlag: AuditFlag,
];

const transactionRows = [
  ["optical-2026-01-02-1", "2026-01-02", "optical", "digital_receipt", 46_096, 5_000, 41_096, 0, 41_096, 3_699, 37_397, 4, "external_funding_split"],
  ["optical-2026-01-02-2", "2026-01-02", "optical", "digital_receipt", 44_096, 5_000, 39_096, 0, 39_096, 1_700, 37_396, 4, "external_funding_split"],
  ["warehouse-2026-01-10", "2026-01-10", "warehouse", "digital_receipt", 26_996, 2_550, 24_446, 824, 25_270, 25_270, 0, 22, "none"],
  ["warehouse-2026-01-17", "2026-01-17", "warehouse", "digital_receipt", 27_855, 4_260, 23_595, 847, 24_442, 24_442, 0, 15, "none"],
  ["warehouse-2026-01-24", "2026-01-24", "warehouse", "digital_receipt", 17_067, 550, 16_517, 584, 17_101, 17_101, 0, 17, "none"],
  ["warehouse-2026-01-26", "2026-01-26", "warehouse", "digital_receipt", 10_194, 2_250, 7_944, 407, 8_351, 8_351, 0, 6, "none"],
  ["warehouse-2026-01-31", "2026-01-31", "warehouse", "digital_receipt", 26_151, 2_340, 23_811, 573, 24_384, 24_384, 0, 17, "none"],
  ["warehouse-2026-02-07", "2026-02-07", "warehouse", "digital_receipt", 21_603, 1_400, 20_203, 197, 20_400, 20_400, 0, 17, "none"],
  ["gas-2026-02-07", "2026-02-07", "gas", "fuel_receipt", 5_594, 0, 5_594, 0, 5_594, 5_594, 0, 1, "none"],
  ["warehouse-2026-02-14", "2026-02-14", "warehouse", "digital_receipt", 24_612, 1_630, 22_982, 272, 23_254, 23_254, 0, 19, "none"],
  ["warehouse-2026-02-21", "2026-02-21", "warehouse", "digital_receipt", 11_361, 750, 10_611, 0, 10_611, 10_611, 0, 9, "none"],
  ["warehouse-2026-02-28", "2026-02-28", "warehouse", "digital_receipt", 24_859, 1_150, 23_709, 513, 24_222, 24_222, 0, 19, "none"],
  ["warehouse-2026-03-07", "2026-03-07", "warehouse", "digital_receipt", 18_522, 1_540, 16_982, 294, 17_276, 17_276, 0, 16, "none"],
  ["warehouse-2026-03-14", "2026-03-14", "warehouse", "digital_receipt", 24_551, 1_650, 22_901, 449, 23_350, 23_350, 0, 20, "none"],
  ["warehouse-2026-03-21", "2026-03-21", "warehouse", "digital_receipt", 24_090, 2_100, 21_990, 584, 22_574, 22_574, 0, 20, "none"],
  ["gas-2026-03-21", "2026-03-21", "gas", "fuel_receipt", 5_408, 0, 5_408, 0, 5_408, 5_408, 0, 1, "none"],
  ["warehouse-2026-03-28", "2026-03-28", "warehouse", "digital_receipt", 15_586, 1_240, 14_346, 261, 14_607, 14_607, 0, 15, "none"],
  ["warehouse-2026-04-04", "2026-04-04", "warehouse", "digital_receipt", 25_748, 2_200, 23_548, 813, 24_361, 24_361, 0, 20, "none"],
  ["warehouse-2026-04-11", "2026-04-11", "warehouse", "digital_receipt", 21_559, 1_650, 19_909, 762, 20_671, 20_671, 0, 19, "none"],
  ["warehouse-2026-04-19", "2026-04-19", "warehouse", "digital_receipt", 23_851, 2_120, 21_731, 849, 22_580, 22_580, 0, 20, "none"],
  ["warehouse-2026-04-25", "2026-04-25", "warehouse", "digital_receipt", 20_995, 1_300, 19_695, 1_208, 20_903, 20_903, 0, 14, "none"],
  ["gas-2026-05-06", "2026-05-06", "gas", "fuel_receipt", 6_357, 0, 6_357, 0, 6_357, 6_357, 0, 1, "none"],
  ["warehouse-2026-05-09", "2026-05-09", "warehouse", "digital_receipt", 12_570, 0, 12_570, 0, 12_570, 12_570, 0, 10, "none"],
  ["gas-2026-05-09", "2026-05-09", "gas", "fuel_receipt", 7_441, 0, 7_441, 0, 7_441, 7_441, 0, 1, "none"],
  ["warehouse-2026-05-16", "2026-05-16", "warehouse", "digital_receipt", 26_599, 1_170, 25_429, 853, 26_282, 26_282, 0, 21, "none"],
  ["warehouse-2026-05-23", "2026-05-23", "warehouse", "digital_receipt", 25_291, 3_480, 21_811, 647, 22_458, 22_458, 0, 19, "none"],
  ["gas-2026-05-23", "2026-05-23", "gas", "fuel_receipt", 5_139, 0, 5_139, 0, 5_139, 5_139, 0, 1, "none"],
  ["warehouse-2026-05-30", "2026-05-30", "warehouse", "digital_receipt", 18_623, 800, 17_823, 647, 18_470, 18_470, 0, 16, "none"],
  ["warehouse-2026-06-06", "2026-06-06", "warehouse", "digital_receipt", 25_280, 3_310, 21_970, 663, 22_633, 22_633, 0, 19, "none"],
  ["warehouse-2026-06-13", "2026-06-13", "warehouse", "digital_receipt", 9_842, 1_000, 8_842, 292, 9_134, 9_134, 0, 8, "none"],
  ["warehouse-2026-06-15", "2026-06-15", "warehouse", "digital_receipt", 14_881, 2_490, 12_391, 458, 12_849, 12_849, 0, 9, "none"],
  ["warehouse-2026-06-20", "2026-06-20", "warehouse", "digital_receipt", 25_862, 2_450, 23_412, 433, 23_845, 23_845, 0, 18, "none"],
  ["gas-2026-06-20", "2026-06-20", "gas", "fuel_receipt", 5_848, 0, 5_848, 0, 5_848, 5_848, 0, 1, "none"],
  ["warehouse-2026-06-27", "2026-06-27", "warehouse", "digital_receipt", 23_528, 2_100, 21_428, 897, 22_325, 22_325, 0, 18, "page_overlap_deduped"],
  ["warehouse-2026-07-03", "2026-07-03", "warehouse", "digital_receipt", 19_614, 2_600, 17_014, 489, 17_503, 17_503, 0, 16, "none"],
  ["gas-2026-07-03", "2026-07-03", "gas", "fuel_receipt", 4_196, 0, 4_196, 0, 4_196, 4_196, 0, 1, "none"],
  ["warehouse-2026-07-12", "2026-07-12", "warehouse", "digital_receipt", 19_005, 1_620, 17_385, 355, 17_740, 17_740, 0, 15, "none"],
  ["warehouse-2026-07-18", "2026-07-18", "warehouse", "receipt_photo", 20_990, 800, 20_190, 584, 20_774, 20_774, 0, 20, "photo_value_inferred"],
] as const satisfies readonly TransactionRow[];

export const AUDITED_RECEIPT_TRANSACTIONS_2026: readonly ReceiptTransactionSeed[] =
  transactionRows.map((row) => ({
    id: row[0],
    purchasedOn: row[1],
    category: row[2],
    sourceType: row[3],
    itemGrossCents: row[4],
    discountCents: row[5],
    subtotalCents: row[6],
    taxCents: row[7],
    receiptTotalCents: row[8],
    householdFundedCents: row[9],
    externalFundingCents: row[10],
    itemCount: row[11],
    auditFlag: row[12],
  }));

type ItemRow = readonly [
  transactionId: string,
  itemNumber: string,
  rawDescription: string,
  quantity: number,
  grossAmountCents: number,
  discountCents: number,
  taxStatus: TaxStatus,
  unitPriceMills?: number,
];

const itemRows: ItemRow[] = [
  ["optical-2026-01-02-1", "620538", "SV PLY PLZGN", 1, 7_499, 5_000, "non_taxable"],
  ["optical-2026-01-02-1", "1898338", "GIL", 1, 9_999, 0, "non_taxable"],
  ["optical-2026-01-02-1", "1975748", "GG1734OK", 1, 21_999, 0, "non_taxable"],
  ["optical-2026-01-02-1", "1418601", "SV 1.60CLEAR", 1, 6_599, 0, "non_taxable"],
  ["optical-2026-01-02-2", "1975681", "GG1340O", 1, 19_999, 0, "non_taxable"],
  ["optical-2026-01-02-2", "1418601", "SV 1.60CLEAR", 1, 6_599, 0, "non_taxable"],
  ["optical-2026-01-02-2", "106443", "SV PLY PLZ G", 1, 7_499, 5_000, "non_taxable"],
  ["optical-2026-01-02-2", "1903494", "K3008", 1, 9_999, 0, "non_taxable"],

  ["warehouse-2026-01-10", "1984805", "RASP JAM", 1, 889, 0, "non_taxable"],
  ["warehouse-2026-01-10", "939542", "ORGFRNCHBEAN", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-01-10", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-01-10", "870735", "KS ADLT MULT", 1, 1_149, 250, "taxable"],
  ["warehouse-2026-01-10", "1025795", "KS 5DZ EGGS", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-01-10", "1465518", "SUJA GINGER", 1, 1_299, 0, "non_taxable"],
  ["warehouse-2026-01-10", "156303", "ORG GOLDKIWI", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-01-10", "1892940", "SGSY SHOTS", 1, 1_299, 300, "non_taxable"],
  ["warehouse-2026-01-10", "720650", "MINI CUKES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-01-10", "532683", "GINGER", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-01-10", "1801", "MANDARINS", 1, 479, 0, "non_taxable"],
  ["warehouse-2026-01-10", "1934959", "BONDED PANT", 1, 1_699, 300, "taxable"],
  ["warehouse-2026-01-10", "1899482", "32D TECH JGR", 1, 997, 0, "taxable"],
  ["warehouse-2026-01-10", "1725952", "**KS ULTRA**", 1, 2_199, 0, "taxable"],
  ["warehouse-2026-01-10", "2990", "ORG HONEST K", 1, 1_389, 0, "taxable"],
  ["warehouse-2026-01-10", "1472774", "ORG FRT BAR", 1, 1_399, 0, "non_taxable"],
  ["warehouse-2026-01-10", "2727590", "CASCADE PLUS", 1, 2_549, 500, "taxable"],
  ["warehouse-2026-01-10", "1920008", "CHBNI20G16CT", 1, 1_799, 600, "non_taxable"],
  ["warehouse-2026-01-10", "1934932", "SPYDER CREW", 1, 1_799, 300, "taxable"],
  ["warehouse-2026-01-10", "1537922", "AMARA MELTS", 1, 1_259, 300, "non_taxable"],
  ["warehouse-2026-01-10", "5063", "BART PEARS", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-10", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],

  ["warehouse-2026-01-17", "1954681", "NURRISTRAWB", 1, 1_999, 500, "non_taxable"],
  ["warehouse-2026-01-17", "1862839", "NURRICHOC", 1, 1_999, 500, "non_taxable"],
  ["warehouse-2026-01-17", "5063", "BART PEARS", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-17", "1917654", "AG1GREENS", 1, 7_299, 1_000, "taxable"],
  ["warehouse-2026-01-17", "882073", "100% WHEAT", 1, 729, 0, "non_taxable"],
  ["warehouse-2026-01-17", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-01-17", "38742", "SWEET CORN", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-01-17", "1388332", "COCONUT ROLL", 1, 859, 260, "non_taxable"],
  ["warehouse-2026-01-17", "1967470", "LIVSFVARIETY", 1, 2_899, 800, "non_taxable"],
  ["warehouse-2026-01-17", "57554", "BLUEBERRIES", 1, 549, 0, "non_taxable"],
  ["warehouse-2026-01-17", "1449725", "LOW CARB KET", 1, 1_399, 400, "non_taxable"],
  ["warehouse-2026-01-17", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-17", "7113", "LYCHEE", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-01-17", "891742", "COKEZERO35**", 1, 1_929, 0, "taxable"],
  ["warehouse-2026-01-17", "1900505", "NORSK6PKFLR", 1, 3_299, 800, "taxable"],

  ["warehouse-2026-01-24", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-01-24", "1589467", "DOSA BATTER", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-01-24", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-24", "38175", "CARA ORANGES", 1, 699, 150, "non_taxable"],
  ["warehouse-2026-01-24", "7113", "LYCHEE", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-01-24", "1796303", "BATH MAT", 1, 1_599, 0, "taxable"],
  ["warehouse-2026-01-24", "38742", "SWEET CORN", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-01-24", "1943125", "GAP LOGO TEE", 1, 999, 0, "taxable"],
  ["warehouse-2026-01-24", "47825", "GREEN GRAPES", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-01-24", "1902104", "BUFFALOVNECK", 1, 697, 0, "taxable"],
  ["warehouse-2026-01-24", "1816488", "TBAKER1/4ZIP", 1, 1_697, 0, "taxable"],
  ["warehouse-2026-01-24", "1816344", "PKKL 3PK TOP", 1, 1_799, 400, "taxable"],
  ["warehouse-2026-01-24", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-01-24", "1819385", "WOMENS GLOVE", 1, 997, 0, "taxable"],
  ["warehouse-2026-01-24", "2251987", "ORG HUMMUS", 1, 589, 0, "non_taxable"],
  ["warehouse-2026-01-24", "1935800", "PITA BREAD", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-24", "77053", "GRAPE TOMATO", 1, 849, 0, "non_taxable"],

  ["warehouse-2026-01-26", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-26", "1955377", "CKDNECK", 1, 2_799, 800, "taxable"],
  ["warehouse-2026-01-26", "1257371", "OLAY ULTRA", 1, 1_599, 450, "taxable"],
  ["warehouse-2026-01-26", "1935800", "PITA BREAD", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-01-26", "1896154", "BAKED 30 CT", 1, 1_899, 500, "non_taxable"],
  ["warehouse-2026-01-26", "1741596", "EB MENS JEAN", 1, 2_499, 500, "taxable"],

  ["warehouse-2026-01-31", "1966263", "OLAYRETINOL", 1, 4_499, 1_000, "taxable"],
  ["warehouse-2026-01-31", "1993845", "CUMIN SEED", 1, 1_269, 0, "non_taxable"],
  ["warehouse-2026-01-31", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-01-31", "3247022", "TIDE OXIPODS", 1, 2_699, 540, "taxable"],
  ["warehouse-2026-01-31", "2251987", "ORG HUMMUS", 1, 589, 0, "non_taxable"],
  ["warehouse-2026-01-31", "1789247", "KS OLIVE OIL", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-01-31", "1347776", "KS WD FL HNY", 1, 1_299, 0, "non_taxable"],
  ["warehouse-2026-01-31", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-01-31", "1172471", "IRISH BUTTER", 1, 1_699, 0, "non_taxable"],
  ["warehouse-2026-01-31", "1025795", "KS 5DZ EGGS", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-01-31", "14110", "PSTOPSTASLD", 1, 1_977, 0, "non_taxable"],
  ["warehouse-2026-01-31", "38175", "CARA ORANGES", 1, 779, 0, "non_taxable"],
  ["warehouse-2026-01-31", "5161251", "UNSTPBL FRSH", 1, 1_999, 400, "taxable"],
  ["warehouse-2026-01-31", "1989442", "BR PASTA", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-01-31", "897971", "KS APPLESAU", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-01-31", "7923", "4LB OG HONEY", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-01-31", "1465518", "SUJA GINGER", 1, 1_299, 400, "non_taxable"],

  ["warehouse-2026-02-07", "5938", "POTATOES", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-02-07", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1552971", "OATNUT", 1, 729, 0, "non_taxable"],
  ["warehouse-2026-02-07", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1833829", "CHILI CRUNCH", 1, 1_589, 0, "non_taxable"],
  ["warehouse-2026-02-07", "2700048", "TIDEF&GPOD", 1, 3_099, 600, "taxable"],
  ["warehouse-2026-02-07", "1014809", "KS PRTN BAR", 1, 2_299, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1851141", "BUILTBAR", 1, 1_999, 400, "non_taxable"],
  ["warehouse-2026-02-07", "7113", "LYCHEE", 2, 2_398, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-02-07", "2534", "CHERRIES", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1380620", "ORGANIC OATS", 1, 949, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1344", "ROMA TOMATO", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1550956", "PANEER CHEES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1392843", "AVOCA SPRAY", 1, 1_399, 0, "non_taxable"],
  ["warehouse-2026-02-07", "1465518", "SUJA GINGER", 1, 1_299, 400, "non_taxable"],
  ["gas-2026-02-07", "fuel-regular", "REGULAR", 14.497, 5_594, 0, "non_taxable", 3_859],

  ["warehouse-2026-02-14", "7099", "PITTED DATES", 1, 1_199, 200, "non_taxable"],
  ["warehouse-2026-02-14", "1048072", "GREEK YOGURT", 1, 749, 0, "non_taxable"],
  ["warehouse-2026-02-14", "2011219", "EGGO PROTEIN", 1, 1_299, 0, "non_taxable"],
  ["warehouse-2026-02-14", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-14", "1780375", "KS WHEY 25G", 1, 4_999, 0, "non_taxable"],
  ["warehouse-2026-02-14", "38175", "CARA ORANGES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-14", "7113", "LYCHEE", 2, 1_998, 0, "non_taxable"],
  ["warehouse-2026-02-14", "1960946", "ONLY BEAN", 1, 879, 280, "non_taxable"],
  ["warehouse-2026-02-14", "1465518", "SUJA GINGER", 1, 1_299, 400, "non_taxable"],
  ["warehouse-2026-02-14", "289660", "COTTAGE CHSE", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-02-14", "1257371", "OLAY ULTRA", 1, 1_599, 450, "taxable"],
  ["warehouse-2026-02-14", "1582922", "KS ORG GHEE", 1, 2_199, 0, "non_taxable"],
  ["warehouse-2026-02-14", "1906573", "SAGE JOGGER", 1, 1_000, 0, "taxable"],
  ["warehouse-2026-02-14", "1935800", "PITA BREAD", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-14", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-02-14", "1608541", "4PC PJ SET", 1, 1_599, 300, "taxable"],
  ["warehouse-2026-02-14", "57554", "BLUEBERRIES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-02-14", "6021", "PREM. PLUMS", 1, 699, 0, "non_taxable"],

  ["warehouse-2026-02-21", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-02-21", "27003", "STRAWBERRIES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-02-21", "1068083", "ORG FR EGGS", 1, 769, 0, "non_taxable"],
  ["warehouse-2026-02-21", "30669", "BANANAS", 1, 199, 0, "non_taxable"],
  ["warehouse-2026-02-21", "1617506", "KS ORG CSHW", 1, 1_749, 0, "non_taxable"],
  ["warehouse-2026-02-21", "555000", "KS PNUT BUTR", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-02-21", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-21", "1998642", "OIKOSCHSHAKE", 1, 2_999, 750, "non_taxable"],
  ["warehouse-2026-02-21", "1076903", "PISTACHIO", 1, 1_799, 0, "non_taxable"],

  ["warehouse-2026-02-28", "531860", "DAHI YOGURT", 1, 839, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1204135", "ORGANIC TOFU", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1271446", "OIKOS ZERO", 1, 1_399, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1659424", "IMMUNE SHOT", 1, 1_539, 0, "non_taxable"],
  ["warehouse-2026-02-28", "38742", "SWEET CORN", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-02-28", "2254", "ORG MAND", 1, 579, 0, "non_taxable"],
  ["warehouse-2026-02-28", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1901772", "2PKCOMBO", 1, 1_899, 400, "taxable"],
  ["warehouse-2026-02-28", "1993851", "GR CUMIN", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1043723", "ORG MUNG DAL", 1, 1_599, 350, "non_taxable"],
  ["warehouse-2026-02-28", "1831841", "GOODLESPACK", 1, 1_599, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1600273", "MICROFBR MAT", 1, 1_399, 400, "taxable"],
  ["warehouse-2026-02-28", "882073", "100% WHEAT", 1, 729, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1935800", "PITA BREAD", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-02-28", "2251987", "ORG HUMMUS", 1, 589, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1825596", "TUPPERWARE32", 1, 3_997, 0, "taxable"],
  ["warehouse-2026-02-28", "7113", "LYCHEE", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-02-28", "1995349", "ORG PRESS", 1, 1_999, 0, "non_taxable"],

  ["warehouse-2026-03-07", "1851141", "BUILTBAR", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-03-07", "1659424", "IMMUNE SHOT", 1, 1_539, 450, "non_taxable"],
  ["warehouse-2026-03-07", "1985987", "SPRFRT GUMMY", 1, 1_359, 0, "non_taxable"],
  ["warehouse-2026-03-07", "7923", "4LB OG HONEY", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-03-07", "7113", "LYCHEE", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-03-07", "891742", "COKEZERO35**", 1, 1_929, 0, "taxable"],
  ["warehouse-2026-03-07", "1388332", "COCONUT ROLL", 1, 859, 0, "non_taxable"],
  ["warehouse-2026-03-07", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-03-07", "1878401", "WHEAT FLOUR", 1, 1_449, 290, "non_taxable"],
  ["warehouse-2026-03-07", "1560969", "MADEGOODMINI", 1, 1_199, 400, "non_taxable"],
  ["warehouse-2026-03-07", "1536795", "CHAR HOODIE", 1, 497, 0, "taxable"],
  ["warehouse-2026-03-07", "1068083", "ORG FR EGGS", 1, 769, 0, "non_taxable"],
  ["warehouse-2026-03-07", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-03-07", "2254", "ORG MAND", 1, 579, 0, "non_taxable"],
  ["warehouse-2026-03-07", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-03-07", "1960112", "KOALA 6PCSET", 1, 1_699, 400, "taxable"],

  ["warehouse-2026-03-14", "1097320", "PREMIER STRW", 1, 3_199, 800, "non_taxable"],
  ["warehouse-2026-03-14", "289660", "COTTAGE CHSE", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-03-14", "1995349", "ORG PRESS", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-03-14", "2003025", "SUPER VEGGIE", 1, 639, 0, "non_taxable"],
  ["warehouse-2026-03-14", "96716", "ORG SPINACH", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-03-14", "1550956", "PANEER CHEES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-03-14", "4165769", "KS3PLYTISSUE", 1, 1_599, 0, "taxable"],
  ["warehouse-2026-03-14", "1985987", "SPRFRT GUMMY", 1, 1_359, 0, "non_taxable"],
  ["warehouse-2026-03-14", "1906572", "SKCHRS1/2ZIP", 1, 1_000, 0, "taxable"],
  ["warehouse-2026-03-14", "1659424", "IMMUNE SHOT", 1, 1_539, 450, "non_taxable"],
  ["warehouse-2026-03-14", "57554", "BLUEBERRIES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-03-14", "38742", "SWEET CORN", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-03-14", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-03-14", "1966645", "THCREWSWEATS", 1, 1_999, 400, "taxable"],
  ["warehouse-2026-03-14", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-03-14", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-03-14", "2990", "ORG HONEST K", 1, 1_489, 0, "taxable"],
  ["warehouse-2026-03-14", "1700118", "BUTTER CUP", 1, 1_389, 0, "non_taxable"],
  ["warehouse-2026-03-14", "532683", "GINGER", 1, 849, 0, "non_taxable"],
  ["warehouse-2026-03-14", "1001368", "KS QUINOA", 1, 1_149, 0, "non_taxable"],

  ["warehouse-2026-03-21", "867221", "ORG STACY28Z", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1359296", "UV SWIM SET", 1, 1_799, 400, "taxable"],
  ["warehouse-2026-03-21", "1959031", "GREENMADE", 1, 999, 200, "taxable"],
  ["warehouse-2026-03-21", "1935800", "PITA BREAD", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-03-21", "2022263", "CHIFORESTVTY", 1, 1_799, 0, "taxable"],
  ["warehouse-2026-03-21", "1335089", "BAGELS", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1966645", "THCREWSWEATS", 1, 1_999, 400, "taxable"],
  ["warehouse-2026-03-21", "1659424", "IMMUNE SHOT", 1, 1_539, 450, "non_taxable"],
  ["warehouse-2026-03-21", "1560969", "MADEGOODMINI", 1, 1_199, 400, "non_taxable"],
  ["warehouse-2026-03-21", "1949713", "PROTEIN MIX", 1, 1_089, 250, "non_taxable"],
  ["warehouse-2026-03-21", "1851141", "BUILTBAR", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1946763", "KETOBREAD", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-03-21", "2254", "ORG MAND", 1, 479, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1985987", "SPRFRT GUMMY", 1, 1_359, 0, "non_taxable"],
  ["warehouse-2026-03-21", "9218", "RED ONIONS", 1, 479, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1471275", "KHQ 4PC SET", 1, 1_799, 0, "taxable"],
  ["warehouse-2026-03-21", "1656611", "KS CREAM CHS", 1, 629, 0, "non_taxable"],
  ["warehouse-2026-03-21", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-03-21", "1560758", "DINO BUDDIES", 1, 1_529, 0, "non_taxable"],
  ["gas-2026-03-21", "fuel-regular", "REGULAR", 10.819, 5_408, 0, "non_taxable", 4_999],

  ["warehouse-2026-03-28", "1408146", "LUCKY TEE", 1, 999, 0, "taxable"],
  ["warehouse-2026-03-28", "1908050", "LE QLTED SET", 1, 1_000, 0, "taxable"],
  ["warehouse-2026-03-28", "1472774", "ORG FRT BAR", 1, 1_399, 0, "non_taxable"],
  ["warehouse-2026-03-28", "316780", "CHEETOS 28OZ", 1, 739, 240, "non_taxable"],
  ["warehouse-2026-03-28", "1998760", "SIMPLY PRO", 1, 879, 0, "non_taxable"],
  ["warehouse-2026-03-28", "188140", "FRITOLAY30CT", 1, 1_899, 500, "non_taxable"],
  ["warehouse-2026-03-28", "531860", "DAHI YOGURT", 1, 839, 0, "non_taxable"],
  ["warehouse-2026-03-28", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-03-28", "1985987", "SPRFRT GUMMY", 1, 1_359, 0, "non_taxable"],
  ["warehouse-2026-03-28", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-03-28", "30669", "BANANAS", 1, 199, 0, "non_taxable"],
  ["warehouse-2026-03-28", "2254", "ORG MAND", 1, 579, 0, "non_taxable"],
  ["warehouse-2026-03-28", "1335089", "BAGELS", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-03-28", "57554", "BLUEBERRIES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-03-28", "1806393", "PAINT SET", 1, 1_799, 500, "taxable"],

  ["warehouse-2026-04-04", "1908452", "FULFIL VRTY", 1, 2_089, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1879628", "SG ELDR ORNG", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1878619", "EB LS TOP", 1, 1_197, 0, "taxable"],
  ["warehouse-2026-04-04", "2254", "ORG MAND", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1748375", "3PC TUTU SET", 1, 1_999, 400, "taxable"],
  ["warehouse-2026-04-04", "1992399", "FREEZIE POP", 1, 989, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1875357", "KTHHGRAPHTEE", 1, 999, 0, "taxable"],
  ["warehouse-2026-04-04", "38742", "SWEET CORN", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1344", "ROMA TOMATO", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-04-04", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1943125", "GAP LOGO TEE", 1, 999, 0, "taxable"],
  ["warehouse-2026-04-04", "1068083", "ORG FR EGGS", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1951107", "BR CHINO", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-04-04", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1965987", "THMENSCREW", 1, 1_599, 400, "taxable"],
  ["warehouse-2026-04-04", "2113", "SW RANCH KIT", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1967472", "SBSTRAITJEAN", 2, 3_998, 1_000, "taxable"],
  ["warehouse-2026-04-04", "1985993", "ANNIES BUNNY", 1, 839, 0, "non_taxable"],
  ["warehouse-2026-04-04", "1997286", "SHEET PAN", 1, 1_449, 0, "non_taxable"],

  ["warehouse-2026-04-11", "1953511", "32D TWILPANT", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-04-11", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-04-11", "2021189", "OLAY EB BW", 1, 1_599, 450, "taxable"],
  ["warehouse-2026-04-11", "1948682", "SANTAL BWS", 1, 997, 0, "taxable"],
  ["warehouse-2026-04-11", "1552971", "OATNUT", 1, 729, 0, "non_taxable"],
  ["warehouse-2026-04-11", "720650", "MINI CUKES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-04-11", "2016761", "BK: PANORAMA", 1, 1_299, 0, "taxable"],
  ["warehouse-2026-04-11", "2033331", "CRAN ORNG", 2, 998, 0, "non_taxable"],
  ["warehouse-2026-04-11", "2023727", "OUAF IMMUNIT", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-04-11", "47825", "GREEN GRAPES", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-04-11", "289660", "COTTAGE CHSE", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-04-11", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-04-11", "2113", "SW RANCH KIT", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-04-11", "3923", "LIMES 3 LB.", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-04-11", "1963239", "AIRWICK 9+1", 1, 1_799, 400, "taxable"],
  ["warehouse-2026-04-11", "1861502", "AVEENO BABY", 1, 1_899, 0, "taxable"],
  ["warehouse-2026-04-11", "57554", "BLUEBERRIES", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-04-11", "1961564", "L2L LNGE SET", 1, 1_999, 400, "taxable"],

  ["warehouse-2026-04-19", "2030689", "TAPIOCPUDING", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1673236", "LEVI'S 511", 1, 2_000, 0, "taxable"],
  ["warehouse-2026-04-19", "38175", "CARA ORANGES", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1380620", "ORGANIC OATS", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1689295", "COL TBRUSH", 1, 1_499, 400, "taxable"],
  ["warehouse-2026-04-19", "1564302", "KIDS4PKTEE", 1, 1_599, 0, "taxable"],
  ["warehouse-2026-04-19", "38742", "SWEET CORN", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1953511", "32D TWILPANT", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-04-19", "1271446", "OIKOS ZERO", 1, 1_399, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1954382", "PUMA TEE", 1, 1_099, 0, "taxable"],
  ["warehouse-2026-04-19", "1068083", "ORG FR EGGS", 1, 849, 0, "non_taxable"],
  ["warehouse-2026-04-19", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-04-19", "720650", "MINI CUKES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1268728", "UNREAL BARS", 1, 1_269, 370, "non_taxable"],
  ["warehouse-2026-04-19", "5943", "ANJOU PEAR", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1973216", "FRUIT PILLOW", 1, 1_099, 0, "taxable"],
  ["warehouse-2026-04-19", "1560969", "MADEGOODMINI", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-04-19", "1928295", "DOVE BW", 1, 1_799, 350, "taxable"],
  ["warehouse-2026-04-19", "1285702", "TOOTHPASTE", 1, 1_699, 600, "taxable"],

  ["warehouse-2026-04-25", "1573805", "WPV SHIRT", 1, 1_299, 200, "taxable"],
  ["warehouse-2026-04-25", "1471275", "KHQ 4PC SET", 1, 1_799, 400, "taxable"],
  ["warehouse-2026-04-25", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-04-25", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-04-25", "1969316", "NICOLBY POLO", 1, 1_499, 0, "taxable"],
  ["warehouse-2026-04-25", "1854748", "3PC SWIM SET", 1, 1_299, 0, "taxable"],
  ["warehouse-2026-04-25", "2034800", "100MANJUICE", 1, 1_289, 0, "non_taxable"],
  ["warehouse-2026-04-25", "1966621", "PEB BCH POLO", 1, 1_499, 0, "taxable"],
  ["warehouse-2026-04-25", "1564302", "KIDS4PKTEE", 1, 1_599, 300, "taxable"],
  ["warehouse-2026-04-25", "1864954", "TEDB POLO", 1, 1_497, 0, "taxable"],
  ["warehouse-2026-04-25", "1851481", "20PC BUCKET", 1, 1_999, 400, "taxable"],
  ["warehouse-2026-04-25", "1977696", "TRACTOR WHLS", 1, 1_369, 0, "non_taxable"],
  ["warehouse-2026-04-25", "1873251", "DKNYCROSSBAG", 1, 3_299, 0, "taxable"],
  ["warehouse-2026-04-25", "7772005", "KS ANKLE PNT", 1, 800, 0, "taxable"],

  ["gas-2026-05-06", "fuel-regular", "REGULAR", 11.039, 6_357, 0, "non_taxable", 5_759],

  ["warehouse-2026-05-09", "9218", "RED ONIONS", 1, 479, 0, "non_taxable"],
  ["warehouse-2026-05-09", "142819", "TUSCAN MELON", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-05-09", "1611893", "INKED KETO", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-05-09", "1851141", "BUILTBAR", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-05-09", "1617506", "KS ORG CSHW", 1, 1_749, 0, "non_taxable"],
  ["warehouse-2026-05-09", "2023727", "OUAF IMMUNIT", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-05-09", "720650", "MINI CUKES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-05-09", "1879628", "SG ELDR ORNG", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-05-09", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-05-09", "5565", "BLACK GRAPE", 1, 899, 0, "non_taxable"],
  ["gas-2026-05-09", "fuel-regular", "REGULAR", 13.782, 7_441, 0, "non_taxable", 5_399],

  ["warehouse-2026-05-16", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-05-16", "7923", "4LB OG HONEY", 1, 1_249, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1959114", "B NYC SHIRT", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-05-16", "1550956", "PANEER CHEES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-05-16", "560519", "WILDROOTS", 1, 1_049, 270, "non_taxable"],
  ["warehouse-2026-05-16", "1935002", "HUG PU 4T-5T", 1, 3_999, 0, "taxable"],
  ["warehouse-2026-05-16", "96716", "ORG SPINACH", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1465518", "SUJA GINGER", 1, 1_299, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1851573", "HUGALUMPS", 1, 2_499, 0, "taxable"],
  ["warehouse-2026-05-16", "1699717", "FRUIT STRIPS", 1, 1_659, 0, "non_taxable"],
  ["warehouse-2026-05-16", "47825", "GREEN GRAPES", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1068083", "ORG FR EGGS", 1, 769, 0, "non_taxable"],
  ["warehouse-2026-05-16", "720650", "MINI CUKES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1970759", "MAGIC SPOON", 1, 1_349, 0, "non_taxable"],
  ["warehouse-2026-05-16", "2064923", "CINN BAGEL", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1344", "ROMA TOMATO", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-05-16", "1725952", "**KS ULTRA**", 1, 2_199, 0, "taxable"],
  ["warehouse-2026-05-16", "1992399", "FREEZIE POP", 1, 989, 300, "non_taxable"],
  ["warehouse-2026-05-16", "1796314", "BEACH TOWEL", 1, 999, 200, "taxable"],
  ["warehouse-2026-05-16", "5938", "POTATOES", 1, 799, 0, "non_taxable"],

  ["warehouse-2026-05-23", "2023727", "OUAF IMMUNIT", 1, 1_999, 600, "non_taxable"],
  ["warehouse-2026-05-23", "1854625", "WRANGLER TEE", 1, 1_099, 0, "taxable"],
  ["warehouse-2026-05-23", "1271528", "DISNEY GOWN", 1, 1_399, 0, "taxable"],
  ["warehouse-2026-05-23", "142819", "TUSCAN MELON", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-05-23", "1898148", "BIENA EDMAME", 1, 769, 230, "non_taxable"],
  ["warehouse-2026-05-23", "309881", "RUFFLES 28OZ", 1, 789, 240, "non_taxable"],
  ["warehouse-2026-05-23", "2980", "ORRI MAND", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-05-23", "1851658", "BUBBLE BLAST", 1, 2_599, 600, "taxable"],
  ["warehouse-2026-05-23", "1920724", "PRESSED SHOT", 1, 1_799, 0, "non_taxable"],
  ["warehouse-2026-05-23", "532683", "GINGER", 1, 849, 0, "non_taxable"],
  ["warehouse-2026-05-23", "38742", "SWEET CORN", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-05-23", "1620332", "PANERA MAC", 1, 1_159, 360, "non_taxable"],
  ["warehouse-2026-05-23", "2004358", "CREATINE BAR", 1, 2_439, 0, "non_taxable"],
  ["warehouse-2026-05-23", "1784848", "FOAM BLASTER", 1, 1_499, 300, "taxable"],
  ["warehouse-2026-05-23", "1962938", "LE TOP", 1, 1_299, 300, "taxable"],
  ["warehouse-2026-05-23", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-05-23", "2064923", "CINN BAGEL", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-05-23", "1494546", "GREGNORMPOLO", 1, 1_899, 400, "taxable"],
  ["warehouse-2026-05-23", "1271446", "OIKOS ZERO", 1, 1_399, 450, "non_taxable"],
  ["gas-2026-05-23", "fuel-regular", "REGULAR", 9.413, 5_139, 0, "non_taxable", 5_459],

  ["warehouse-2026-05-30", "2004991", "SAB6PCTOOLS", 1, 1_999, 0, "taxable"],
  ["warehouse-2026-05-30", "1739998", "KS WRAP 3PK", 1, 497, 0, "taxable"],
  ["warehouse-2026-05-30", "512447", "DAVE'S 21 WG", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-05-30", "1901810", "24PCFLATWARE", 1, 2_999, 600, "taxable"],
  ["warehouse-2026-05-30", "720650", "MINI CUKES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-05-30", "1801", "MANDARINS", 1, 549, 0, "non_taxable"],
  ["warehouse-2026-05-30", "1957935", "BCBG SHORT", 1, 500, 0, "taxable"],
  ["warehouse-2026-05-30", "1998317", "BUILT 'N CRM", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-05-30", "1796258", "DA TW BLNKT", 1, 1_499, 0, "taxable"],
  ["warehouse-2026-05-30", "1550393", "KS ORG 2% MK", 2, 2_998, 0, "non_taxable"],
  ["warehouse-2026-05-30", "1560969", "MADEGOODMINI", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-05-30", "1589403", "BAN REP TEE", 1, 1_299, 0, "taxable"],
  ["warehouse-2026-05-30", "1433996", "NAAN DIPPERS", 1, 699, 200, "non_taxable"],
  ["warehouse-2026-05-30", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-05-30", "9877788", "KS ORG TOFU", 1, 589, 0, "non_taxable"],

  ["warehouse-2026-06-06", "38742", "SWEET CORN", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-06-06", "1768123", "BBEE KIDS4PC", 1, 997, 0, "taxable"],
  ["warehouse-2026-06-06", "1961236", "LPSUEDESHORT", 1, 600, 0, "taxable"],
  ["warehouse-2026-06-06", "1892398", "SMOOTHIES", 1, 1_699, 0, "non_taxable"],
  ["warehouse-2026-06-06", "1859936", "BR BOXBRIEF", 1, 1_799, 400, "taxable"],
  ["warehouse-2026-06-06", "1172471", "IRISH BUTTER", 1, 1_699, 0, "non_taxable"],
  ["warehouse-2026-06-06", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-06-06", "1344", "ROMA TOMATO", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-06-06", "2023727", "OUAF IMMUNIT", 1, 1_999, 600, "non_taxable"],
  ["warehouse-2026-06-06", "1925833", "KS ENERGY12Z", 1, 1_699, 0, "taxable"],
  ["warehouse-2026-06-06", "1851588", "BOB REUSE", 1, 1_599, 600, "taxable"],
  ["warehouse-2026-06-06", "720650", "MINI CUKES", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-06-06", "1618629", "FRITO SELECT", 1, 1_949, 500, "non_taxable"],
  ["warehouse-2026-06-06", "1700118", "BUTTER CUP", 1, 1_389, 0, "non_taxable"],
  ["warehouse-2026-06-06", "1970722", "JCKY BIKINI", 1, 1_399, 0, "taxable"],
  ["warehouse-2026-06-06", "1392843", "AVOCA SPRAY", 1, 1_499, 450, "non_taxable"],
  ["warehouse-2026-06-06", "1620332", "PANERA MAC", 1, 1_159, 360, "non_taxable"],
  ["warehouse-2026-06-06", "1957651", "CWC DRESS", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-06-06", "2064923", "CINN BAGEL", 1, 499, 0, "non_taxable"],

  ["warehouse-2026-06-13", "512515", "ORG STRAWBRY", 1, 1_099, 0, "non_taxable"],
  ["warehouse-2026-06-13", "782796", "***KSWTR40PK", 1, 399, 0, "taxable"],
  ["warehouse-2026-06-13", "1801", "MANDARINS", 1, 549, 0, "non_taxable"],
  ["warehouse-2026-06-13", "30669", "BANANAS", 1, 199, 0, "non_taxable"],
  ["warehouse-2026-06-13", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-06-13", "1920724", "PRESSED SHOT", 1, 1_799, 0, "non_taxable"],
  ["warehouse-2026-06-13", "1353948", "PRECISION", 1, 2_299, 1_000, "taxable"],
  ["warehouse-2026-06-13", "2031674", "CANDLES 4PK", 1, 1_999, 0, "taxable"],

  ["warehouse-2026-06-15", "1974258", "LE SS CREW T", 1, 999, 0, "taxable"],
  ["warehouse-2026-06-15", "1465518", "SUJA GINGER", 1, 1_299, 400, "non_taxable"],
  ["warehouse-2026-06-15", "1970817", "EBGRAPHICTEE", 1, 999, 0, "taxable"],
  ["warehouse-2026-06-15", "1962938", "LE TOP", 1, 1_299, 300, "taxable"],
  ["warehouse-2026-06-15", "1863710", "5POCKET PANT", 1, 1_799, 300, "taxable"],
  ["warehouse-2026-06-15", "438851", "CAPRI 100%", 1, 1_399, 0, "non_taxable"],
  ["warehouse-2026-06-15", "1961924", "LE 4PC PJ", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-06-15", "1485984", "FAIRLIFECHOC", 1, 3_999, 800, "non_taxable"],
  ["warehouse-2026-06-15", "1700118", "BUTTER CUP", 1, 1_389, 290, "non_taxable"],

  ["warehouse-2026-06-20", "2990", "ORG HONEST K", 2, 2_978, 0, "taxable"],
  ["warehouse-2026-06-20", "2064923", "CINN BAGEL", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-06-20", "3741", "4LB ENVY", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1068083", "ORG FR EGGS", 1, 849, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1550393", "KS ORG 2% MK", 2, 2_998, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1892398", "SMOOTHIES", 1, 1_699, 350, "non_taxable"],
  ["warehouse-2026-06-20", "2033625", "FROSTY FRUIT", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1955439", "32D RIB TANK", 1, 1_299, 300, "taxable"],
  ["warehouse-2026-06-20", "289660", "COTTAGE CHSE", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1998317", "BUILT 'N CRM", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1485984", "FAIRLIFECHOC", 1, 3_999, 800, "non_taxable"],
  ["warehouse-2026-06-20", "2023727", "OUAF IMMUNIT", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1806649", "NEUTROGENA", 1, 1_999, 500, "taxable"],
  ["warehouse-2026-06-20", "83505", "RED POTATOES", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1344", "ROMA TOMATO", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-06-20", "1448891", "TYSON CHICKN", 1, 1_699, 500, "non_taxable"],
  ["gas-2026-06-20", "fuel-regular", "REGULAR", 11.249, 5_848, 0, "non_taxable", 5_199],

  ["warehouse-2026-06-27", "2034800", "100MANJUICE", 1, 1_289, 0, "non_taxable"],
  ["warehouse-2026-06-27", "1723798", "NIKEKIDSSET", 1, 1_197, 0, "taxable"],
  ["warehouse-2026-06-27", "1550956", "PANEER CHEES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-06-27", "2056026", "BK ACTIVITY", 1, 1_459, 0, "taxable"],
  ["warehouse-2026-06-27", "5161251", "UNSTPBL FRSH", 1, 1_999, 400, "taxable"],
  ["warehouse-2026-06-27", "7113", "LYCHEE", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-06-27", "1851658", "BUBBLE BLAST", 1, 997, 0, "taxable"],
  ["warehouse-2026-06-27", "2534", "CHERRIES", 1, 799, 200, "non_taxable"],
  ["warehouse-2026-06-27", "1068083", "ORG FR EGGS", 1, 849, 0, "non_taxable"],
  ["warehouse-2026-06-27", "1935002", "HUG PU 4T-5T", 1, 3_999, 800, "taxable"],
  ["warehouse-2026-06-27", "38742", "SWEET CORN", 1, 699, 0, "non_taxable"],
  ["warehouse-2026-06-27", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-06-27", "96716", "ORG SPINACH", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-06-27", "5247022", "TIDE OXIPODS", 1, 2_599, 500, "taxable"],
  ["warehouse-2026-06-27", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-06-27", "1851746", "FLNA V-NECK", 1, 999, 200, "taxable"],
  ["warehouse-2026-06-27", "289660", "CHSE", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-06-27", "1582922", "KS ORG GHEE", 1, 2_199, 0, "non_taxable"],

  ["warehouse-2026-07-03", "669434", "CAPE COD RF", 1, 799, 200, "non_taxable"],
  ["warehouse-2026-07-03", "1970146", "QSWOVENJOGGR", 1, 1_799, 400, "taxable"],
  ["warehouse-2026-07-03", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-07-03", "2029201", "PL BAGEL 8CT", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-07-03", "26281", "MINI MELON", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-07-03", "1852806", "CHAMPION SET", 1, 1_699, 400, "taxable"],
  ["warehouse-2026-07-03", "1955429", "DNSKNLEGGING", 1, 1_299, 300, "taxable"],
  ["warehouse-2026-07-03", "1975527", "KSULTFILTMLK", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-07-03", "2011219", "EGGO PROTEIN", 1, 1_299, 0, "non_taxable"],
  ["warehouse-2026-07-03", "1244454", "TASTER'S REG", 1, 2_199, 600, "non_taxable"],
  ["warehouse-2026-07-03", "9218", "RED ONIONS", 1, 479, 0, "non_taxable"],
  ["warehouse-2026-07-03", "1974728", "KCSPORTSHIRT", 1, 1_899, 400, "taxable"],
  ["warehouse-2026-07-03", "1973610", "EM SS TEE", 1, 1_299, 300, "taxable"],
  ["warehouse-2026-07-03", "7113", "LYCHEE", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-07-03", "1344", "ROMA TOMATO", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-07-03", "679131", "KS ORG SYRUP", 1, 1_299, 0, "non_taxable"],
  ["gas-2026-07-03", "fuel-regular", "REGULAR", 8.744, 4_196, 0, "non_taxable", 4_799],

  ["warehouse-2026-07-12", "47825", "GREEN GRAPES", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-07-12", "1388332", "COCONUT ROLL", 1, 859, 260, "non_taxable"],
  ["warehouse-2026-07-12", "25949", "FRESH GARLIC", 1, 749, 0, "non_taxable"],
  ["warehouse-2026-07-12", "1919326", "***BOUNTY***", 1, 2_849, 560, "taxable"],
  ["warehouse-2026-07-12", "2023727", "OUAF IMMUNIT", 1, 1_999, 0, "non_taxable"],
  ["warehouse-2026-07-12", "1518783", "KS COCNT WTR", 1, 1_299, 0, "non_taxable"],
  ["warehouse-2026-07-12", "2062456", "CF FRUIT BAR", 1, 1_679, 0, "non_taxable"],
  ["warehouse-2026-07-12", "1360840", "OMEGA EGGS", 1, 749, 0, "non_taxable"],
  ["warehouse-2026-07-12", "1788968", "IQ BAR VRTY", 1, 1_979, 0, "non_taxable"],
  ["warehouse-2026-07-12", "532683", "GINGER", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-07-12", "9218", "RED ONIONS", 1, 549, 0, "non_taxable"],
  ["warehouse-2026-07-12", "2619", "ORG BANANAS", 1, 249, 0, "non_taxable"],
  ["warehouse-2026-07-12", "1737189", "HYDRO BOOST", 1, 2_999, 800, "taxable"],
  ["warehouse-2026-07-12", "1344", "ROMA TOMATO", 1, 649, 0, "non_taxable"],
  ["warehouse-2026-07-12", "7113", "LYCHEE", 1, 799, 0, "non_taxable"],

  ["warehouse-2026-07-18", "1453434", "CHEESE BREAD", 1, 1_179, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1975527", "KSULTFILTMLK", 1, 1_199, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1550393", "KS ORG 2% MK", 1, 1_499, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1620332", "PANERA MAC", 1, 1_189, 0, "non_taxable"],
  ["warehouse-2026-07-18", "2065441", "CHEESE BAKES", 1, 999, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1465518", "SUJA GINGER", 1, 1_299, 400, "non_taxable"],
  ["warehouse-2026-07-18", "1129909", "KS LAX 100DS", 1, 2_299, 0, "taxable"],
  ["warehouse-2026-07-18", "7113", "LYCHEE", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-07-18", "38742", "SWEET CORN", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-07-18", "531860", "DAHI YOGURT", 1, 839, 0, "non_taxable"],
  ["warehouse-2026-07-18", "57554", "BLUEBERRIES", 1, 799, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1801553", "WHEAT BREAD", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-07-18", "2534", "CHERRIES", 1, 899, 0, "non_taxable"],
  ["warehouse-2026-07-18", "2029201", "PL BAGEL 8CT", 1, 499, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1974258", "LE SS CREW T", 1, 999, 200, "taxable"],
  ["warehouse-2026-07-18", "1851746", "FLNA V-NECK", 1, 999, 0, "taxable"],
  ["warehouse-2026-07-18", "1868328", "3 DOT PANT", 1, 1_399, 0, "taxable"],
  ["warehouse-2026-07-18", "1868328", "3 DOT PANT", 1, 1_399, 0, "taxable"],
  ["warehouse-2026-07-18", "289660", "COTTAGE CHSE", 1, 599, 0, "non_taxable"],
  ["warehouse-2026-07-18", "1851163", "BATH TOWEL", 1, 699, 200, "taxable"],
];

const CANONICAL_NAME_BY_ITEM: Readonly<Record<string, string>> = {
  "1344": "Roma tomatoes",
  "1801": "Mandarins",
  "2254": "Organic mandarins",
  "2534": "Cherries",
  "2619": "Organic bananas",
  "30669": "Bananas",
  "7113": "Lychee",
  "9218": "Red onions",
  "38175": "Cara Cara oranges",
  "38742": "Sweet corn",
  "47825": "Green grapes",
  "57554": "Blueberries",
  "289660": "Cottage cheese",
  "531860": "Dahi yogurt",
  "720650": "Mini cucumbers",
  "1025795": "Kirkland Signature eggs, 5 dozen",
  "1068083": "Organic free-range eggs",
  "1271446": "Oikos Zero yogurt",
  "1388332": "Coconut rolls",
  "1465518": "Suja ginger shots",
  "1550393": "Kirkland Signature organic 2% milk",
  "1550956": "Paneer cheese",
  "1560969": "MadeGood Minis",
  "1617506": "Kirkland Signature organic cashews",
  "1620332": "Panera mac and cheese",
  "1659424": "Immune shots",
  "1851141": "Built Bar variety pack",
  "1935800": "Pita bread",
  "1975527": "Kirkland Signature ultrafiltered milk",
  "2023727": "Once Upon a Farm immunity blend",
  "2029201": "Plain bagels, 8 count",
  "2064923": "Cinnamon bagels",
  "fuel-regular": "Regular gasoline",
};

export const AUDITED_RECEIPT_ITEMS_2026: readonly ReceiptItemSeed[] = itemRows.map(
  (row, index) => {
    const canonicalName = CANONICAL_NAME_BY_ITEM[row[1]] ?? row[2];
    const unitPriceMills = row[7] ?? null;
    return {
      id: `${row[0]}:item-${String(index + 1).padStart(3, "0")}`,
      transactionId: row[0],
      itemNumber: row[1],
      rawDescription: row[2],
      canonicalName,
      normalizationStatus:
        canonicalName === row[2] ? "receipt_abbreviation" : "normalized_from_history",
      quantity: row[3],
      unitPriceCents: unitPriceMills === null ? row[4] / row[3] : null,
      unitPriceMills,
      grossAmountCents: row[4],
      discountCents: row[5],
      netAmountCents: row[4] - row[5],
      taxStatus: row[6],
    };
  },
);

export const AUDITED_CATEGORY_TOTALS_2026 = [
  { category: "warehouse", transactionCount: 29, grossReceiptTotalCents: 570_940, householdFundedCents: 570_940 },
  { category: "gas", transactionCount: 7, grossReceiptTotalCents: 39_983, householdFundedCents: 39_983 },
  { category: "optical", transactionCount: 2, grossReceiptTotalCents: 80_192, householdFundedCents: 5_399 },
] as const satisfies readonly {
  category: ReceiptCategory;
  transactionCount: number;
  grossReceiptTotalCents: number;
  householdFundedCents: number;
}[];

export const AUDITED_MONTHLY_TOTALS_2026 = [
  { month: "2026-01", transactionCount: 7, grossReceiptTotalCents: 179_740, householdFundedCents: 104_947, warehouseCents: 99_548, gasCents: 0, opticalHouseholdFundedCents: 5_399 },
  { month: "2026-02", transactionCount: 5, grossReceiptTotalCents: 84_081, householdFundedCents: 84_081, warehouseCents: 78_487, gasCents: 5_594, opticalHouseholdFundedCents: 0 },
  { month: "2026-03", transactionCount: 5, grossReceiptTotalCents: 83_215, householdFundedCents: 83_215, warehouseCents: 77_807, gasCents: 5_408, opticalHouseholdFundedCents: 0 },
  { month: "2026-04", transactionCount: 4, grossReceiptTotalCents: 88_515, householdFundedCents: 88_515, warehouseCents: 88_515, gasCents: 0, opticalHouseholdFundedCents: 0 },
  { month: "2026-05", transactionCount: 7, grossReceiptTotalCents: 98_717, householdFundedCents: 98_717, warehouseCents: 79_780, gasCents: 18_937, opticalHouseholdFundedCents: 0 },
  { month: "2026-06", transactionCount: 6, grossReceiptTotalCents: 96_634, householdFundedCents: 96_634, warehouseCents: 90_786, gasCents: 5_848, opticalHouseholdFundedCents: 0 },
  { month: "2026-07", transactionCount: 4, grossReceiptTotalCents: 60_213, householdFundedCents: 60_213, warehouseCents: 56_017, gasCents: 4_196, opticalHouseholdFundedCents: 0 },
] as const;

export const AUDITED_2026_SUMMARY = {
  through: "2026-07-18",
  transactionCount: 38,
  grossReceiptTotalCents: 691_115,
  householdFundedCents: 616_322,
  externalFundingCents: 74_793,
} as const;

export type RecurringProductEvent = {
  transactionId: string;
  purchasedOn: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  netAmountCents: number;
};

export type RecurringProductHistory = {
  itemNumber: string;
  canonicalName: string;
  purchaseCount: number;
  totalUnits: number;
  firstPurchasedOn: string;
  lastPurchasedOn: string;
  medianIntervalDays: number;
  events: readonly RecurringProductEvent[];
};

function daysBetween(first: string, second: string) {
  return Math.round(
    (Date.parse(`${second}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
      86_400_000,
  );
}

function median(values: readonly number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function buildRecurringProductHistories(): readonly RecurringProductHistory[] {
  const transactionById = new Map(
    AUDITED_RECEIPT_TRANSACTIONS_2026.map((transaction) => [transaction.id, transaction]),
  );
  const eventsByItem = new Map<string, Map<string, RecurringProductEvent>>();

  for (const item of AUDITED_RECEIPT_ITEMS_2026) {
    const transaction = transactionById.get(item.transactionId);
    if (!transaction || transaction.category !== "warehouse" || item.unitPriceCents === null) continue;
    const byTransaction = eventsByItem.get(item.itemNumber) ?? new Map();
    const existing = byTransaction.get(item.transactionId);
    byTransaction.set(item.transactionId, {
      transactionId: item.transactionId,
      purchasedOn: transaction.purchasedOn,
      quantity: (existing?.quantity ?? 0) + item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountCents: (existing?.discountCents ?? 0) + item.discountCents,
      netAmountCents: (existing?.netAmountCents ?? 0) + item.netAmountCents,
    });
    eventsByItem.set(item.itemNumber, byTransaction);
  }

  return [...eventsByItem.entries()]
    .map(([itemNumber, byTransaction]) => {
      const events = [...byTransaction.values()].sort((a, b) =>
        a.purchasedOn.localeCompare(b.purchasedOn),
      );
      const intervals = events.slice(1).map((event, index) =>
        daysBetween(events[index].purchasedOn, event.purchasedOn),
      );
      return {
        itemNumber,
        canonicalName: CANONICAL_NAME_BY_ITEM[itemNumber] ??
          AUDITED_RECEIPT_ITEMS_2026.find((item) => item.itemNumber === itemNumber)?.rawDescription ??
          "Unresolved receipt abbreviation",
        purchaseCount: events.length,
        totalUnits: events.reduce((sum, event) => sum + event.quantity, 0),
        firstPurchasedOn: events[0]?.purchasedOn ?? "",
        lastPurchasedOn: events.at(-1)?.purchasedOn ?? "",
        medianIntervalDays: median(intervals),
        events,
      };
    })
    .filter((history) => history.purchaseCount >= 3)
    .sort((a, b) => b.purchaseCount - a.purchaseCount || a.canonicalName.localeCompare(b.canonicalName));
}

export const RECURRING_PRODUCT_HISTORIES_2026 = buildRecurringProductHistories();

export const AUDIT_UNCERTAINTIES_2026 = [
  "Receipt descriptions remain Costco abbreviations unless a conservative household-friendly name is mapped from repeated item history; they are not externally catalog-verified names.",
  "On 2026-07-18, the photographed Blueberries price is visually soft. It is recorded as $7.99 because that is the unique value that reconciles item gross, $8.00 discounts, $201.90 subtotal, $5.84 tax, and $207.74 total.",
  "On 2026-06-27, one $21.99 Ghee line repeated at a PDF page boundary and was collapsed once because Items Sold and subtotal both prove a single purchase.",
  "The two 2026-01-02 optical discounts are attached to the adjacent lens/package line for seeding, but the source labels them only as GLASSES; receipt-level totals are exact even if product-level attribution is package-wide.",
  "Discounts whose source line names a product rather than an item number are attached by receipt adjacency and verified against subtotal; the raw coupon identifier is intentionally not retained.",
] as const;

export const AUDIT_RECONCILIATION_ISSUES_2026: readonly string[] = (() => {
  const issues: string[] = [];
  const itemsByTransaction = new Map<string, ReceiptItemSeed[]>();
  for (const item of AUDITED_RECEIPT_ITEMS_2026) {
    const items = itemsByTransaction.get(item.transactionId) ?? [];
    items.push(item);
    itemsByTransaction.set(item.transactionId, items);
  }

  for (const transaction of AUDITED_RECEIPT_TRANSACTIONS_2026) {
    const items = itemsByTransaction.get(transaction.id) ?? [];
    const gross = items.reduce((sum, item) => sum + item.grossAmountCents, 0);
    const discounts = items.reduce((sum, item) => sum + item.discountCents, 0);
    const countedItems = transaction.category === "gas"
      ? items.length
      : items.reduce((sum, item) => sum + item.quantity, 0);
    if (gross !== transaction.itemGrossCents) issues.push(`${transaction.id}: item gross mismatch`);
    if (discounts !== transaction.discountCents) issues.push(`${transaction.id}: discount mismatch`);
    if (gross - discounts !== transaction.subtotalCents) issues.push(`${transaction.id}: subtotal mismatch`);
    if (transaction.subtotalCents + transaction.taxCents !== transaction.receiptTotalCents) {
      issues.push(`${transaction.id}: total mismatch`);
    }
    if (transaction.householdFundedCents + transaction.externalFundingCents !== transaction.receiptTotalCents) {
      issues.push(`${transaction.id}: funding mismatch`);
    }
    if (countedItems !== transaction.itemCount) issues.push(`${transaction.id}: item count mismatch`);
  }

  const householdFunded = AUDITED_RECEIPT_TRANSACTIONS_2026.reduce(
    (sum, transaction) => sum + transaction.householdFundedCents,
    0,
  );
  const grossReceiptTotal = AUDITED_RECEIPT_TRANSACTIONS_2026.reduce(
    (sum, transaction) => sum + transaction.receiptTotalCents,
    0,
  );
  const externalFunding = AUDITED_RECEIPT_TRANSACTIONS_2026.reduce(
    (sum, transaction) => sum + transaction.externalFundingCents,
    0,
  );
  if (AUDITED_RECEIPT_TRANSACTIONS_2026.length !== AUDITED_2026_SUMMARY.transactionCount) {
    issues.push("summary: transaction count mismatch");
  }
  if (householdFunded !== AUDITED_2026_SUMMARY.householdFundedCents) {
    issues.push("summary: household-funded total mismatch");
  }
  if (grossReceiptTotal !== AUDITED_2026_SUMMARY.grossReceiptTotalCents) {
    issues.push("summary: gross receipt total mismatch");
  }
  if (externalFunding !== AUDITED_2026_SUMMARY.externalFundingCents) {
    issues.push("summary: external-funding total mismatch");
  }

  for (const categoryTotal of AUDITED_CATEGORY_TOTALS_2026) {
    const transactions = AUDITED_RECEIPT_TRANSACTIONS_2026.filter(
      (transaction) => transaction.category === categoryTotal.category,
    );
    if (transactions.length !== categoryTotal.transactionCount) {
      issues.push(`${categoryTotal.category}: transaction count mismatch`);
    }
    if (
      transactions.reduce((sum, transaction) => sum + transaction.receiptTotalCents, 0) !==
      categoryTotal.grossReceiptTotalCents
    ) {
      issues.push(`${categoryTotal.category}: gross receipt total mismatch`);
    }
    if (
      transactions.reduce((sum, transaction) => sum + transaction.householdFundedCents, 0) !==
      categoryTotal.householdFundedCents
    ) {
      issues.push(`${categoryTotal.category}: household-funded total mismatch`);
    }
  }

  for (const monthlyTotal of AUDITED_MONTHLY_TOTALS_2026) {
    const transactions = AUDITED_RECEIPT_TRANSACTIONS_2026.filter(
      (transaction) => transaction.purchasedOn.startsWith(monthlyTotal.month),
    );
    const householdByCategory = (category: ReceiptCategory) =>
      transactions
        .filter((transaction) => transaction.category === category)
        .reduce((sum, transaction) => sum + transaction.householdFundedCents, 0);
    if (transactions.length !== monthlyTotal.transactionCount) {
      issues.push(`${monthlyTotal.month}: transaction count mismatch`);
    }
    if (
      transactions.reduce((sum, transaction) => sum + transaction.receiptTotalCents, 0) !==
      monthlyTotal.grossReceiptTotalCents
    ) {
      issues.push(`${monthlyTotal.month}: gross receipt total mismatch`);
    }
    if (
      transactions.reduce((sum, transaction) => sum + transaction.householdFundedCents, 0) !==
      monthlyTotal.householdFundedCents
    ) {
      issues.push(`${monthlyTotal.month}: household-funded total mismatch`);
    }
    if (householdByCategory("warehouse") !== monthlyTotal.warehouseCents) {
      issues.push(`${monthlyTotal.month}: warehouse total mismatch`);
    }
    if (householdByCategory("gas") !== monthlyTotal.gasCents) {
      issues.push(`${monthlyTotal.month}: gas total mismatch`);
    }
    if (householdByCategory("optical") !== monthlyTotal.opticalHouseholdFundedCents) {
      issues.push(`${monthlyTotal.month}: optical household-funded total mismatch`);
    }
  }
  return issues;
})();
