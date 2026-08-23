const DAY_MS = 86_400_000;

export const RECOMMENDATION_ENGINE_V2_VERSION = "household-catalog-v2.1";

export type RecommendationProductState =
  | "essential"
  | "normal"
  | "check_first"
  | "seasonal"
  | "one_off"
  | "paused"
  | "retired";

export type RecommendationV2Event = {
  purchasedOn: string;
  quantityMilli: number;
  unitPriceCents: number | null;
};

export type RecommendationV2MemoryEvent = {
  recordedAt: string;
  preference: "buy_again" | "pause" | "not_for_us";
};

export type RecommendationV2OutcomeEvent = {
  recordedAt: string;
  value: string;
};

export type RecommendationV2Product = {
  productId: string;
  itemNumber: string | null;
  name: string;
  category: string | null;
  state?: RecommendationProductState;
  purchases: readonly RecommendationV2Event[];
  memories?: readonly RecommendationV2MemoryEvent[];
  outcomes?: readonly RecommendationV2OutcomeEvent[];
};

export type RecommendationScoreComponent = {
  name:
    | "frequency"
    | "cadence"
    | "recency"
    | "streak"
    | "quantity_stability"
    | "household_outcomes"
    | "product_state";
  points: number;
  maximum: number;
};

export type RecommendationV2Assessment = {
  productId: string;
  itemNumber: string | null;
  name: string;
  state: RecommendationProductState;
  eligible: boolean;
  suppressedReason: string | null;
  scoreBps: number;
  rank: number | null;
  section: "essentials" | "suggested" | "check_first" | "consider";
  reason: string;
  estimatedPriceCents: number | null;
  components: readonly RecommendationScoreComponent[];
  evidence: {
    purchaseCount: number;
    daysSinceLastPurchase: number | null;
    medianIntervalDays: number | null;
    intervalVariationDays: number | null;
    recentStreak: number;
  };
};

export type RecommendationV2Run = {
  engineVersion: string;
  asOfDate: string;
  attentionBudget: number;
  catalogSize: number;
  eligibleCount: number;
  assessments: readonly RecommendationV2Assessment[];
  recommendations: readonly RecommendationV2Assessment[];
};

export type RecommendationBacktestPoint = {
  asOfDate: string;
  purchasedProductIds: readonly string[];
  recommendedProductIds: readonly string[];
  hits: readonly string[];
  precisionAtK: number;
  falsePositiveCount: number;
};

export type RecommendationBacktest = {
  engineVersion: string;
  k: number;
  points: readonly RecommendationBacktestPoint[];
  precisionAtK: number;
  catalogCoverage: number;
  falsePositiveBurden: number;
  limitation: string;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function daysBetween(first: string, second: string) {
  return Math.max(0, Math.round(
    (Date.parse(`${dateOnly(second)}T00:00:00Z`) -
      Date.parse(`${dateOnly(first)}T00:00:00Z`)) /
      DAY_MS,
  ));
}

function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function latestMemory(
  memories: readonly RecommendationV2MemoryEvent[],
  asOfDate: string,
) {
  return memories
    .filter((event) => dateOnly(event.recordedAt) < dateOnly(asOfDate))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]
    ?.preference;
}

function stateAt(
  product: RecommendationV2Product,
  asOfDate: string,
): RecommendationProductState {
  const preference = latestMemory(product.memories ?? [], asOfDate);
  if (preference === "pause") return "paused";
  if (preference === "not_for_us") return "retired";
  return product.state ?? "normal";
}

function recentStreak(events: readonly RecommendationV2Event[], medianInterval: number | null) {
  if (!events.length) return 0;
  const maximumGap = Math.max(16, Math.round((medianInterval ?? 14) * 1.75));
  let streak = 1;
  for (let index = events.length - 1; index > 0; index -= 1) {
    if (daysBetween(events[index - 1].purchasedOn, events[index].purchasedOn) > maximumGap) break;
    streak += 1;
  }
  return streak;
}

