import type { RecurringProductHistory } from "./basketsense-data";

export const JULY_25_PLAN_DATE = "2026-07-25";

const DAY_MS = 86_400_000;

export type RecommendationSection =
  | "essentials"
  | "suggested"
  | "check_first"
  | "consider";

export type RecommendationSource = "recurring" | "predicted" | "consider";

export type RecommendationRole =
  | "essential"
  | "recurring"
  | "seasonal_favorite"
  | "seasonal_consider"
  | "check_first";

export type RecommendationPolicy = {
  itemNumber: string;
  section: RecommendationSection;
  role: RecommendationRole;
  included: boolean;
  reviewNote?: string;
};

export type RecommendationEvidence = {
  purchaseCount: number;
  totalUnits: number;
  medianIntervalDays: number;
  daysSinceLastPurchase: number;
  lastPurchasedOn: string;
  recentStreak: number;
};

export type SaturdayRecommendation = {
  itemNumber: string;
  name: string;
  section: RecommendationSection;
  source: RecommendationSource;
  role: RecommendationRole;
  included: boolean;
  confidenceBps: number;
  reason: string;
  estimatedPriceCents: number | null;
  evidence: RecommendationEvidence;
};

// Costco item numbers are verified against the audited 2026 receipt lines.
// In particular, the receipt history uses 2534 for cherries and 47825 for
// green grapes; similarly named catalog identifiers must not replace them.
export const JULY_25_RECOMMENDATION_POLICIES: readonly RecommendationPolicy[] = [
  {
    itemNumber: "1550393",
    section: "essentials",
    role: "essential",
    included: true,
  },
  {
    itemNumber: "2619",
    section: "essentials",
    role: "essential",
    included: true,
  },
  {
    itemNumber: "7113",
    section: "suggested",
    role: "seasonal_favorite",
    included: false,
  },
  {
    itemNumber: "2023727",
    section: "suggested",
    role: "recurring",
    included: false,
  },
  {
    itemNumber: "1344",
    section: "suggested",
    role: "recurring",
    included: false,
  },
  {
    itemNumber: "2534",
    section: "consider",
    role: "seasonal_consider",
    included: false,
  },
  {
    itemNumber: "47825",
    section: "consider",
    role: "seasonal_consider",
    included: false,
  },
  {
    itemNumber: "720650",
    section: "check_first",
    role: "check_first",
    included: false,
    reviewNote:
      "This previously weekly item has not appeared since 2026-06-06; confirm whether the habit changed.",
  },
  {
    itemNumber: "1068083",
    section: "check_first",
    role: "check_first",
    included: false,
    reviewNote:
      "A different egg product appeared on 2026-07-12; check egg supply before choosing a variety.",
  },
  {
    itemNumber: "38742",
    section: "check_first",
    role: "check_first",
    included: false,
  },
  {
    itemNumber: "2064923",
    section: "check_first",
    role: "check_first",
    included: false,
    reviewNote:
      "Plain bagels appeared on 2026-07-18; check bread supply before repurchasing from the bagel family.",
  },
] as const;

export function daysBetween(first: string, second: string) {
  return Math.round(
    (Date.parse(`${second}T00:00:00Z`) -
      Date.parse(`${first}T00:00:00Z`)) /
      DAY_MS,
  );
}