function component(
  name: RecommendationScoreComponent["name"],
  points: number,
  maximum: number,
): RecommendationScoreComponent {
  return { name, points: clamp(points, 0, maximum), maximum };
}

function scoreProduct(
  product: RecommendationV2Product,
  asOfDate: string,
): RecommendationV2Assessment {
  const purchases = product.purchases
    .filter((event) => dateOnly(event.purchasedOn) < dateOnly(asOfDate))
    .sort((left, right) => left.purchasedOn.localeCompare(right.purchasedOn));
  const intervals = purchases.slice(1).map((event, index) =>
    daysBetween(purchases[index].purchasedOn, event.purchasedOn),
  );
  const medianIntervalDays = median(intervals);
  const intervalVariationDays = medianIntervalDays === null
    ? null
    : median(intervals.map((interval) => Math.abs(interval - medianIntervalDays)));
  const latest = purchases.at(-1);
  const daysSinceLastPurchase = latest
    ? daysBetween(latest.purchasedOn, asOfDate)
    : null;
  const streak = recentStreak(purchases, medianIntervalDays);
  const state = stateAt(product, asOfDate);
  const dueRatio = medianIntervalDays && daysSinceLastPurchase !== null
    ? daysSinceLastPurchase / medianIntervalDays
    : 0;
  const quantities = purchases.map((event) => event.quantityMilli);
  const typicalQuantity = median(quantities);
  const quantityVariation = typicalQuantity
    ? median(quantities.map((quantity) => Math.abs(quantity - typicalQuantity))) ?? typicalQuantity
    : null;
  const outcomes = (product.outcomes ?? []).filter(
    (event) => dateOnly(event.recordedAt) < dateOnly(asOfDate),
  );
  const positiveOutcomes = outcomes.filter((event) =>
    ["buy_again", "accepted", "kept", "fulfilled"].includes(event.value),
  ).length;
  const negativeOutcomes = outcomes.filter((event) =>
    ["removed", "waste", "regret", "duplicate"].includes(event.value),
  ).length;

  const statePoints: Record<RecommendationProductState, number> = {
    essential: 1_000,
    normal: 500,
    check_first: 350,
    seasonal: 250,
    one_off: 0,
    paused: 0,
    retired: 0,
  };
  const components = [
    component("frequency", purchases.length * 350, 2_100),
    component(
      "cadence",
      medianIntervalDays === null
        ? 0
        : 2_600 * Math.min(1, Math.max(0, dueRatio - 0.35) / 0.65) *
          (1 - Math.min(0.55, (intervalVariationDays ?? 0) / Math.max(1, medianIntervalDays))),
      2_600,
    ),
    component(
      "recency",
      daysSinceLastPurchase === null ? 0 : Math.max(0, 1_300 - daysSinceLastPurchase * 12),
      1_300,
    ),
    component("streak", streak * 250, 1_000),
    component(
      "quantity_stability",
      typicalQuantity && quantityVariation !== null
        ? 600 * (1 - Math.min(1, quantityVariation / typicalQuantity))
        : 0,
      600,
    ),
    component(
      "household_outcomes",
      400 + positiveOutcomes * 180 - negativeOutcomes * 300,
      1_400,
    ),
    component("product_state", statePoints[state], 1_000),
  ] as const;
  const suppressedReason =
    state === "paused" ? "Paused by the household" :
    state === "retired" ? "Marked not for this household" :
    state === "one_off" ? "One-off product" :
    purchases.length < 2 ? "Needs at least two prior purchases" :
    null;
  const scoreBps = suppressedReason
    ? 0
    : clamp(components.reduce((sum, entry) => sum + entry.points, 0), 0, 10_000);
  const section = state === "essential"
    ? "essentials"
    : state === "check_first"
      ? "check_first"
      : state === "seasonal"
        ? "consider"
        : "suggested";
  const reason = suppressedReason ?? (
    medianIntervalDays === null || daysSinceLastPurchase === null
      ? `${purchases.length} prior purchases; not enough cadence evidence yet.`
      : `${purchases.length} prior purchases; usually every ${medianIntervalDays} days; last bought ${daysSinceLastPurchase} days ago.`
  );
  return {
    productId: product.productId,
    itemNumber: product.itemNumber,
    name: product.name,
    state,
    eligible: !suppressedReason,
    suppressedReason,
    scoreBps,
    rank: null,
    section,
    reason,
    estimatedPriceCents: latest?.unitPriceCents ?? null,
    components,
    evidence: {
      purchaseCount: purchases.length,
      daysSinceLastPurchase,
      medianIntervalDays,
      intervalVariationDays,
      recentStreak: streak,
    },
  };
}