export function recentPurchaseStreak(history: RecurringProductHistory) {
  if (!history.events.length) return 0;

  const largestContinuousGap = Math.max(
    16,
    Math.round(history.medianIntervalDays * 1.75),
  );
  let streak = 1;

  for (let index = history.events.length - 1; index > 0; index -= 1) {
    const gap = daysBetween(
      history.events[index - 1].purchasedOn,
      history.events[index].purchasedOn,
    );
    if (gap > largestContinuousGap) break;
    streak += 1;
  }

  return streak;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

const ROLE_SCORE: Readonly<Record<RecommendationRole, number>> = {
  essential: 1_600,
  recurring: 900,
  seasonal_favorite: 1_300,
  seasonal_consider: 600,
  check_first: 400,
};

export function computeRecommendationConfidence(
  evidence: RecommendationEvidence,
  role: RecommendationRole,
) {
  const purchaseScore = Math.min(2_400, evidence.purchaseCount * 180);
  const cadenceDeviation =
    evidence.medianIntervalDays > 0
      ? Math.abs(
          evidence.daysSinceLastPurchase - evidence.medianIntervalDays,
        ) / evidence.medianIntervalDays
      : 1;
  const cadenceScore = Math.max(
    0,
    2_200 - Math.round(cadenceDeviation * 1_600),
  );
  const recencyScore = Math.max(
    0,
    1_400 - evidence.daysSinceLastPurchase * 35,
  );
  const streakScore = Math.min(1_200, evidence.recentStreak * 300);

  return clamp(
    800 +
      purchaseScore +
      cadenceScore +
      recencyScore +
      streakScore +
      ROLE_SCORE[role],
    3_000,
    9_700,
  );
}

function sourceForRole(role: RecommendationRole): RecommendationSource {
  if (role === "seasonal_favorite" || role === "seasonal_consider") {
    return "consider";
  }
  return role === "essential" ? "recurring" : "predicted";
}

function recommendationReason(
  recommendation: Omit<SaturdayRecommendation, "reason">,
  planDate: string,
  reviewNote?: string,
) {
  const { evidence, role } = recommendation;
  const timing =
    `${evidence.purchaseCount} purchases (${evidence.totalUnits} units) ` +
    `in the audited history; median interval ${evidence.medianIntervalDays} days; ` +
    `last purchased ${evidence.lastPurchasedOn}, ${evidence.daysSinceLastPurchase} days before ${planDate}.`;

  if (role === "check_first") {
    return `Check supply: ${timing} ${reviewNote ?? "Purchase cadence does not confirm what remains at home."}`;
  }
  if (role === "seasonal_favorite") {
    return `Optional seasonal favorite: ${timing} The recent purchase streak is ${evidence.recentStreak}; receipts suggest timing, not current household supply.`;
  }
  if (role === "seasonal_consider") {
    return `Seasonal consider: ${timing} Optional—confirm household interest and warehouse availability.`;
  }

  return `${role === "essential" ? "Recurring essential" : "Receipt rhythm"}: ${timing} Receipts suggest timing, not current household supply.`;
}

export function buildSaturdayRecommendations(
  histories: readonly RecurringProductHistory[],
  planDate: string,
  policies: readonly RecommendationPolicy[] =
    JULY_25_RECOMMENDATION_POLICIES,
): readonly SaturdayRecommendation[] {
  const historiesByItem = new Map(
    histories.map((history) => [history.itemNumber, history]),
  );

  return policies.flatMap((policy) => {
    const history = historiesByItem.get(policy.itemNumber);
    const latestEvent = history?.events.at(-1);
    if (!history || !latestEvent) return [];

    const evidence: RecommendationEvidence = {
      purchaseCount: history.purchaseCount,
      totalUnits: history.totalUnits,
      medianIntervalDays: history.medianIntervalDays,
      daysSinceLastPurchase: daysBetween(history.lastPurchasedOn, planDate),
      lastPurchasedOn: history.lastPurchasedOn,
      recentStreak: recentPurchaseStreak(history),
    };
    const withoutReason: Omit<SaturdayRecommendation, "reason"> = {
      itemNumber: history.itemNumber,
      name: history.canonicalName,
      section: policy.section,
      source: sourceForRole(policy.role),
      role: policy.role,
      included: policy.included,
      confidenceBps: computeRecommendationConfidence(evidence, policy.role),
      estimatedPriceCents: latestEvent.unitPriceCents,
      evidence,
    };

    return [
      {
        ...withoutReason,
        reason: recommendationReason(withoutReason, planDate, policy.reviewNote),
      },
    ];
  });
}