export function evaluateRecommendationCatalog(input: {
  products: readonly RecommendationV2Product[];
  asOfDate: string;
  attentionBudget?: number;
}): RecommendationV2Run {
  const attentionBudget = clamp(input.attentionBudget ?? 6, 1, 12);
  const scored = input.products.map((product) => scoreProduct(product, input.asOfDate));
  const ranked = scored
    .filter((assessment) => assessment.eligible)
    .sort((left, right) =>
      right.scoreBps - left.scoreBps || left.name.localeCompare(right.name),
    );
  const rankByProduct = new Map(ranked.map((assessment, index) => [assessment.productId, index + 1]));
  const assessments = scored.map((assessment) => ({
    ...assessment,
    rank: rankByProduct.get(assessment.productId) ?? null,
  }));
  const recommendations = assessments
    .filter((assessment) => assessment.rank !== null)
    .sort((left, right) => left.rank! - right.rank!)
    .filter((assessment) =>
      assessment.state === "essential" || assessment.rank! <= attentionBudget,
    );
  return {
    engineVersion: RECOMMENDATION_ENGINE_V2_VERSION,
    asOfDate: input.asOfDate,
    attentionBudget,
    catalogSize: assessments.length,
    eligibleCount: ranked.length,
    assessments,
    recommendations,
  };
}

export function backtestRecommendationCatalog(input: {
  products: readonly RecommendationV2Product[];
  targetDates: readonly string[];
  k?: number;
}): RecommendationBacktest {
  const k = clamp(input.k ?? 6, 1, 12);
  const points = [...new Set(input.targetDates.map(dateOnly))]
    .sort()
    .map((asOfDate) => {
      const purchasedProductIds = input.products
        .filter((product) => product.purchases.some(
          (event) => dateOnly(event.purchasedOn) === asOfDate,
        ))
        .map((product) => product.productId);
      const purchased = new Set(purchasedProductIds);
      const run = evaluateRecommendationCatalog({
        products: input.products,
        asOfDate,
        attentionBudget: k,
      });
      const recommendedProductIds = run.recommendations
        .slice(0, k)
        .map((assessment) => assessment.productId);
      const hits = recommendedProductIds.filter((productId) => purchased.has(productId));
      return {
        asOfDate,
        purchasedProductIds,
        recommendedProductIds,
        hits,
        precisionAtK: recommendedProductIds.length
          ? hits.length / recommendedProductIds.length
          : 0,
        falsePositiveCount: recommendedProductIds.length - hits.length,
      };
    });
  const assessedProducts = new Set(input.products.map((product) => product.productId));
  const productsWithHistory = new Set(input.products
    .filter((product) => product.purchases.length > 0)
    .map((product) => product.productId));
  return {
    engineVersion: RECOMMENDATION_ENGINE_V2_VERSION,
    k,
    points,
    precisionAtK: points.length
      ? points.reduce((sum, point) => sum + point.precisionAtK, 0) / points.length
      : 0,
    catalogCoverage: assessedProducts.size
      ? productsWithHistory.size / assessedProducts.size
      : 0,
    falsePositiveBurden: points.length
      ? points.reduce((sum, point) => sum + point.falsePositiveCount, 0) / points.length
      : 0,
    limitation: "A receipt purchase is an imperfect label: a useful suggestion may be skipped because stock remains at home, and an unplanned purchase may still appear on the receipt.",
  };
}
