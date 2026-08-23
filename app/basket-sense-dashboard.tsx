"use client";

/* eslint-disable @next/next/no-img-element -- household product photos use authenticated R2 URLs that are not compatible with next/image */

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DashboardProduct,
  DashboardProductCategory,
  DashboardReceiptLine,
  DashboardTransaction,
  DashboardViewData,
} from "./dashboard-types";
import type {
  HouseholdInsightsResponse,
  HouseholdListMutationResponse,
  HouseholdListResponse,
  ProductMemorySummary,
  ProductPrimaryImageSummary,
  TripReviewHistoryEntry,
  TripReviewHistoryResponse,
} from "./api/household/types";
import {
  isHouseholdListMutationAction,
  isHouseholdListSnapshotCurrent,
  mergeHouseholdListMutation,
  parseHouseholdListMutationResponse,
} from "./household-list-sync";
import { generatedProductIllustration } from "./generated-product-illustrations";
import {
  isProductCategoryKey,
  mergeHouseholdProductMetadata,
  scopedCategories,
  type HouseholdCatalogProductMetadata,
} from "./dashboard-product-metadata";
import {
  PRODUCT_CATEGORY_PRESENTATION,
  type ProductCategoryKey,
} from "./product-categories";
import {
  manualEstimateDraft,
  parseManualEstimateDollars,
} from "./manual-estimate";
import {
  ClosedLoopReview,
  ReceiptCelebration,
  ReceiptFlowDialog,
  type ClosedLoopSnapshot,
  type ReceiptStep,
} from "./receipt-review-flow";
import { ConfettiCanvas } from "./confetti-canvas";
import {
  productMemoryLabel,
  productMemorySuppressesSuggestion,
  type ProductMemoryPreference,
} from "./product-memory";
import {
  SaturdayPrepExperience,
  type SaturdayPrepItem,
} from "./saturday-prep";

type Tab = "overview" | "products" | "week" | "review";
type TripStatus = "planning" | "frozen" | "completed";
type ListItemSource =
  | "manual"
  | "recurring"
  | "predicted"
  | "consider"
  | "in_store";
type SyncStatus = "connecting" | "shared" | "refreshing" | "offline";
type DeferredViewStatus = "idle" | "loading" | "ready" | "error";
type ThemePreference = "system" | "warm" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type ProductImagePreview = {
  imageUrl: string;
  alt: string;
  label: string;
};

const HOUSEHOLD_REQUEST_TIMEOUT_MS = 10_000;

type DashboardUser = {
  displayName: string;
  email: string;
};

type HouseholdMember = {
  id: string;
  displayName: string;
  email: string;
  role: "owner" | "member";
};

type SharedTrip = {
  id: string;
  scheduledFor: string;
  status: TripStatus;
  listRevision: number;
  estimatedListTotalAtFreezeCents: number | null;
  estimatedPricedItemCountAtFreeze: number | null;
  estimatedUnpricedItemCountAtFreeze: number | null;
  frozenAt: string | null;
};

type SharedListItem = {
  id: string;
  tripId: string;
  productId: string | null;
  label: string;
  section: "essentials" | "suggested" | "check_first" | "consider";
  source: ListItemSource;
  recommendationReason: string | null;
  confidenceBps: number | null;
  included: boolean;
  checked: boolean;
  includedAtFreeze: boolean | null;
  addedAfterFreeze: boolean;
  estimatedPriceCents: number | null;
  quantityMilli: number;
  addedByMemberId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type SharedProduct = HouseholdCatalogProductMetadata & {
  id: string;
  categoryReviewedAt: string | null;
  categoryReviewedByDisplayName: string | null;
  latestPurchasedAt: string | null;
  latestRegularUnitPriceCents: number | null;
  latestPaidUnitPriceCents: number | null;
  latestDiscountUnitCents: number | null;
  purchaseCount: number;
  memory: ProductMemorySummary | null;
  image: ProductPrimaryImageSummary | null;
  updatedAt: string;
};

type HouseholdSnapshot = {
  historyRevision: string;
  household: { id: string; name: string; timeZone: string };
  currentUser: HouseholdMember;
  members: HouseholdMember[];
  currentTrip: SharedTrip;
  listItems: SharedListItem[];
  products: SharedProduct[];
  closedLoop?: ClosedLoopSnapshot | null;
  dashboard?: DashboardViewData;
};

type WriteRequest = {
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  successMessage: string;
  onFailure?: () => void;
};

type FailedWrite = {
  message: string;
  request: WriteRequest;
};

type BasketSenseDashboardProps = {
  user: DashboardUser;
  viewData: DashboardViewData;
  signOutHref: string;
  initialTab?: Tab;
  sandboxMode?: boolean;
};

type ProductSort = "alphabetical" | "recent" | "rank";

const primaryTabs = [
  { id: "week", label: "List", symbol: "✓" },
  { id: "overview", label: "Insights", symbol: "↗" },
  { id: "products", label: "Products", symbol: "▤" },
  { id: "review", label: "Recap", symbol: "?" },
] as const satisfies readonly { id: Tab; label: string; symbol: string }[];

const THEME_STORAGE_KEY = "basketsense-color-theme";
const AD_HOC_RECEIPT_STORAGE_KEY = "basketsense-ad-hoc-receipt-draft";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "warm" || value === "light" || value === "dark";
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

const fullDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function dateFromIso(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

function formatFullDate(value: string) {
  return fullDate.format(dateFromIso(value));
}

function formatShortDate(value: string) {
  return shortDate.format(dateFromIso(value));
}

function formatAuditRange(
  transactions: readonly DashboardTransaction[],
  through: string,
) {
  const start = transactions.reduce(
    (earliest, transaction) =>
      !earliest || transaction.purchasedOn < earliest
        ? transaction.purchasedOn
        : earliest,
    "",
  );
  return start
    ? `${formatShortDate(start)}–${formatFullDate(through)}`
    : `Through ${formatFullDate(through)}`;
}

function initials(value: string) {
  const parts = value
    .split(/[\s@._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0]}` : parts[0]?.slice(0, 2))
    ?.toUpperCase() ?? "BS";
}

function apiErrorMessage(responseBody: unknown, fallback: string) {
  if (
    responseBody &&
    typeof responseBody === "object" &&
    "error" in responseBody &&
    typeof responseBody.error === "string"
  ) {
    return responseBody.error;
  }
  return fallback;
}

function sourceLabel(source: ListItemSource) {
  if (source === "manual") return "Household addition";
  if (source === "recurring") return "Recurring essential";
  if (source === "predicted") return "Suggested from your purchase pattern";
  if (source === "consider") return "Optional household favorite";
  return "Added during this trip";
}

const IDEA_SECTIONS: readonly {
  key: SharedListItem["section"];
  label: string;
}[] = [
  {
    key: "essentials",
    label: "Essentials",
  },
  {
    key: "suggested",
    label: "Recommended",
  },
  {
    key: "check_first",
    label: "Check first",
  },
  {
    key: "consider",
    label: "Seasonal",
  },
];

function cadenceConfidence(confidenceBps: number | null) {
  if (confidenceBps === null) return null;
  if (confidenceBps >= 8000) return "High cadence confidence";
  if (confidenceBps >= 6000) return "Medium cadence confidence";
  return "Check-first signal";
}

function estimatedItemTotalCents(item: SharedListItem) {
  if (item.estimatedPriceCents === null) return null;
  return Math.round((item.estimatedPriceCents * item.quantityMilli) / 1000);
}

function normalizedCatalogLabel(value: string) {
  return value.trim().toLocaleLowerCase();
}

function catalogSelectionValue(
  product: SharedProduct,
  products: readonly SharedProduct[],
) {
  const hasDuplicateName =
    products.filter(
      (candidate) =>
        normalizedCatalogLabel(candidate.canonicalName) ===
        normalizedCatalogLabel(product.canonicalName),
    ).length > 1;
  return hasDuplicateName && product.costcoItemNumber
    ? `${product.canonicalName} · item ${product.costcoItemNumber}`
    : product.canonicalName;
}

function exactCatalogMatch(
  products: readonly SharedProduct[],
  label: string,
) {
  const normalized = normalizedCatalogLabel(label);
  if (!normalized) return null;
  const matches = products.filter((product) =>
    [
      product.canonicalName,
      product.latestRawDescription ?? "",
      product.costcoItemNumber ?? "",
      catalogSelectionValue(product, products),
    ].some((value) => normalizedCatalogLabel(value) === normalized),
  );
  return matches.length === 1 ? matches[0] : null;
}

function isReviewableProductCategory(
  value: string | null,
): value is ProductCategoryKey {
  return (
    isProductCategoryKey(value) &&
    value !== "fuel" &&
    value !== "optical_services" &&
    value !== "needs_review"
  );
}

const reviewableProductCategories = PRODUCT_CATEGORY_PRESENTATION.filter(
  (category) => isReviewableProductCategory(category.key),
);

function productDisplayName(product: DashboardProduct) {
  const raw = product.rawDescription.trim();
  const friendly = product.name.trim();
  return normalizedCatalogLabel(raw) === normalizedCatalogLabel(friendly)
    ? friendly
    : `${raw} (${friendly})`;
}

function InlineWriteError({
  failure,
  onRetry,
}: {
  failure: FailedWrite | undefined;
  onRetry: () => void;
}) {
  if (!failure) return null;
  return (
    <div className="inline-write-error" role="alert">
      <span>{failure.message}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function BasketSenseDashboard({
  user,
  viewData,
  signOutHref,
  initialTab = "week",
  sandboxMode = false,
}: BasketSenseDashboardProps) {
  const adHocReceiptStorageKey = `${AD_HOC_RECEIPT_STORAGE_KEY}:${
    sandboxMode ? "sandbox" : "household"
  }`;
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [household, setHousehold] = useState<HouseholdSnapshot | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [insightsStatus, setInsightsStatus] =
    useState<DeferredViewStatus>("idle");
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [pendingWrites, setPendingWrites] = useState<Set<string>>(
    () => new Set(),
  );
  const [failedWrites, setFailedWrites] = useState<Record<string, FailedWrite>>(
    {},
  );
  const [newItem, setNewItem] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [productCategory, setProductCategory] = useState<ProductCategoryKey | "all">(
    "all",
  );
  const [productSort, setProductSort] = useState<ProductSort>("rank");
  const [selectedProductId, setSelectedProductId] = useState(
    viewData.products[0]?.id ?? "",
  );
  const [productDetailOpen, setProductDetailOpen] = useState(false);
  const [reviewRequestedForProductId, setReviewRequestedForProductId] = useState<
    string | null
  >(null);
  const [reviewRequestedReceiptItemId, setReviewRequestedReceiptItemId] = useState<
    string | null
  >(null);
  const [productOrigin, setProductOrigin] = useState<"insights" | "products">(
    "products",
  );
  const [insightMonth, setInsightMonth] = useState<string>("all");
  const [insightCategoryKey, setInsightCategoryKey] =
    useState<ProductCategoryKey | null>(null);
  const [insightTransactionId, setInsightTransactionId] = useState<string | null>(
    null,
  );
  const [isDataDialogOpen, setIsDataDialogOpen] = useState(false);
  const [isReceiptFlowOpen, setIsReceiptFlowOpen] = useState(false);
  const [receiptFlowInitialStep, setReceiptFlowInitialStep] =
    useState<ReceiptStep>("capture");
  const [receiptFlowScope, setReceiptFlowScope] =
    useState<"current" | "latest" | "ad_hoc" | "correction">("current");
  const [reviewHistoryStatus, setReviewHistoryStatus] =
    useState<DeferredViewStatus>("idle");
  const [reviewHistoryError, setReviewHistoryError] = useState<string | null>(null);
  const [reviewHistory, setReviewHistory] = useState<TripReviewHistoryEntry[]>([]);
  const [selectedReviewReceiptId, setSelectedReviewReceiptId] = useState<string | null>(null);
  const [selectedTripReview, setSelectedTripReview] =
    useState<ClosedLoopSnapshot | null>(null);
  const [adHocReceiptId, setAdHocReceiptId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(adHocReceiptStorageKey);
    } catch {
      return null;
    }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [recentlyCheckedItemId, setRecentlyCheckedItemId] = useState<string | null>(
    null,
  );
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("system");
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const insightsRefreshPromise = useRef<Promise<void> | null>(null);
  const reviewHistoryPromise = useRef<Promise<void> | null>(null);
  const insightsRevision = useRef<string | null>(null);
  const coreHistoryRevision = useRef<string | null>(null);
  const listRefreshPromise = useRef<Promise<void> | null>(null);
  const pendingCheckedStates = useRef(new Map<string, boolean>());
  const toastTimer = useRef<number | null>(null);
  const checkedAnimationTimer = useRef<number | null>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const receiptFlowReturnFocus = useRef<HTMLElement | null>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavFirstLinkRef = useRef<HTMLButtonElement | null>(null);
  const productReturnFocus = useRef<string | null>(null);
  const listMoveFocus = useRef<{
    fallbackItemId: string | null;
    location: "active" | "ideas";
    action: "add" | "remove";
  } | null>(null);
  const effectiveViewData = useMemo(
    () =>
      mergeHouseholdProductMetadata(
        household?.dashboard ?? viewData,
        household?.products ?? [],
      ),
    [household?.dashboard, household?.products, viewData],
  );
  const resolvedTheme: ResolvedTheme =
    themePreference === "system"
      ? systemTheme
      : themePreference === "dark"
        ? "dark"
        : "light";

  const fetchHousehold = useCallback(
    async (url: string, init?: RequestInit) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        HOUSEHOLD_REQUEST_TIMEOUT_MS,
      );

      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error(
            "The shared list took too long to respond. Check your connection and retry.",
          );
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [],
  );

  function keepPendingCheckedStates(listItems: SharedListItem[]) {
    if (!pendingCheckedStates.current.size) return listItems;

    return listItems.map((item) => {
      const expectedChecked = pendingCheckedStates.current.get(item.id);
      if (expectedChecked === undefined) return item;
      if (item.checked === expectedChecked) {
        pendingCheckedStates.current.delete(item.id);
        return item;
      }
      return { ...item, checked: expectedChecked };
    });
  }

  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () =>
      setSystemTheme(colorScheme.matches ? "dark" : "light");
    const syncStoredTheme = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setThemePreference(isThemePreference(event.newValue) ? event.newValue : "system");
    };

    const hydrateTheme = window.setTimeout(() => {
      updateSystemTheme();
      try {
        const savedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (isThemePreference(savedPreference)) {
          setThemePreference(savedPreference);
        }
      } catch {
        // The system preference remains the safe default when storage is blocked.
      }
      setThemeReady(true);
    }, 0);

    colorScheme.addEventListener("change", updateSystemTheme);
    window.addEventListener("storage", syncStoredTheme);
    return () => {
      window.clearTimeout(hydrateTheme);
      colorScheme.removeEventListener("change", updateSystemTheme);
      window.removeEventListener("storage", syncStoredTheme);
    };
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    if (themePreference === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = themePreference;
    }
    document.documentElement.style.colorScheme = resolvedTheme;

    try {
      if (themePreference === "system") {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
      }
    } catch {
      // Theme switching still works for this visit when storage is unavailable.
    }
  }, [resolvedTheme, themePreference, themeReady]);

  const refreshHousehold = useCallback(async (quiet = false, forceFresh = false) => {
    if (listRefreshPromise.current) await listRefreshPromise.current;
    if (refreshPromise.current) {
      if (!forceFresh) return refreshPromise.current;
      await refreshPromise.current;
    }

    const refresh = (async () => {
      if (!quiet) {
        setSyncStatus((status) => (status === "shared" ? "refreshing" : "connecting"));
      }
      try {
        const response = await fetchHousehold(
          sandboxMode
            ? "/api/household?view=core&sandbox=1"
            : "/api/household?view=core",
          {
          headers: { Accept: "application/json" },
          cache: "no-store",
          },
        );
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
          throw new Error(
            apiErrorMessage(body, "The shared household could not be reached."),
          );
        }
        const snapshot = body as HouseholdSnapshot;
        const historyChanged =
          coreHistoryRevision.current !== null &&
          coreHistoryRevision.current !== snapshot.historyRevision;
        coreHistoryRevision.current = snapshot.historyRevision;
        const keepDashboard =
          insightsRevision.current === snapshot.historyRevision;
        setHousehold((current) => ({
          ...snapshot,
          dashboard: keepDashboard ? current?.dashboard : undefined,
          listItems: keepPendingCheckedStates(snapshot.listItems),
        }));
        if (historyChanged) {
          setInsightsStatus("idle");
          setInsightsError(null);
        }
        setSyncStatus("shared");
        setSyncError(null);
      } catch (error) {
        setSyncStatus("offline");
        setSyncError(
          error instanceof Error
            ? error.message
            : "The shared household could not be reached.",
        );
      }
    })().finally(() => {
      refreshPromise.current = null;
    });

    refreshPromise.current = refresh;
    return refresh;
  }, [fetchHousehold, sandboxMode]);

  const refreshInsights = useCallback(async () => {
    if (insightsRefreshPromise.current) {
      return insightsRefreshPromise.current;
    }

    const refresh = (async () => {
      setInsightsStatus("loading");
      setInsightsError(null);
      try {
        const response = await fetchHousehold(
          sandboxMode
            ? "/api/household?view=insights&sandbox=1"
            : "/api/household?view=insights",
          {
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
          throw new Error(
            apiErrorMessage(body, "Insights could not be loaded."),
          );
        }
        if (
          !body ||
          typeof body !== "object" ||
          !("historyRevision" in body) ||
          typeof body.historyRevision !== "string" ||
          !("dashboard" in body) ||
          !body.dashboard ||
          typeof body.dashboard !== "object"
        ) {
          throw new Error("Insights returned an unexpected response.");
        }

        const snapshot = body as HouseholdInsightsResponse;
        insightsRevision.current = snapshot.historyRevision;
        setHousehold((current) => {
          if (!current) return current;
          return { ...current, dashboard: snapshot.dashboard };
        });
        setInsightsStatus("ready");
      } catch (error) {
        setInsightsStatus("error");
        setInsightsError(
          error instanceof Error ? error.message : "Insights could not be loaded.",
        );
      }
    })().finally(() => {
      insightsRefreshPromise.current = null;
    });

    insightsRefreshPromise.current = refresh;
    return refresh;
  }, [fetchHousehold, sandboxMode]);

  const refreshHouseholdList = useCallback(
    async (tripId: string, revision: number) => {
      if (refreshPromise.current) return refreshPromise.current;
      if (listRefreshPromise.current) return listRefreshPromise.current;

      let shouldRefreshFullSnapshot = false;
      const refresh = (async () => {
        try {
          const response = await fetchHousehold(
            `/api/household?scope=list&tripId=${encodeURIComponent(tripId)}&revision=${revision}${sandboxMode ? "&sandbox=1" : ""}`,
            {
              headers: { Accept: "application/json" },
              cache: "no-store",
            },
          );
          if (response.status === 204) {
            setSyncStatus("shared");
            setSyncError(null);
            return;
          }
          const body = (await response.json().catch(() => null)) as unknown;
          if (!response.ok) {
            throw new Error(
              apiErrorMessage(body, "The shared list could not be refreshed."),
            );
          }
          if (
            !body ||
            typeof body !== "object" ||
            !("currentTrip" in body) ||
            !("listItems" in body) ||
            !Array.isArray(body.listItems)
          ) {
            throw new Error("The shared list returned an unexpected response.");
          }

          const snapshot = body as HouseholdListResponse;
          if (snapshot.currentTrip.id !== tripId) return;
          setHousehold((current) => {
            if (
              !current ||
              !isHouseholdListSnapshotCurrent(
                current.currentTrip,
                snapshot.currentTrip,
              )
            ) {
              return current;
            }
            return {
              ...current,
              currentTrip: snapshot.currentTrip,
              listItems: keepPendingCheckedStates(snapshot.listItems),
            };
          });
          setSyncStatus("shared");
          setSyncError(null);
          shouldRefreshFullSnapshot = snapshot.currentTrip.status === "completed";
        } catch (error) {
          setSyncStatus("offline");
          setSyncError(
            error instanceof Error
              ? error.message
              : "The shared list could not be refreshed.",
          );
        }
      })().finally(() => {
        listRefreshPromise.current = null;
        if (shouldRefreshFullSnapshot) void refreshHousehold(true, true);
      });

      listRefreshPromise.current = refresh;
      return refresh;
    },
    [fetchHousehold, refreshHousehold, sandboxMode],
  );

  useEffect(() => {
    void refreshHousehold();

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshHousehold(true);
    };
    const refreshOnFocus = () => void refreshHousehold(true);
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("online", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("online", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshHousehold]);

  useEffect(() => {
    const needsInsights =
      activeTab === "overview" || activeTab === "products" || isDataDialogOpen;
    if (
      needsInsights &&
      household &&
      !household.dashboard &&
      insightsStatus === "idle"
    ) {
      void refreshInsights();
    }
  }, [
    activeTab,
    household,
    insightsStatus,
    isDataDialogOpen,
    refreshInsights,
  ]);

  useEffect(() => {
    const refreshPeriodMs = activeTab === "week" ? 5_000 : 15_000;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible" || pendingWrites.size) return;
      const tripId = household?.currentTrip.id;
      const revision = household?.currentTrip.listRevision;
      if (activeTab === "week" && tripId && revision !== undefined) {
        void refreshHouseholdList(tripId, revision);
      } else {
        void refreshHousehold(true);
      }
    }, refreshPeriodMs);

    return () => window.clearInterval(interval);
  }, [
    activeTab,
    household?.currentTrip.id,
    household?.currentTrip.listRevision,
    pendingWrites.size,
    refreshHousehold,
    refreshHouseholdList,
  ]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      if (checkedAnimationTimer.current !== null) {
        window.clearTimeout(checkedAnimationTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (activeTab !== "overview" || productDetailOpen || !productReturnFocus.current) {
      return;
    }

    const productId = productReturnFocus.current;
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-open-product-id]"),
      ).find((element) => element.dataset.openProductId === productId);

      if (target) {
        target.focus();
        productReturnFocus.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, productDetailOpen]);

  useEffect(() => {
    const request = listMoveFocus.current;
    if (!request || activeTab !== "week") return;

    const frame = window.requestAnimationFrame(() => {
      const row = request.fallbackItemId
        ? Array.from(
            document.querySelectorAll<HTMLElement>("[data-list-item-focus]"),
          ).find(
            (element) =>
              element.dataset.listItemFocus === request.fallbackItemId &&
              element.dataset.listItemLocation === request.location,
          )
        : null;
      const target =
        row?.querySelector<HTMLElement>(
          `[data-list-focus-action="${request.action}"]`,
        ) ??
        (request.location === "active"
          ? document.getElementById("active-list-title")
          : document.getElementById("ideas-title"));
      target?.focus({ preventScroll: true });
      listMoveFocus.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, household?.listItems]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const frame = window.requestAnimationFrame(() => mobileNavFirstLinkRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileNavOpen(false);
      window.requestAnimationFrame(() => mobileNavTriggerRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavOpen]);

  function flash(message: string) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 2_600);
  }

  function changeTab(tab: Tab) {
    prepareDeferredTab(tab);
    setActiveTab(tab);
    setMobileNavOpen(false);
    if (tab === "products") {
      setProductOrigin("products");
      setProductDetailOpen(false);
      productReturnFocus.current = null;
    }
    window.scrollTo({ top: 0 });
  }

  function changeSandboxMode(event: ReactMouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    window.location.assign(sandboxMode ? "/" : "/?sandbox=1");
  }

  function prepareDeferredTab(tab: Tab) {
    if (
      (tab === "overview" || tab === "products") &&
      household &&
      !household.dashboard &&
      insightsStatus === "idle"
    ) {
      void refreshInsights();
    }
  }

  function openProduct(productId: string) {
    productReturnFocus.current = productId;
    setSelectedProductId(productId);
    setProductSearch("");
    setProductCategory("all");
    setReviewRequestedForProductId(null);
    setReviewRequestedReceiptItemId(null);
    setProductDetailOpen(true);
    setProductOrigin("insights");
    setActiveTab("products");
    window.scrollTo({ top: 0 });
  }

  function openProductReview(productId: string, receiptItemId: string) {
    productReturnFocus.current = productId;
    setSelectedProductId(productId);
    setProductSearch("");
    setProductCategory("all");
    setReviewRequestedForProductId(productId);
    setReviewRequestedReceiptItemId(receiptItemId);
    setProductDetailOpen(true);
    setProductOrigin("insights");
    setActiveTab("products");
    window.scrollTo({ top: 0 });
  }

  function closeProductDetail() {
    setProductDetailOpen(false);
    setReviewRequestedForProductId(null);
    setReviewRequestedReceiptItemId(null);
    if (productOrigin === "insights") {
      setActiveTab("overview");
    }
    window.scrollTo({ top: 0 });
  }

  function openTransaction(transactionId: string) {
    setInsightCategoryKey(null);
    setInsightTransactionId(transactionId);
    setActiveTab("overview");
    window.scrollTo({ top: 0 });
  }

  const openDataDialog = useCallback(() => {
    dialogReturnFocus.current = document.activeElement as HTMLElement | null;
    setIsDataDialogOpen(true);
  }, []);

  const closeDataDialog = useCallback(() => {
    setIsDataDialogOpen(false);
  }, []);

  const openReceiptFlow = useCallback(
    (
      step: ReceiptStep = "capture",
      scope: "current" | "latest" | "ad_hoc" | "correction" = "current",
    ) => {
      receiptFlowReturnFocus.current = document.activeElement as HTMLElement | null;
      setReceiptFlowInitialStep(step);
      setReceiptFlowScope(scope);
      setIsReceiptFlowOpen(true);
    },
    [],
  );

  const openAdHocReceiptFlow = useCallback(() => {
    openReceiptFlow("capture", "ad_hoc");
  }, [openReceiptFlow]);

  const rememberAdHocReceipt = useCallback((receiptId: string | null) => {
    setAdHocReceiptId(receiptId);
    try {
      if (receiptId) window.localStorage.setItem(adHocReceiptStorageKey, receiptId);
      else window.localStorage.removeItem(adHocReceiptStorageKey);
    } catch {
      // Current-visit state remains available when local storage is blocked.
    }
  }, [adHocReceiptStorageKey]);

  const closeReceiptFlow = useCallback(() => {
    setIsReceiptFlowOpen(false);
    window.setTimeout(() => receiptFlowReturnFocus.current?.focus(), 0);
  }, []);

  const openTripReview = useCallback(() => {
    setIsReceiptFlowOpen(false);
    setActiveTab("review");
    window.scrollTo({ top: 0 });
  }, []);

  function invalidateInsights() {
    insightsRevision.current = null;
    setHousehold((current) =>
      current ? { ...current, dashboard: undefined } : current,
    );
    setInsightsStatus("idle");
    setInsightsError(null);
  }

  async function performWrite(key: string, request: WriteRequest) {
    setPendingWrites((current) => new Set(current).add(key));
    setFailedWrites((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    try {
      const response = await fetchHousehold("/api/household", {
        method: request.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          sandboxMode ? { ...request.body, sandbox: true } : request.body,
        ),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(apiErrorMessage(body, "That change was not saved."));
      }
      const action = request.body.action;
      if (isHouseholdListMutationAction(action)) {
        const mutation = parseHouseholdListMutationResponse(body);
        if (!mutation) {
          throw new Error("The saved list change returned an unexpected response.");
        }
        applyListMutation(mutation);
      } else {
        invalidateInsights();
        await refreshHousehold(true, true);
      }
      flash(request.successMessage);
      return true;
    } catch (error) {
      request.onFailure?.();
      const failure = {
        message:
          error instanceof Error ? error.message : "That change was not saved.",
        request,
      };
      setFailedWrites((current) => ({ ...current, [key]: failure }));
      await refreshHousehold(true, true);
      return false;
    } finally {
      setPendingWrites((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function applyListMutation(mutation: HouseholdListMutationResponse) {
    const expectedChecked = pendingCheckedStates.current.get(mutation.item.id);
    if (
      expectedChecked === undefined ||
      mutation.item.checked === expectedChecked
    ) {
      pendingCheckedStates.current.delete(mutation.item.id);
    }
    setHousehold((current) => {
      if (!current) return current;
      const merged = mergeHouseholdListMutation(
        current.currentTrip,
        current.listItems,
        mutation,
      );
      return merged ? { ...current, ...merged } : current;
    });
    setSyncStatus("shared");
    setSyncError(null);
  }

  function retryWrite(key: string) {
    const failure = failedWrites[key];
    if (failure) void performWrite(key, failure.request);
  }

  function toggleIncluded(item: SharedListItem, trigger?: HTMLElement | null) {
    const key = `item-${item.id}`;
    const nextIncluded = !item.included;
    const shoppingStarted = household?.currentTrip.status === "frozen";
    const sourceRow = trigger?.closest<HTMLElement>("[data-list-item-focus]");
    const location = sourceRow?.dataset.listItemLocation;
    if (sourceRow && (location === "active" || location === "ideas")) {
      const sourceRows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-list-item-focus]"),
      ).filter((row) => row.dataset.listItemLocation === location);
      const currentIndex = sourceRows.indexOf(sourceRow);
      const fallbackRow =
        sourceRows.at(currentIndex + 1) ?? sourceRows.at(currentIndex - 1);
      listMoveFocus.current = {
        fallbackItemId: fallbackRow?.dataset.listItemFocus ?? null,
        location,
        action: nextIncluded ? "add" : "remove",
      };
    }
    setHousehold((current) =>
      current
        ? {
            ...current,
            listItems: current.listItems.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    included: !item.included,
                    checked: false,
                  }
                : candidate,
            ),
          }
        : current,
    );
    void performWrite(key, {
      method: "PATCH",
      body: {
        action: "set_item_included",
        itemId: item.id,
        included: nextIncluded,
      },
      successMessage: nextIncluded
        ? `${item.label} added to the Active List`
        : shoppingStarted
          ? `${item.label} removed from the shopping list`
          : `${item.label} moved to Ideas`,
    });
  }

  function toggleChecked(item: SharedListItem) {
    const key = `item-${item.id}`;
    const nextChecked = !item.checked;
    if (!item.checked) {
      if (checkedAnimationTimer.current !== null) {
        window.clearTimeout(checkedAnimationTimer.current);
      }
      setRecentlyCheckedItemId(item.id);
      checkedAnimationTimer.current = window.setTimeout(() => {
        setRecentlyCheckedItemId(null);
        checkedAnimationTimer.current = null;
      }, 500);
    }
    pendingCheckedStates.current.set(item.id, nextChecked);
    setHousehold((current) =>
      current
        ? {
            ...current,
            listItems: current.listItems.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, checked: nextChecked }
                : candidate,
            ),
          }
        : current,
    );
    return performWrite(key, {
      method: "PATCH",
      body: {
        action: "set_item_checked",
        itemId: item.id,
        checked: nextChecked,
      },
      successMessage: item.checked ? "Item unchecked" : "Item checked off",
      onFailure: () => {
        pendingCheckedStates.current.delete(item.id);
      },
    });
  }

  async function setManualEstimate(
    item: SharedListItem,
    estimatedPriceCents: number,
  ) {
    const key = `estimate-${item.id}`;
    setHousehold((current) =>
      current
        ? {
            ...current,
            listItems: current.listItems.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, estimatedPriceCents }
                : candidate,
            ),
          }
        : current,
    );
    return performWrite(key, {
      method: "POST",
      body: {
        action: "add_list_item",
        tripId: item.tripId,
        label: item.label,
        productId: item.productId,
        source: item.source,
        section: item.section,
        included: true,
        estimatedPriceCents,
        quantityMilli: item.quantityMilli,
      },
      successMessage: `${item.label} estimate added for this trip`,
    });
  }

  async function addManualItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = newItem.trim();
    if (!label || !household) return;
    const catalogProduct = exactCatalogMatch(household.products, label);
    const normalizedLabel = normalizedCatalogLabel(
      catalogProduct?.canonicalName ?? label,
    );
    const existingItem = household.listItems.find((item) =>
      catalogProduct
        ? item.productId === catalogProduct.id
        : normalizedCatalogLabel(item.label) === normalizedLabel,
    );

    if (existingItem) {
      setNewItem("");
      if (existingItem.included) {
        flash(`${existingItem.label} is already on the active list`);
      } else {
        toggleIncluded(existingItem);
      }
      return;
    }

    const request: WriteRequest = {
      method: "POST",
      body: {
        action: "add_list_item",
        tripId: household.currentTrip.id,
        label,
        productId: catalogProduct?.id ?? null,
        source:
          household.currentTrip.status === "frozen" ? "in_store" : "manual",
        section: "essentials",
        included: true,
      },
      successMessage:
        household.currentTrip.status === "frozen"
          ? `${label} added during this trip`
          : `${label} added to the shared list`,
    };
    const saved = await performWrite("quick-add", request);
    if (saved) setNewItem("");
  }

  async function addCatalogProductToList(product: SharedProduct) {
    if (!household) return false;
    const existingItem = household.listItems.find(
      (item) => item.productId === product.id,
    );
    if (existingItem?.included) {
      flash(`${existingItem.label} is already on the active list`);
      return true;
    }
    return await performWrite(`product-list-${product.id}`, {
      method: "POST",
      body: {
        action: "add_list_item",
        tripId: household.currentTrip.id,
        productId: product.id,
        label: product.canonicalName,
        source: household.currentTrip.status === "frozen" ? "in_store" : "manual",
        section: "essentials",
        included: true,
      },
      successMessage:
        household.currentTrip.status === "frozen"
          ? `${product.canonicalName} added during this trip`
          : `${product.canonicalName} added to the shared list`,
    });
  }

  async function confirmProductMetadata(
    product: SharedProduct,
    canonicalName: string,
    category: ProductCategoryKey,
  ) {
    return await performWrite(`product-review-${product.id}`, {
      method: "PATCH",
      body: {
        action: "confirm_product_metadata",
        productId: product.id,
        canonicalName,
        category,
        expectedUpdatedAt: product.updatedAt,
      },
      successMessage: `${canonicalName} saved to the household catalog`,
    });
  }

  async function confirmReceiptProduct(
    receiptItemId: string,
    canonicalName: string,
    category: ProductCategoryKey,
  ) {
    return await performWrite(`receipt-product-${receiptItemId}`, {
      method: "PATCH",
      body: {
        action: "confirm_receipt_product",
        receiptItemId,
        canonicalName,
        category,
      },
      successMessage: `${canonicalName} added to the household catalog`,
    });
  }

  async function setProductMemory(
    product: SharedProduct,
    preference: ProductMemoryPreference,
    note: string,
  ) {
    return await performWrite(`product-memory-${product.id}`, {
      method: "POST",
      body: {
        action: "set_product_memory",
        productId: product.id,
        preference,
        note: note || null,
      },
      successMessage: `${product.canonicalName} memory saved for future Prep`,
    });
  }

  function freezeTrip() {
    if (!household) return;
    void performWrite("freeze-trip", {
      method: "PATCH",
      body: {
        action: "freeze_trip",
        tripId: household.currentTrip.id,
      },
      successMessage: "Shopping started — today’s planned list is captured",
    });
  }

  function unfreezeTrip() {
    if (!household) return;
    void performWrite("unfreeze-trip", {
      method: "PATCH",
      body: {
        action: "unfreeze_trip",
        tripId: household.currentTrip.id,
      },
      successMessage: "Back in planning — the live list is ready to review",
    });
  }

  async function reopenSandboxTrip(receiptId: string, tripId: string) {
    const reopened = await performWrite("reopen-sandbox-trip", {
      method: "PATCH",
      body: {
        action: "reopen_sandbox_trip",
        receiptId,
        tripId,
      },
      successMessage: "Sandbox test reopened — update the list, start shopping, then recheck the receipt",
    });
    if (reopened) {
      setIsReceiptFlowOpen(false);
      setActiveTab("week");
      window.scrollTo({ top: 0 });
    }
    return reopened;
  }

  async function copyList() {
    const included = household?.listItems.filter((item) => item.included) ?? [];
    const text = included
      .map((item) => `${item.checked ? "✓" : "○"} ${item.label}`)
      .join("\n");
    if (!text) {
      flash("Add an item before copying the list");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      flash("List copied");
    } catch {
      flash("Copy is not available on this device");
    }
  }

  const closedLoop = household?.closedLoop ?? null;
  const loadTripReview = useCallback(async (receiptId: string, force = false) => {
    setSelectedReviewReceiptId(receiptId);
    setReviewHistoryStatus("loading");
    if (!force && closedLoop?.receipt?.id === receiptId) {
      setSelectedTripReview(closedLoop);
      setReviewHistoryStatus("ready");
      return;
    }
    setSelectedTripReview(null);
    setReviewHistoryError(null);
    try {
      const response = await fetchHousehold(
        `/api/household?view=trip-review&receiptId=${encodeURIComponent(receiptId)}${sandboxMode ? "&sandbox=1" : ""}`,
        { headers: { Accept: "application/json" }, cache: "no-store" },
      );
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        closedLoop?: unknown;
      } | null;
      if (!response.ok || !body?.closedLoop || typeof body.closedLoop !== "object") {
        throw new Error(apiErrorMessage(body, "This trip review could not be loaded."));
      }
      setSelectedTripReview(body.closedLoop as ClosedLoopSnapshot);
      setReviewHistoryStatus("ready");
    } catch (error) {
      setReviewHistoryStatus("error");
      setReviewHistoryError(
        error instanceof Error ? error.message : "This trip review could not be loaded.",
      );
    }
  }, [closedLoop, fetchHousehold, sandboxMode]);

  const loadReviewHistory = useCallback(async (force = false) => {
    if (reviewHistoryPromise.current) return reviewHistoryPromise.current;
    if (!force && reviewHistoryStatus === "ready") return;
    const refresh = (async () => {
      setReviewHistoryStatus("loading");
      setReviewHistoryError(null);
      try {
        const response = await fetchHousehold(
          sandboxMode
            ? "/api/household?view=review-history&sandbox=1"
            : "/api/household?view=review-history",
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as
          | (Partial<TripReviewHistoryResponse> & { error?: unknown })
          | null;
        if (!response.ok || !Array.isArray(body?.history)) {
          throw new Error(apiErrorMessage(body, "Trip review history could not be loaded."));
        }
        setReviewHistory(body.history);
        const preferredId =
          selectedReviewReceiptId && body.history.some((entry) => entry.receiptId === selectedReviewReceiptId)
            ? selectedReviewReceiptId
            : body.history[0]?.receiptId ?? null;
        if (preferredId) await loadTripReview(preferredId, force);
        else {
          setSelectedReviewReceiptId(null);
          setSelectedTripReview(null);
        }
        setReviewHistoryStatus("ready");
      } catch (error) {
        setReviewHistoryStatus("error");
        setReviewHistoryError(
          error instanceof Error ? error.message : "Trip review history could not be loaded.",
        );
      }
    })().finally(() => {
      reviewHistoryPromise.current = null;
    });
    reviewHistoryPromise.current = refresh;
    return refresh;
  }, [fetchHousehold, loadTripReview, reviewHistoryStatus, sandboxMode, selectedReviewReceiptId]);

  useEffect(() => {
    if (activeTab === "review" && reviewHistoryStatus === "idle") {
      void loadReviewHistory();
    }
  }, [activeTab, loadReviewHistory, reviewHistoryStatus]);

  const selectedReviewEntry = reviewHistory.find(
    (entry) => entry.receiptId === selectedReviewReceiptId,
  ) ?? null;
  const displayedTripReview = selectedTripReview ?? (
    !selectedReviewReceiptId || closedLoop?.receipt?.id === selectedReviewReceiptId
      ? closedLoop
      : null
  );

  const currentTripClosedLoop =
    closedLoop?.receipt?.tripId === household?.currentTrip.id ? closedLoop : null;
  const openReviewQuestions = (closedLoop?.questions ?? [])
    .slice(0, 3)
    .filter(
      (question) =>
        !["answered", "resolved", "skipped", "dismissed"].includes(
          question.status ?? "open",
        ),
    ).length;
  const receiptCheckCount = !household
    ? 0
    : !closedLoop?.receipt || closedLoop.comparison?.isProvisional
      ? 1
      : 0;
  const openReviewCount = openReviewQuestions + receiptCheckCount;
  const members = household?.members.length ? household.members : [];
  const shownMembers = members.slice(0, 2);
  const visibleUser = household?.currentUser ?? {
    id: "server-user",
    displayName: user.displayName,
    email: user.email,
    role: "member" as const,
  };
  const insightsAvailable = Boolean(household?.dashboard);
  const visibleTabs = primaryTabs;

  return (
    <div className="app-shell">
      <aside className="side-rail" aria-label="Primary navigation">
        <button
          className="brand"
          onClick={() => changeTab("week")}
          aria-label="Open this Saturday’s list"
        >
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>
            <strong>BasketSense</strong>
            <small>Our Costco companion</small>
          </span>
        </button>

        <nav className="desktop-nav">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => changeTab(tab.id)}
              onFocus={() => prepareDeferredTab(tab.id)}
              onPointerEnter={() => prepareDeferredTab(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
            >
              <span className="nav-glyph" aria-hidden="true">
                {tab.symbol}
              </span>
              <span>{tab.label}</span>
              {tab.id === "review" && openReviewCount > 0 ? (
                <span className="nav-count">{openReviewCount}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="rail-footer">
          <div className="household-row">
            {shownMembers.length ? (
              shownMembers.map((member, index) => (
                <span
                  className={`avatar ${index === 0 ? "avatar-one" : "avatar-two"}`}
                  key={member.id}
                  title={member.displayName}
                >
                  {initials(member.displayName)}
                </span>
              ))
            ) : (
              <>
                <span className="avatar avatar-one">{initials(user.displayName)}</span>
                <span className="avatar avatar-two" aria-hidden="true">
                  +1
                </span>
              </>
            )}
            <span>
              <strong>{sandboxMode ? "Owner test sandbox" : "Our household"}</strong>
              <small>Connected as {visibleUser.displayName}</small>
            </span>
          </div>
          <button className="text-button" onClick={openDataDialog}>
            Data &amp; privacy
          </button>
          {household?.currentUser.role === "owner" ? (
            <a
              className="text-button"
              href={sandboxMode ? "/" : "/?sandbox=1"}
              onClick={changeSandboxMode}
            >
              {sandboxMode ? "Leave test sandbox" : "Receipt test sandbox"}
            </a>
          ) : null}
          <a className="text-button sign-out-link" href={signOutHref}>
            Sign out
          </a>
        </div>
      </aside>

      <main className="main-canvas">
        {sandboxMode ? (
          <div className="test-mode-banner" role="status">
            <strong>Owner-only receipt test sandbox</strong>
            <span>Test receipts and finalized trips stay separate from shared household history and totals.</span>
          </div>
        ) : null}
        <header className="topbar">
          <div className="topbar-context">
            <span className="mobile-kicker">BasketSense</span>
          </div>
          <div className="topbar-actions">
            <label
              className={`theme-control theme-${themePreference}`}
              title={
                themePreference === "system"
                  ? `Following this device’s ${resolvedTheme} preference`
                  : themePreference === "warm"
                    ? "Warm Pantry theme saved on this device"
                    : `${resolvedTheme === "dark" ? "Dark" : "Light"} theme saved on this device`
              }
            >
              <span className="theme-control-swatch" aria-hidden="true" />
              <span className="sr-only">Color theme</span>
              <select
                className="theme-select"
                aria-label="Color theme"
                value={themePreference}
                onChange={(event) => setThemePreference(event.target.value as ThemePreference)}
              >
                <option value="system">Auto</option>
                <option value="warm">Warm</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <button className="secondary-button import-button" onClick={openDataDialog}>
              Data status
            </button>
            <button
              className="mobile-receipt-button"
              onClick={openDataDialog}
              aria-label="Open data and privacy status"
            >
              Data
            </button>
          </div>
        </header>

        {activeTab === "week" ? (
        <ThisWeekTab
            household={household}
            syncStatus={syncStatus}
            syncError={syncError}
            suggestionPlanDate={
              household?.dashboard?.suggestionPlanDate ??
              household?.currentTrip.scheduledFor ??
              viewData.suggestionPlanDate
            }
            newItem={newItem}
            setNewItem={setNewItem}
            pendingWrites={pendingWrites}
          failedWrites={failedWrites}
          onRetry={retryWrite}
          onRetryLoad={() => void refreshHousehold(false, true)}
            onAdd={addManualItem}
            onSetEstimate={setManualEstimate}
            onToggleIncluded={toggleIncluded}
            onToggleChecked={toggleChecked}
            recentlyCheckedItemId={recentlyCheckedItemId}
            onFreeze={freezeTrip}
            onUnfreeze={unfreezeTrip}
            onCopy={copyList}
            onOpenReceipt={(step) => openReceiptFlow(step, "current")}
          />
        ) : null}

        {activeTab === "overview" && insightsAvailable ? (
          <OverviewTab
            viewData={effectiveViewData}
            selectedMonth={insightMonth}
            setSelectedMonth={setInsightMonth}
            selectedCategoryKey={insightCategoryKey}
            setSelectedCategoryKey={setInsightCategoryKey}
            selectedTransactionId={insightTransactionId}
            setSelectedTransactionId={setInsightTransactionId}
            onOpenProduct={openProduct}
            onReviewProduct={openProductReview}
            onAddCostcoPurchase={openAdHocReceiptFlow}
          />
        ) : activeTab === "overview" ? (
          <DeferredView
            label="Insights"
            error={insightsError ?? syncError}
            onRetry={() => void refreshInsights()}
          />
        ) : null}

        {activeTab === "products" && insightsAvailable ? (
          <ProductsTab
            products={effectiveViewData.products}
            catalogProducts={household?.products ?? []}
            search={productSearch}
            setSearch={setProductSearch}
            category={productCategory}
            setCategory={setProductCategory}
            sort={productSort}
            setSort={setProductSort}
            selectedProductId={selectedProductId}
            setSelectedProductId={setSelectedProductId}
            detailOpen={productDetailOpen}
            setDetailOpen={setProductDetailOpen}
            reviewRequestedForProductId={reviewRequestedForProductId}
            onReviewRequestHandled={() => setReviewRequestedForProductId(null)}
            reviewRequestedReceiptItemId={reviewRequestedReceiptItemId}
            onReviewCompleted={() => setReviewRequestedReceiptItemId(null)}
            categories={effectiveViewData.productCategories}
            auditThrough={effectiveViewData.audit.through}
            openedFromInsights={productOrigin === "insights"}
            onBack={closeProductDetail}
            onConfirmProduct={confirmProductMetadata}
            onConfirmReceiptProduct={confirmReceiptProduct}
            onSetProductMemory={setProductMemory}
            listItems={household?.listItems ?? []}
            onAddToList={addCatalogProductToList}
            failedWrites={failedWrites}
            onOpenTransaction={openTransaction}
            onImagesUpdated={async () => {
              await refreshHousehold(true, true);
            }}
          />
        ) : activeTab === "products" ? (
          <DeferredView
            label="Products"
            error={insightsError ?? syncError}
            onRetry={() => void refreshInsights()}
          />
        ) : null}

        {activeTab === "review" ? (
          <ReviewTab
            closedLoop={displayedTripReview}
            history={reviewHistory}
            selectedReceiptId={selectedReviewReceiptId}
            historyStatus={reviewHistoryStatus}
            historyError={reviewHistoryError}
            canCorrect={household?.currentUser.role === "owner"}
            connected={Boolean(household) && syncStatus !== "offline"}
            sandboxMode={sandboxMode}
            onSelectReceipt={(receiptId) => void loadTripReview(receiptId)}
            onOpenReceipt={(step) => openReceiptFlow(step, "latest")}
            onCorrectReceipt={() => openReceiptFlow("capture", "correction")}
            onRetryHistory={() => void loadReviewHistory(true)}
            onRefresh={async (nextClosedLoop) => {
              if (nextClosedLoop) {
                setSelectedTripReview(nextClosedLoop);
                setHousehold((current) =>
                  current && nextClosedLoop.receipt?.tripId === current.currentTrip.id
                    ? { ...current, closedLoop: nextClosedLoop }
                    : current,
                );
              }
              await refreshHousehold(true, true);
              await loadReviewHistory(true);
            }}
          />
        ) : null}

      </main>

      <button
        type="button"
        ref={mobileNavTriggerRef}
        className={`mobile-nav-trigger ${mobileNavOpen ? "open" : ""}`}
        onClick={() => setMobileNavOpen((open) => !open)}
        aria-expanded={mobileNavOpen}
        aria-controls="mobile-navigation"
        aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
      >
        <span className="mobile-nav-trigger-glyph" aria-hidden="true">
          {mobileNavOpen ? "×" : "B"}
        </span>
        <span>{mobileNavOpen ? "Close" : primaryTabs.find((tab) => tab.id === activeTab)?.label}</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-scrim ${mobileNavOpen ? "open" : ""}`}
        onClick={() => setMobileNavOpen(false)}
        aria-label="Close navigation"
        tabIndex={mobileNavOpen ? 0 : -1}
      />

      <aside
        id="mobile-navigation"
        className={`mobile-nav ${mobileNavOpen ? "open" : ""}`}
        aria-label="Primary navigation"
        aria-hidden={!mobileNavOpen}
      >
        <div className="mobile-nav-header">
          <span className="brand-mark" aria-hidden="true">B</span>
          <strong>BasketSense</strong>
        </div>
        <nav className="mobile-nav-links">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              ref={tab.id === visibleTabs[0]?.id ? mobileNavFirstLinkRef : undefined}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => changeTab(tab.id)}
              onFocus={() => prepareDeferredTab(tab.id)}
              onPointerDown={() => prepareDeferredTab(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
              tabIndex={mobileNavOpen ? 0 : -1}
            >
              <span className="nav-glyph" aria-hidden="true">{tab.symbol}</span>
              <span>{tab.label}</span>
              {tab.id === "review" && openReviewCount > 0 ? (
                <span className="mobile-count">{openReviewCount}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="mobile-nav-footer">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setMobileNavOpen(false);
              openDataDialog();
            }}
            tabIndex={mobileNavOpen ? 0 : -1}
          >
            Data &amp; privacy
          </button>
          {household?.currentUser.role === "owner" ? (
            <a
              className="text-button"
              href={sandboxMode ? "/" : "/?sandbox=1"}
              onClick={changeSandboxMode}
              tabIndex={mobileNavOpen ? 0 : -1}
            >
              {sandboxMode ? "Leave test sandbox" : "Receipt test sandbox"}
            </a>
          ) : null}
          <a
            className="text-button sign-out-link"
            href={signOutHref}
            tabIndex={mobileNavOpen ? 0 : -1}
          >
            Sign out
          </a>
        </div>
      </aside>

      {isDataDialogOpen ? (
        <DataDialog
          viewData={household?.dashboard ?? null}
          error={insightsError ?? syncError}
          onRetry={() => void refreshInsights()}
          returnFocusRef={dialogReturnFocus}
          onClose={closeDataDialog}
        />
      ) : null}

      <ReceiptFlowDialog
        key={
          isReceiptFlowOpen
            ? `${receiptFlowScope}:${receiptFlowInitialStep}:${selectedReviewReceiptId ?? "current"}`
            : "closed"
        }
        open={isReceiptFlowOpen}
        initialStep={receiptFlowInitialStep}
        tripId={
          receiptFlowScope === "correction"
            ? selectedReviewEntry?.tripId ?? null
            : household?.currentTrip.id ?? null
        }
        tripScheduledFor={
          receiptFlowScope === "correction"
            ? selectedReviewEntry?.scheduledFor ?? null
            : household?.currentTrip.scheduledFor ?? null
        }
        tripStatus={
          receiptFlowScope === "correction"
            ? "completed"
            : household?.currentTrip.status ?? null
        }
        closedLoop={
          receiptFlowScope === "correction"
            ? displayedTripReview
            : receiptFlowScope === "latest"
              ? closedLoop
              : currentTripClosedLoop
        }
        correction={receiptFlowScope === "correction"}
        standalone={receiptFlowScope === "ad_hoc"}
        standaloneReceiptId={receiptFlowScope === "ad_hoc" ? adHocReceiptId : null}
        onStandaloneReceiptIdChange={rememberAdHocReceipt}
        onClose={closeReceiptFlow}
        onRefresh={async () => {
          await refreshHousehold(true, true);
          if (receiptFlowScope === "correction") {
            await loadReviewHistory(true);
          }
        }}
        onOpenReview={openTripReview}
        sandboxMode={sandboxMode}
        onReopenSandboxTrip={reopenSandboxTrip}
      />

      <div className="live-region" aria-live="polite" aria-atomic="true">
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    </div>
  );
}

function DeferredView({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: string | null;
  onRetry: () => void;
}) {
  if (!error) {
    return (
      <section
        className="deferred-view"
        role="status"
        aria-busy="true"
        aria-label={`Loading ${label}`}
      >
        <div className="deferred-view-intro">
          <span className="deferred-loading-mark" aria-hidden="true" />
          <div>
            <strong>Preparing {label}</strong>
            <p>
              {label === "Products"
                ? "Organizing your household catalog."
                : "Turning your receipt history into a clear view."}
            </p>
          </div>
        </div>
        <div className="deferred-skeleton-metrics" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <span className="deferred-skeleton-block" key={index} />
          ))}
        </div>
        <div className="deferred-skeleton-grid" aria-hidden="true">
          <span className="deferred-skeleton-block deferred-skeleton-primary" />
          <span className="deferred-skeleton-block deferred-skeleton-secondary" />
        </div>
      </section>
    );
  }

  return (
    <section className="card empty-state" role="alert">
      <strong>{label} could not be loaded</strong>
      <p>{error}</p>
      <button className="secondary-button" type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

function ThisWeekTab({
  household,
  syncStatus,
  syncError,
  suggestionPlanDate,
  newItem,
  setNewItem,
  pendingWrites,
  failedWrites,
  onRetry,
  onRetryLoad,
  onAdd,
  onSetEstimate,
  onToggleIncluded,
  onToggleChecked,
  recentlyCheckedItemId,
  onFreeze,
  onUnfreeze,
  onCopy,
  onOpenReceipt,
}: {
  household: HouseholdSnapshot | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  suggestionPlanDate: string;
  newItem: string;
  setNewItem: (value: string) => void;
  pendingWrites: Set<string>;
  failedWrites: Record<string, FailedWrite>;
  onRetry: (key: string) => void;
  onRetryLoad: () => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onSetEstimate: (
    item: SharedListItem,
    estimatedPriceCents: number,
  ) => Promise<boolean>;
  onToggleIncluded: (item: SharedListItem, trigger?: HTMLElement | null) => void;
  onToggleChecked: (item: SharedListItem) => Promise<boolean>;
  recentlyCheckedItemId: string | null;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onCopy: () => void;
  onOpenReceipt: (step?: ReceiptStep) => void;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [activeCatalogIndex, setActiveCatalogIndex] = useState(0);
  const [unfreezeConfirmationKey, setUnfreezeConfirmationKey] = useState<
    string | null
  >(null);
  const [estimateEditorItemId, setEstimateEditorItemId] = useState<
    string | null
  >(null);
  const [estimateDraft, setEstimateDraft] = useState("");
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [showListComplete, setShowListComplete] = useState(false);
  const [imagePreview, setImagePreview] = useState<ProductImagePreview | null>(null);
  const estimateReturnFocus = useRef<HTMLButtonElement | null>(null);
  const estimateReturnItemId = useRef<string | null>(null);
  const imagePreviewReturnFocus = useRef<HTMLElement | null>(null);
  const quickItemRef = useRef<HTMLInputElement>(null);
  const unfreezeTriggerRef = useRef<HTMLButtonElement>(null);
  const startShoppingRef = useRef<HTMLButtonElement>(null);
  const previousTripState = useRef<{
    id: string;
    status: TripStatus;
  } | null>(null);
  const previousRemainingItemCount = useRef<number | null>(null);
  const trip = household?.currentTrip;
  const tripId = trip?.id ?? null;
  const tripStatus = trip?.status ?? null;
  const items = household?.listItems ?? [];
  const included = items.filter((item) => item.included);
  const pricedIncluded = included.filter(
    (item) => item.estimatedPriceCents !== null,
  );
  const unpricedIncluded = included.length - pricedIncluded.length;
  const estimatedCents = pricedIncluded.reduce(
    (sum, item) => sum + (estimatedItemTotalCents(item) ?? 0),
    0,
  );
  const excluded = items.filter((item) => !item.included);
  const shoppingStarted = trip?.status === "frozen";
  const activeIncluded = shoppingStarted
    ? included.filter((item) => !item.checked)
    : included;
  const checkedIncluded = shoppingStarted
    ? included.filter((item) => item.checked)
    : [];
  const frozenContextKey = shoppingStarted
    ? `${trip.id}:${trip.frozenAt ?? "pending"}`
    : null;
  const confirmUnfreeze =
    frozenContextKey !== null && unfreezeConfirmationKey === frozenContextKey;
  const estimateDisplay = !household
    ? "Loading…"
    : pricedIncluded.length
      ? `~${currency.format(estimatedCents / 100)}`
      : "No estimate yet";
  const estimateCoverage = !household
    ? "Loading the shared list"
    : included.length === 0
      ? "No items on the live list"
      : `${pricedIncluded.length} of ${included.length} ${included.length === 1 ? "item" : "items"} priced${unpricedIncluded ? ` · ${unpricedIncluded} not yet estimated` : ""}`;
  const catalogOptions = useMemo(
    () =>
      [...(household?.products ?? [])]
        .filter(
          (product) =>
            product.category !== "fuel" &&
            product.category !== "optical_services",
        )
        .sort((left, right) => {
          const dateOrder = (right.latestPurchasedAt ?? "").localeCompare(
            left.latestPurchasedAt ?? "",
          );
          return dateOrder || left.canonicalName.localeCompare(right.canonicalName);
        }),
    [household?.products],
  );
  const catalogResults = useMemo(() => {
    const normalizedQuery = normalizedCatalogLabel(newItem);
    const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const matches = catalogOptions.filter((product) => {
      if (!queryTokens.length) return true;
      const searchableValues = [
        product.canonicalName,
        product.latestRawDescription ?? "",
        product.costcoItemNumber ?? "",
        catalogSelectionValue(product, catalogOptions),
      ].map(normalizedCatalogLabel);
      return queryTokens.every((token) =>
        searchableValues.some((value) => value.includes(token)),
      );
    });

    return matches
      .sort((left, right) => {
        if (!normalizedQuery) return 0;
        const score = (product: SharedProduct) => {
          const canonicalName = normalizedCatalogLabel(product.canonicalName);
          const selection = normalizedCatalogLabel(
            catalogSelectionValue(product, catalogOptions),
          );
          const rawDescription = normalizedCatalogLabel(
            product.latestRawDescription ?? "",
          );
          if (canonicalName === normalizedQuery || selection === normalizedQuery) {
            return 0;
          }
          if (canonicalName.startsWith(normalizedQuery)) return 1;
          if (rawDescription.startsWith(normalizedQuery)) return 2;
          return 3;
        };
        return score(left) - score(right);
      })
      .slice(0, 7);
  }, [catalogOptions, newItem]);
  const matchedCatalogProduct = exactCatalogMatch(catalogOptions, newItem);
  const removedAfterStart = shoppingStarted
    ? excluded.filter(
        (item) => item.includedAtFreeze === true || item.addedAfterFreeze,
      )
    : [];
  const removedAfterStartIds = new Set(removedAfterStart.map((item) => item.id));
  const ideaItems = excluded.filter((item) => !removedAfterStartIds.has(item.id));
  const productMemoryById = new Map(
    (household?.products ?? []).map((product) => [product.id, product.memory]),
  );
  const suppressedIdeaItems = ideaItems.filter((item) =>
    productMemorySuppressesSuggestion(
      item.productId ? productMemoryById.get(item.productId)?.preference : null,
    ),
  );
  const suppressedIdeaItemIds = new Set(
    suppressedIdeaItems.map((item) => item.id),
  );
  const visibleIdeaItems = ideaItems.filter(
    (item) => !suppressedIdeaItemIds.has(item.id),
  );
  const prepPendingItemIds = new Set(
    visibleIdeaItems
      .filter((item) => pendingWrites.has(`item-${item.id}`))
      .map((item) => item.id),
  );
  const syncTitle =
    syncStatus === "connecting"
      ? "Connecting the household list"
      : "Shared list is temporarily unavailable";
  const syncCopy =
    syncStatus === "offline"
      ? `${syncError ?? "Try again shortly."} Nothing is stored only on this device.`
      : "Loading your shared list.";
  const activeCatalogProduct = catalogResults[activeCatalogIndex] ?? null;
  const showCatalogResults = Boolean(
    catalogOpen && household && catalogResults.length,
  );

  function handleChecked(item: SharedListItem) {
    const completesList =
      shoppingStarted && !item.checked && activeIncluded.length === 1;
    void onToggleChecked(item).then((saved) => {
      if (saved && completesList) setShowListComplete(true);
    });
  }

  function openImagePreview(
    event: ReactMouseEvent<HTMLElement>,
    preview: ProductImagePreview,
  ) {
    imagePreviewReturnFocus.current = event.currentTarget;
    setImagePreview(preview);
  }

  useEffect(() => {
    const previous = previousTripState.current;
    if (
      previous?.id === tripId &&
      previous.status === "frozen" &&
      tripStatus === "planning"
    ) {
      window.requestAnimationFrame(() => startShoppingRef.current?.focus());
    }
    previousTripState.current = tripId && tripStatus
      ? { id: tripId, status: tripStatus }
      : null;
  }, [tripId, tripStatus]);

  useEffect(() => {
    if (!shoppingStarted) {
      previousRemainingItemCount.current = null;
      const frame = window.requestAnimationFrame(() => setShowListComplete(false));
      return () => window.cancelAnimationFrame(frame);
    }
    const previous = previousRemainingItemCount.current;
    if (previous !== null && previous > 0 && activeIncluded.length === 0 && checkedIncluded.length) {
      const frame = window.requestAnimationFrame(() => setShowListComplete(true));
      previousRemainingItemCount.current = activeIncluded.length;
      return () => window.cancelAnimationFrame(frame);
    }
    previousRemainingItemCount.current = activeIncluded.length;
  }, [activeIncluded.length, checkedIncluded.length, shoppingStarted]);

  useEffect(() => {
    if (!showCatalogResults || !activeCatalogProduct) return;
    document
      .getElementById(`catalog-option-${activeCatalogProduct.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeCatalogProduct, showCatalogResults]);

  function selectCatalogProduct(product: SharedProduct) {
    setNewItem(catalogSelectionValue(product, catalogOptions));
    setCatalogOpen(false);
    setActiveCatalogIndex(0);
    window.requestAnimationFrame(() => quickItemRef.current?.focus());
  }

  function handleCatalogKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && catalogResults.length) {
      event.preventDefault();
      setCatalogOpen(true);
      setActiveCatalogIndex((current) =>
        catalogOpen ? (current + 1) % catalogResults.length : 0,
      );
      return;
    }
    if (event.key === "ArrowUp" && catalogResults.length) {
      event.preventDefault();
      setCatalogOpen(true);
      setActiveCatalogIndex((current) =>
        catalogOpen
          ? (current - 1 + catalogResults.length) % catalogResults.length
          : catalogResults.length - 1,
      );
      return;
    }
    if (event.key === "Enter" && catalogOpen && activeCatalogProduct) {
      event.preventDefault();
      selectCatalogProduct(activeCatalogProduct);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCatalogOpen(false);
      return;
    }
    if (event.key === "Tab") setCatalogOpen(false);
  }

  function openEstimateEditor(
    item: SharedListItem,
    trigger: HTMLButtonElement,
  ) {
    estimateReturnItemId.current = item.id;
    estimateReturnFocus.current = trigger;
    setEstimateEditorItemId(item.id);
    setEstimateDraft(manualEstimateDraft(item.estimatedPriceCents));
    setEstimateError(null);
  }

  function closeEstimateEditor(restoreFocus = true) {
    setEstimateEditorItemId(null);
    setEstimateDraft("");
    setEstimateError(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => estimateReturnFocus.current?.focus());
    }
  }

  async function saveEstimate(
    event: FormEvent<HTMLFormElement>,
    item: SharedListItem,
  ) {
    event.preventDefault();
    const parsed = parseManualEstimateDollars(estimateDraft);
    if (parsed.error || parsed.cents === null) {
      setEstimateError(parsed.error ?? "Enter a valid estimated package price.");
      return;
    }
    const saved = await onSetEstimate(item, parsed.cents);
    if (saved) closeEstimateEditor();
  }

  return (
    <div className="page week-page">
      <section className="page-heading with-controls">
        <div>
          <h1>This Saturday</h1>
          <p>{formatFullDate(trip?.scheduledFor ?? suggestionPlanDate)}</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button copy-list-button" onClick={onCopy}>
            Copy list
          </button>
          {!shoppingStarted ? (
            <button
              ref={startShoppingRef}
              className="primary-button start-shopping-button"
              onClick={onFreeze}
              disabled={!household || !included.length || pendingWrites.has("freeze-trip")}
            >
              {pendingWrites.has("freeze-trip") ? "Starting…" : "Start shopping"}
            </button>
          ) : (
            <>
              <span className="frozen-pill">Shopping started</span>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  onOpenReceipt(
                    household && trip && household.closedLoop?.receipt?.tripId === trip.id
                      ? household.closedLoop.comparison?.isProvisional
                        ? "check"
                        : "bridge"
                      : "capture",
                  )
                }
              >
                {household && trip && household.closedLoop?.receipt?.tripId === trip.id
                  ? "Receipt"
                  : "Add receipt"}
              </button>
              <button
                ref={unfreezeTriggerRef}
                type="button"
                className="secondary-button unfreeze-trigger"
                onClick={() =>
                  setUnfreezeConfirmationKey((current) =>
                    current === frozenContextKey ? null : frozenContextKey,
                  )
                }
                aria-expanded={confirmUnfreeze}
                aria-controls="unfreeze-confirmation"
                disabled={pendingWrites.has("unfreeze-trip")}
              >
                Back to planning
              </button>
            </>
          )}
        </div>
      </section>

      <ol className="trip-phases" aria-label="Trip progress">
        <li className="complete"><span>1</span>Plan</li>
        <li className={shoppingStarted ? "active" : ""}><span>2</span>Shop</li>
        <li><span>3</span>Review</li>
      </ol>

      {shoppingStarted && confirmUnfreeze ? (
        <section
          className="unfreeze-confirmation"
          id="unfreeze-confirmation"
          aria-labelledby="unfreeze-confirmation-title"
        >
          <span className="unfreeze-mark" aria-hidden="true">↶</span>
          <div>
            <strong id="unfreeze-confirmation-title">Return to planning?</strong>
            <p>
              Your live list changes stay. BasketSense removes this starting
              snapshot, then creates a fresh one the next time you choose Start
              shopping.
            </p>
          </div>
          <div className="unfreeze-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setUnfreezeConfirmationKey(null);
                onUnfreeze();
              }}
              disabled={pendingWrites.has("unfreeze-trip")}
            >
              {pendingWrites.has("unfreeze-trip")
                ? "Returning…"
                : "Yes, back to planning"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setUnfreezeConfirmationKey(null);
                window.requestAnimationFrame(() =>
                  unfreezeTriggerRef.current?.focus(),
                );
              }}
              disabled={pendingWrites.has("unfreeze-trip")}
            >
              Keep shopping
            </button>
          </div>
        </section>
      ) : null}

      {syncStatus === "connecting" || syncStatus === "offline" ? (
        <section
          className={`device-notice ${syncStatus === "offline" ? "warning" : ""}`}
          aria-live="polite"
        >
          <span className="device-notice-mark" aria-hidden="true">
            {syncStatus === "offline" ? "!" : "…"}
          </span>
          <div>
            <strong>{syncTitle}</strong>
            <p>{syncCopy}</p>
          </div>
          {syncStatus === "offline" ? (
            <button type="button" className="secondary-button" onClick={onRetryLoad}>
              Retry list
            </button>
          ) : null}
        </section>
      ) : null}

      <InlineWriteError
        failure={failedWrites["freeze-trip"]}
        onRetry={() => onRetry("freeze-trip")}
      />
      <InlineWriteError
        failure={failedWrites["unfreeze-trip"]}
        onRetry={() => onRetry("unfreeze-trip")}
      />

      {!shoppingStarted && household && visibleIdeaItems.length ? (
        <SaturdayPrepExperience
          key={household.currentTrip.id}
          tripId={household.currentTrip.id}
          scheduledFor={household.currentTrip.scheduledFor}
          items={visibleIdeaItems}
          suppressedCount={suppressedIdeaItems.length}
          pendingItemIds={prepPendingItemIds}
          onAdd={(prepItem: SaturdayPrepItem, trigger) => {
            const item = items.find((candidate) => candidate.id === prepItem.id);
            if (item && !item.included) onToggleIncluded(item, trigger);
          }}
        />
      ) : null}

      <form
        className="quick-add"
        onSubmit={(event) => {
          setCatalogOpen(false);
          onAdd(event);
        }}
      >
        <div className="catalog-combobox">
          <label className="sr-only" htmlFor="quick-item">
            Search all past warehouse products or add a new item
          </label>
          <input
            ref={quickItemRef}
            id="quick-item"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="household-product-catalog"
            aria-expanded={showCatalogResults}
            aria-activedescendant={
              showCatalogResults && activeCatalogProduct
                ? `catalog-option-${activeCatalogProduct.id}`
                : undefined
            }
            aria-describedby={newItem.trim() ? "quick-add-catalog-hint" : undefined}
            autoComplete="off"
            value={newItem}
            onFocus={() => {
              setCatalogOpen(true);
              setActiveCatalogIndex(0);
            }}
            onChange={(event) => {
              setNewItem(event.target.value);
              setCatalogOpen(true);
              setActiveCatalogIndex(0);
            }}
            onKeyDown={handleCatalogKeyDown}
            onBlur={() => window.setTimeout(() => setCatalogOpen(false), 120)}
            placeholder={
              shoppingStarted
                ? "Search past products or add something new…"
                : "Search milk, strawberries, red onions…"
            }
            disabled={!household || pendingWrites.has("quick-add")}
          />
          {showCatalogResults ? (
            <div
              className="catalog-listbox"
              id="household-product-catalog"
              role="listbox"
              aria-label="Past warehouse products"
            >
              {catalogResults.map((product, index) => {
                const rawDescription = product.latestRawDescription?.trim();
                const showRawDescription =
                  rawDescription &&
                  normalizedCatalogLabel(rawDescription) !==
                    normalizedCatalogLabel(product.canonicalName);
                return (
                  <button
                    type="button"
                    role="option"
                    id={`catalog-option-${product.id}`}
                    key={product.id}
                    className={index === activeCatalogIndex ? "active" : ""}
                    aria-selected={index === activeCatalogIndex}
                    tabIndex={-1}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveCatalogIndex(index)}
                    onClick={() => selectCatalogProduct(product)}
                  >
                    <span className="catalog-option-copy">
                      <strong>
                        {catalogSelectionValue(product, catalogOptions)}
                      </strong>
                      <small>
                        {showRawDescription
                          ? rawDescription
                          : product.costcoItemNumber
                            ? `Costco item ${product.costcoItemNumber}`
                            : "Matched from a past receipt"}
                      </small>
                    </span>
                    <span className="catalog-option-price">
                      <strong>
                        {product.latestRegularUnitPriceCents === null
                          ? "Price unavailable"
                          : `~${currency.format(product.latestRegularUnitPriceCents / 100)}`}
                      </strong>
                      <small>
                        {product.purchaseCount === 1
                          ? "Based on last purchase · low confidence"
                          : product.latestPurchasedAt
                          ? `Last bought ${formatShortDate(product.latestPurchasedAt)}`
                          : "Past receipt product"}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <button
          className="primary-button"
          type="submit"
          disabled={!household || !newItem.trim() || pendingWrites.has("quick-add")}
        >
          {pendingWrites.has("quick-add")
            ? "Adding…"
            : shoppingStarted
              ? "Add while shopping"
              : "Add item"}
        </button>
      </form>
      {newItem.trim() ? (
        <p
          className="quick-add-hint"
          id="quick-add-catalog-hint"
          aria-live="polite"
        >
          {matchedCatalogProduct &&
          matchedCatalogProduct.latestRegularUnitPriceCents !== null
            ? `Uses the latest package price: ${currency.format(matchedCatalogProduct.latestRegularUnitPriceCents / 100)}.`
            : "Choose a past product for its estimate, or add this as a new item."}
        </p>
      ) : null}
      <InlineWriteError
        failure={failedWrites["quick-add"]}
        onRetry={() => onRetry("quick-add")}
      />

      <section className="week-summary" aria-label="Saturday list summary">
        <div className="estimate-summary" aria-live="polite">
          <span>Estimated list total</span>
          <strong>{estimateDisplay}</strong>
          <small>{estimateCoverage}</small>
        </div>
      </section>

      <ReceiptCelebration
        closedLoop={
          household && trip && household.closedLoop?.receipt?.tripId === trip.id
            ? household.closedLoop
            : null
        }
      />

      <div className="week-layout">
        <div className="weekly-list-stack">
          {showListComplete ? (
            <section className="shopping-complete" role="status" aria-live="polite">
              <ConfettiCanvas />
              <span className="shopping-complete-mark" aria-hidden="true">✓</span>
              <div>
                <strong>List complete — nice work.</strong>
                <p>Everything on the active list is checked off. Enjoy the samples.</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setShowListComplete(false)}
              >
                Dismiss
              </button>
            </section>
          ) : null}
          <section className="list-card card" aria-labelledby="active-list-title">
            <div className="list-section-heading active-list-heading">
              <div>
                <h2 id="active-list-title" tabIndex={-1}>Active List</h2>
              </div>
              <span>
                {household
                  ? `${activeIncluded.length} ${activeIncluded.length === 1 ? "item" : "items"}`
                  : "—"}
              </span>
            </div>
            {!household ? (
              <ListSkeleton />
            ) : activeIncluded.length ? (
              <div className="list-rows" role="list">
                {activeIncluded.map((item) => {
                  const key = `item-${item.id}`;
                  const estimateKey = `estimate-${item.id}`;
                  const pending = pendingWrites.has(key);
                  const estimatePending = pendingWrites.has(estimateKey);
                  const itemEstimateCents = estimatedItemTotalCents(item);
                  const quantityLabel = (item.quantityMilli / 1000).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 3 },
                  );
                  const isHouseholdEstimate = item.productId === null;
                  const estimateIsEditable =
                    (isHouseholdEstimate || item.estimatedPriceCents === null) &&
                    item.quantityMilli === 1000 &&
                    (!shoppingStarted || item.includedAtFreeze !== true);
                  const estimateEditorOpen =
                    estimateEditorItemId === item.id && estimateIsEditable;
                  return (
                    <div
                      className="list-row-wrap"
                      key={item.id}
                      role="listitem"
                      tabIndex={-1}
                      data-list-item-focus={item.id}
                      data-list-item-location="active"
                    >
                      <div
                        className={`list-row included ${item.checked ? "checked" : ""} ${shoppingStarted ? "" : "planning-row"}`}
                      >
                        {shoppingStarted ? (
                          <button
                            type="button"
                            className="check-button"
                            onClick={() => handleChecked(item)}
                            aria-label={`${item.checked ? "Uncheck" : "Check"} ${item.label}`}
                            disabled={pending}
                          >
                            <span aria-hidden="true">{item.checked ? "✓" : ""}</span>
                          </button>
                        ) : null}
                        <div className="list-row-copy">
                          <ListItemThumbnail
                            item={item}
                            products={household.products}
                            onOpenImage={openImagePreview}
                          />
                          <div className="list-row-copy-body">
                            <strong>{item.label}</strong>
                          </div>
                        </div>
                        <div className="list-row-actions">
                          {estimateEditorOpen ? (
                            <form
                              className="manual-estimate-form"
                              onSubmit={(event) => void saveEstimate(event, item)}
                            >
                              <label
                                className="sr-only"
                                htmlFor={`manual-estimate-${item.id}`}
                              >
                                Estimated package price for {item.label}
                              </label>
                              <span className="manual-estimate-prefix" aria-hidden="true">
                                $
                              </span>
                              <input
                                id={`manual-estimate-${item.id}`}
                                value={estimateDraft}
                                onChange={(event) => {
                                  setEstimateDraft(event.target.value);
                                  setEstimateError(null);
                                }}
                                inputMode="decimal"
                                autoComplete="off"
                                placeholder="24"
                                maxLength={12}
                                autoFocus
                                aria-invalid={Boolean(estimateError)}
                                aria-describedby={
                                  estimateError
                                    ? `manual-estimate-error-${item.id}`
                                    : undefined
                                }
                              />
                              <button
                                type="submit"
                                className="estimate-save-button"
                                disabled={estimatePending}
                              >
                                {estimatePending ? "Saving…" : "Save"}
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => closeEstimateEditor()}
                                disabled={estimatePending}
                              >
                                Not now
                              </button>
                              {estimateError ? (
                                <small
                                  className="manual-estimate-error"
                                  id={`manual-estimate-error-${item.id}`}
                                  role="alert"
                                >
                                  {estimateError}
                                </small>
                              ) : null}
                            </form>
                          ) : estimateIsEditable ? (
                            <button
                              ref={(node) => {
                                if (
                                  node &&
                                  estimateReturnItemId.current === item.id
                                ) {
                                  estimateReturnFocus.current = node;
                                }
                              }}
                              type="button"
                              className="estimated-price estimate-edit-button"
                              onClick={(event) =>
                                openEstimateEditor(item, event.currentTarget)
                              }
                              aria-label={
                                item.estimatedPriceCents === null
                                  ? `Add an estimated package price for ${item.label}`
                                  : `Edit this trip's estimated package price for ${item.label}`
                              }
                            >
                              {item.estimatedPriceCents === null
                                ? "Add estimate"
                                : `~${currency.format(item.estimatedPriceCents / 100)}`}
                            </button>
                          ) : (
                            <span className="estimated-price">
                              {item.estimatedPriceCents === null
                                ? "No estimate"
                                : isHouseholdEstimate
                                  ? `~${currency.format(item.estimatedPriceCents / 100)}`
                                  : item.quantityMilli === 1000
                                    ? `~${currency.format(item.estimatedPriceCents / 100)}`
                                    : `~${currency.format((itemEstimateCents ?? 0) / 100)} · ${quantityLabel} × ${currency.format(item.estimatedPriceCents / 100)}`}
                            </span>
                          )}
                          <button
                            type="button"
                            className="text-button"
                            data-list-focus-action="remove"
                            onClick={(event) =>
                              onToggleIncluded(item, event.currentTarget)
                            }
                            disabled={pending || estimatePending}
                            aria-label={`Remove ${item.label} from the Active List`}
                          >
                            {pending ? "Saving…" : "Remove"}
                          </button>
                        </div>
                      </div>
                      <InlineWriteError
                        failure={failedWrites[key]}
                        onRetry={() => onRetry(key)}
                      />
                      <InlineWriteError
                        failure={failedWrites[estimateKey]}
                        onRetry={() => onRetry(estimateKey)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state active-list-empty">
                <strong>{shoppingStarted ? "Everything on the active list is checked off" : "Your active list is empty"}</strong>
                <p>
                  {shoppingStarted
                    ? "Use the checked-off section below to undo anything marked by mistake."
                    : "Search the household catalog above or add an idea below. The estimate only counts items moved here."}
                </p>
              </div>
            )}
            {checkedIncluded.length ? (
              <section className="checked-list" aria-labelledby="checked-list-title">
                <div className="checked-list-heading">
                  <div>
                    <h3 id="checked-list-title">Checked off</h3>
                  </div>
                  <span>{checkedIncluded.length}</span>
                </div>
                <div className="list-rows" role="list">
                  {checkedIncluded.map((item) => {
                    const key = `item-${item.id}`;
                    const pending = pendingWrites.has(key);
                    return (
                      <div
                        className={`list-row-wrap ${
                          recentlyCheckedItemId === item.id
                            ? "checked-off-arrival"
                            : ""
                        }`}
                        key={item.id}
                        role="listitem"
                        data-list-item-focus={item.id}
                        data-list-item-location="checked"
                      >
                        <div className="list-row included checked">
                          <button
                            type="button"
                            className="check-button"
                            onClick={() => handleChecked(item)}
                            aria-label={`Undo check for ${item.label}`}
                            disabled={pending}
                          >
                            <span aria-hidden="true">✓</span>
                          </button>
                          <div className="list-row-copy">
                            <ListItemThumbnail
                              item={item}
                              products={household?.products ?? []}
                              onOpenImage={openImagePreview}
                            />
                            <div className="list-row-copy-body">
                              <strong>{item.label}</strong>
                            </div>
                          </div>
                          <div className="list-row-actions">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => handleChecked(item)}
                              disabled={pending}
                            >
                              {pending ? "Saving…" : "Undo"}
                            </button>
                          </div>
                        </div>
                        <InlineWriteError
                          failure={failedWrites[key]}
                          onRetry={() => onRetry(key)}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {removedAfterStart.length ? (
              <details className="removed-list">
                <summary>
                  {removedAfterStart.length} {removedAfterStart.length === 1 ? "item" : "items"} removed since shopping started · Undo
                </summary>
                <div className="removed-list-rows">
                  {removedAfterStart.map((item) => {
                    const key = `item-${item.id}`;
                    return (
                      <div className="removed-list-row" key={item.id}>
                        <span>
                          <strong>{item.label}</strong>
                          <small>
                            {item.includedAtFreeze
                              ? "Was on the list when shopping started"
                              : "Added during the trip, then removed"}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="add-button"
                          onClick={() => onToggleIncluded(item)}
                          disabled={pendingWrites.has(key)}
                          aria-label={`Add ${item.label} back to the Active List`}
                        >
                          {pendingWrites.has(key) ? "Saving…" : "Add back"}
                        </button>
                        <InlineWriteError
                          failure={failedWrites[key]}
                          onRetry={() => onRetry(key)}
                        />
                      </div>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </section>

          <SuggestionShelf
            household={household}
            items={visibleIdeaItems}
            pendingWrites={pendingWrites}
            failedWrites={failedWrites}
            onRetry={onRetry}
            onAdd={onToggleIncluded}
            onOpenImage={openImagePreview}
          />
        </div>

      </div>
      {imagePreview ? (
        <ProductImagePreviewDialog
          preview={imagePreview}
          returnFocusRef={imagePreviewReturnFocus}
          onClose={() => setImagePreview(null)}
        />
      ) : null}
    </div>
  );
}

function ListItemThumbnail({
  item,
  products,
  onOpenImage,
}: {
  item: SharedListItem;
  products: readonly SharedProduct[];
  onOpenImage: (
    event: ReactMouseEvent<HTMLElement>,
    preview: ProductImagePreview,
  ) => void;
}) {
  const product = item.productId
    ? products.find((candidate) => candidate.id === item.productId)
    : undefined;
  const illustration = generatedProductIllustration(product?.costcoItemNumber);
  const imageUrl = product?.image?.imageUrl ?? illustration?.imageUrl;
  const imageAlt = product?.image
    ? `${item.label} package photo`
    : illustration?.alt ?? `Illustration of ${item.label}`;

  return (
    imageUrl ? (
      <button
        type="button"
        className="list-item-thumbnail list-item-thumbnail-button has-photo"
        onClick={(event) =>
          onOpenImage(event, {
            imageUrl,
            alt: imageAlt,
            label: item.label,
          })
        }
        aria-label={`Open full image for ${item.label}`}
      >
        <img src={imageUrl} alt="" loading="lazy" />
      </button>
    ) : (
      <span className="list-item-thumbnail" aria-hidden="true">
        <span>{item.label.trim().charAt(0).toLocaleUpperCase()}</span>
      </span>
    )
  );
}

function ListSkeleton() {
  return (
    <div className="list-skeleton" aria-label="Loading the shared list">
      <span />
      <span />
      <span />
    </div>
  );
}

function SuggestionShelf({
  household,
  items,
  pendingWrites,
  failedWrites,
  onRetry,
  onAdd,
  onOpenImage,
}: {
  household: HouseholdSnapshot | null;
  items: readonly SharedListItem[];
  pendingWrites: Set<string>;
  failedWrites: Record<string, FailedWrite>;
  onRetry: (key: string) => void;
  onAdd: (item: SharedListItem, trigger?: HTMLElement | null) => void;
  onOpenImage: (
    event: ReactMouseEvent<HTMLElement>,
    preview: ProductImagePreview,
  ) => void;
}) {
  const shoppingStarted = household?.currentTrip.status === "frozen";
  const ideaGroups = IDEA_SECTIONS.map((section) => ({
    ...section,
    items: items.filter((item) => item.section === section.key),
  })).filter((section) => section.items.length);

  return (
    <section className="suggestion-shelf" aria-labelledby="ideas-title">
      <div className="card-heading ideas-heading">
        <h2 id="ideas-title" tabIndex={-1}>Ideas</h2>
        <span className="ideas-count" aria-label={`${items.length} ideas`}>
          {items.length}
        </span>
      </div>
      {!household ? (
        <p className="ideas-loading" role="status">Loading household ideas…</p>
      ) : ideaGroups.length ? (
        <div className="idea-groups">
          {ideaGroups.map((group) => {
            const headingId = `idea-group-${group.key}`;
            return (
              <section
                className="idea-group"
                aria-labelledby={headingId}
                key={group.key}
              >
                <div className="idea-group-heading">
                  <h3 id={headingId}>{group.label}</h3>
                  <span>{group.items.length}</span>
                </div>
                <div className="suggestion-list" role="list">
                  {group.items.map((item) => {
                    const key = `item-${item.id}`;
                    const pending = pendingWrites.has(key);
                    const confidence = cadenceConfidence(item.confidenceBps);
                    return (
                      <div
                        className="suggestion-row"
                        key={item.id}
                        role="listitem"
                        tabIndex={-1}
                        data-list-item-focus={item.id}
                        data-list-item-location="ideas"
                      >
                        <div className="suggestion-copy">
                          <ListItemThumbnail
                            item={item}
                            products={household.products}
                            onOpenImage={onOpenImage}
                          />
                          <div className="suggestion-copy-body">
                            <strong>{item.label}</strong>
                            <details className="suggestion-evidence">
                              <summary>Why this was suggested</summary>
                              <p>
                                {item.recommendationReason ?? sourceLabel(item.source)}
                              </p>
                              <small>
                                {[
                                  confidence,
                                  item.estimatedPriceCents === null
                                    ? "Price estimate unavailable"
                                    : `Latest regular price ~${currency.format(item.estimatedPriceCents / 100)}`,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                            </details>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="add-button"
                          data-list-focus-action="add"
                          onClick={(event) => onAdd(item, event.currentTarget)}
                          disabled={pending}
                          aria-label={`Add ${item.label} to the Active List`}
                        >
                          <span className="suggestion-add-label-full">
                            {pending
                              ? "Adding…"
                              : shoppingStarted
                                ? "Add during trip"
                                : "Add to list"}
                          </span>
                          <span className="suggestion-add-label-compact" aria-hidden="true">
                            {pending ? "Adding…" : "Add"}
                          </span>
                        </button>
                        <InlineWriteError
                          failure={failedWrites[key]}
                          onRetry={() => onRetry(key)}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="empty-state ideas-empty">
          <strong>All current ideas are active</strong>
        </div>
      )}
    </section>
  );
}

function channelLabel(channel: DashboardTransaction["channel"]) {
  if (channel === "gas") return "Fuel";
  if (channel === "optical") return "Optical";
  return "Warehouse";
}

function isReturnTransaction(transaction: DashboardTransaction) {
  return transaction.transactionKind === "return";
}

function transactionContextLabel(transaction: DashboardTransaction) {
  if (isReturnTransaction(transaction)) return "Return";
  return transaction.purchaseContext === "ad_hoc" ? "Ad hoc" : null;
}

function classificationLabel(status: DashboardReceiptLine["classificationStatus"]) {
  if (status === "reviewed") return "Reviewed mapping";
  if (status === "rule_based") return "Rule-matched";
  return "Needs review";
}

function classificationTone(status: DashboardReceiptLine["classificationStatus"]) {
  return status === "reviewed"
    ? ("confirmed" as const)
    : status === "rule_based"
      ? ("suggestion" as const)
      : ("unknown" as const);
}

function OverviewTab({
  viewData,
  selectedMonth,
  setSelectedMonth,
  selectedCategoryKey,
  setSelectedCategoryKey,
  selectedTransactionId,
  setSelectedTransactionId,
  onOpenProduct,
  onReviewProduct,
  onAddCostcoPurchase,
}: {
  viewData: DashboardViewData;
  selectedMonth: string;
  setSelectedMonth: (month: string) => void;
  selectedCategoryKey: ProductCategoryKey | null;
  setSelectedCategoryKey: (category: ProductCategoryKey | null) => void;
  selectedTransactionId: string | null;
  setSelectedTransactionId: (transactionId: string | null) => void;
  onOpenProduct: (productId: string) => void;
  onReviewProduct: (productId: string, receiptItemId: string) => void;
  onAddCostcoPurchase: () => void;
}) {
  const transactions = viewData.transactions.filter(
    (transaction) =>
      selectedMonth === "all" || transaction.purchasedOn.startsWith(selectedMonth),
  );
  const categories = scopedCategories(viewData, transactions);
  const selectedTransaction = viewData.transactions.find(
    (transaction) => transaction.id === selectedTransactionId,
  );
  const selectedCategory = categories.find(
    (category) => category.key === selectedCategoryKey,
  );

  if (selectedTransaction) {
    return (
      <ReceiptDetail
        transaction={selectedTransaction}
        lines={viewData.receiptLines.filter(
          (line) => line.transactionId === selectedTransaction.id,
        )}
        products={viewData.products}
        onBack={() => setSelectedTransactionId(null)}
        onOpenProduct={onOpenProduct}
      />
    );
  }

  if (selectedCategory) {
    return (
      <CategoryDetail
        category={selectedCategory}
        transactions={transactions}
        lines={viewData.receiptLines}
        products={viewData.products}
        selectedMonth={selectedMonth}
        auditThrough={viewData.audit.through}
        onBack={() => setSelectedCategoryKey(null)}
        onOpenTransaction={setSelectedTransactionId}
        onOpenProduct={onOpenProduct}
        onReviewProduct={onReviewProduct}
      />
    );
  }

  const scopeHouseholdCents = transactions.reduce(
    (sum, transaction) => sum + transaction.householdFundedCents,
    0,
  );
  const scopeWarehouseTaxCents = transactions
    .filter((transaction) => transaction.channel === "warehouse")
    .reduce((sum, transaction) => sum + transaction.taxCents, 0);
  const scopeNeedsReviewCents =
    categories.find((category) => category.key === "needs_review")
      ?.householdViewCents ?? 0;
  const receiptRows = selectedMonth === "all" ? transactions.slice(0, 10) : transactions;
  const scopeLabel =
    selectedMonth === "all"
      ? formatAuditRange(viewData.transactions, viewData.audit.through)
      : viewData.months.find((month) => month.key === selectedMonth)?.label ??
        selectedMonth;

  return (
    <div className="page page-overview">
      <section className="page-heading with-controls">
        <h1>Insights</h1>
        <button type="button" className="secondary-button ad-hoc-purchase-action" onClick={onAddCostcoPurchase}>
          Add Costco receipt
        </button>
      </section>

      {viewData.audit.reconciliationIssueCount > 0 ? (
        <section className="notice-card warning">
          <span className="notice-mark" aria-hidden="true">!</span>
          <p>
            <strong>The audit still has open reconciliation work.</strong>
          </p>
        </section>
      ) : null}

      <section className="metrics-strip four" aria-label={`${scopeLabel} Costco summary`}>
        <article>
          <span>Household-funded</span>
          <strong>{currency.format(scopeHouseholdCents / 100)}</strong>
          <small>{scopeLabel}</small>
        </article>
        <article>
          <span>Receipt transactions</span>
          <strong>{transactions.length}</strong>
        </article>
        <article>
          <span>Warehouse tax</span>
          <strong>{currency.format(scopeWarehouseTaxCents / 100)}</strong>
        </article>
        <article>
          <span>Needs review</span>
          <strong>{currency.format(scopeNeedsReviewCents / 100)}</strong>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="card spend-card">
          <div className="card-heading">
            <div>
              <h2>Household-funded spend by month</h2>
            </div>
          </div>
          <MonthlyBarChart
            data={viewData.months}
            selectedMonth={selectedMonth}
            auditThrough={viewData.audit.through}
            onSelectMonth={setSelectedMonth}
          />
        </article>

        <article className="card category-card">
          <div className="card-heading">
            <div>
              <h2>Major categories</h2>
            </div>
            <EvidenceBadge label="After discounts" tone="receipt" />
          </div>
          <CategorySpendDonut
            categories={categories}
            taxCents={scopeWarehouseTaxCents}
            totalCents={scopeHouseholdCents}
            onSelectCategory={setSelectedCategoryKey}
          />
        </article>
      </section>

      <section className="card trip-table-card">
        <div className="card-heading">
          <div>
            <h2>{selectedMonth === "all" ? "Latest receipt transactions" : `${scopeLabel} receipt transactions`}</h2>
          </div>
        </div>
        <TransactionTable
          transactions={receiptRows}
          onOpenTransaction={setSelectedTransactionId}
        />
      </section>

    </div>
  );
}

function MonthlyBarChart({
  data,
  selectedMonth,
  auditThrough,
  onSelectMonth,
}: {
  data: DashboardViewData["months"];
  selectedMonth: string;
  auditThrough: string;
  onSelectMonth: (month: string) => void;
}) {
  const max = Math.max(...data.map((month) => month.householdFundedCents));
  const total = data.reduce((sum, month) => sum + month.householdFundedCents, 0);
  const transactions = data.reduce((sum, month) => sum + month.transactionCount, 0);
  const selected = data.find((month) => month.key === selectedMonth);
  const highestMonth = data.reduce(
    (highest, month) =>
      !highest || month.householdFundedCents > highest.householdFundedCents
        ? month
        : highest,
    undefined as DashboardViewData["months"][number] | undefined,
  );
  return (
    <div className="bar-chart">
      <div className="chart-scope-actions">
        <div className="chart-scope-copy">
          <span>{selected ? selected.label : "2026 household-funded"}</span>
          <strong>
            {selected
              ? currency.format(selected.householdFundedCents / 100)
              : currency.format(total / 100)}
          </strong>
          <small>
            {selected
              ? `${selected.transactionCount} ${selected.transactionCount === 1 ? "receipt" : "receipts"}`
              : `Highest month: ${highestMonth?.label ?? "—"}`}
          </small>
        </div>
        <button
          type="button"
          className={selectedMonth === "all" ? "active" : ""}
          onClick={() => onSelectMonth("all")}
          aria-pressed={selectedMonth === "all"}
        >
          All months
        </button>
      </div>
      <div
        className="bars"
        style={{ gridTemplateColumns: `repeat(${data.length}, minmax(44px, 1fr))` }}
        aria-label="Choose a spending month"
      >
        {data.map((month) => (
          <button
            type="button"
            className={`bar-group ${selectedMonth === month.key ? "active" : ""}`}
            key={month.key}
            onClick={() => onSelectMonth(month.key)}
            aria-pressed={selectedMonth === month.key}
            aria-label={`${month.label}: ${currency.format(month.householdFundedCents / 100)} across ${month.transactionCount} receipt transactions`}
          >
            <span className="bar-value">
              {compactCurrency.format(month.householdFundedCents / 100)}
            </span>
            <div className="bar-pair">
              <span
                className="bar current"
                style={{ height: `${Math.max(12, (month.householdFundedCents / max) * 100)}%` }}
              />
            </div>
            <span className="bar-label">{month.label}</span>
          </button>
        ))}
      </div>
      <p className="chart-summary">
        {currency.format(total / 100)} household-funded across {transactions}{" "}
        receipt transactions. {new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(dateFromIso(auditThrough))} is partial through {formatShortDate(auditThrough)}.
      </p>
    </div>
  );
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function donutArcPath(startAngle: number, endAngle: number) {
  const start = polarPoint(100, 100, 71, endAngle);
  const end = polarPoint(100, 100, 71, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A 71 71 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function CategorySpendDonut({
  categories,
  taxCents,
  totalCents,
  onSelectCategory,
}: {
  categories: readonly DashboardProductCategory[];
  taxCents: number;
  totalCents: number;
  onSelectCategory: (category: ProductCategoryKey) => void;
}) {
  const [hoveredCategory, setHoveredCategory] = useState<ProductCategoryKey | null>(null);
  const visibleCategories = categories.filter(
    (category) => category.householdViewCents > 0,
  );
  const categoryTotalCents = visibleCategories.reduce(
    (sum, category) => sum + category.householdViewCents,
    0,
  );
  const slices = visibleCategories.map((category, index) => {
    const share = categoryTotalCents
      ? (category.householdViewCents / categoryTotalCents) * 100
      : 0;
    const span = (share / 100) * 360;
    const padding = Math.min(2.2, span / 5);
    const earlierCents = visibleCategories
      .slice(0, index)
      .reduce((sum, earlierCategory) => sum + earlierCategory.householdViewCents, 0);
    const startAngle = categoryTotalCents
      ? (earlierCents / categoryTotalCents) * 360
      : 0;
    return {
      category,
      share,
      startAngle: startAngle + padding,
      endAngle: startAngle + span - padding,
    };
  });
  const hoveredSlice = slices.find(({ category }) => category.key === hoveredCategory);
  return (
    <div className="category-donut-explorer">
      <div className="category-donut-wrap">
        <svg
          className="category-donut"
          viewBox="0 0 200 200"
          role="group"
          aria-label={`Category merchandise total: ${currency.format(categoryTotalCents / 100)}`}
        >
          <circle className="category-donut-track" cx="100" cy="100" r="71" />
          {slices.map(({ category, share, startAngle, endAngle }) => (
            <path
              key={category.key}
              className="category-donut-segment"
              d={donutArcPath(startAngle, endAngle)}
              stroke={category.color}
              role="button"
              tabIndex={0}
              aria-label={`Open ${category.label}: ${currency.format(category.householdViewCents / 100)}, ${Math.round(share)}% of category merchandise`}
              onPointerEnter={() => setHoveredCategory(category.key)}
              onPointerLeave={() => setHoveredCategory(null)}
              onFocus={() => setHoveredCategory(category.key)}
              onBlur={() => setHoveredCategory(null)}
              onClick={() => onSelectCategory(category.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectCategory(category.key);
                }
              }}
            />
          ))}
        </svg>
        <div className="category-donut-center" aria-live="polite">
          {hoveredSlice ? (
            <>
              <span>{hoveredSlice.category.shortLabel}</span>
              <strong>{Math.round(hoveredSlice.share)}%</strong>
              <small
                aria-label={currency.format(
                  hoveredSlice.category.householdViewCents / 100,
                )}
                title={currency.format(
                  hoveredSlice.category.householdViewCents / 100,
                )}
              >
                {compactCurrency.format(
                  hoveredSlice.category.householdViewCents / 100,
                )}
              </small>
            </>
          ) : (
            <>
              <span>Categories</span>
              <strong
                aria-label={currency.format(categoryTotalCents / 100)}
                title={currency.format(categoryTotalCents / 100)}
              >
                {compactCurrency.format(categoryTotalCents / 100)}
              </strong>
            </>
          )}
        </div>
      </div>

      <div className="category-donut-legend">
        {visibleCategories.map((category) => {
          const share = categoryTotalCents
            ? Math.round((category.householdViewCents / categoryTotalCents) * 100)
            : 0;
          return (
          <button
            type="button"
            className="category-donut-legend-row"
            key={category.key}
            onClick={() => onSelectCategory(category.key)}
          >
            <span className="category-donut-swatch" style={{ background: category.color }} />
            <span className="category-donut-legend-copy">
              <strong>{category.shortLabel}</strong>
              <small>{category.transactionCount} {category.transactionCount === 1 ? "trip" : "trips"} · {share}%</small>
            </span>
            <span>{currency.format(category.householdViewCents / 100)}</span>
          </button>
          );
        })}
        <p className="channel-footnote">
          {currency.format(taxCents / 100)} warehouse tax stays separate. Categories show
          merchandise after discounts; {currency.format(totalCents / 100)} is the full household-funded total.
        </p>
      </div>
    </div>
  );
}

function TransactionTable({
  transactions,
  onOpenTransaction,
}: {
  transactions: readonly DashboardTransaction[];
  onOpenTransaction: (transactionId: string) => void;
}) {
  return (
    <>
      <div className="table-scroll desktop-receipts">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Channel</th>
              <th>Items</th>
              <th>Discounts</th>
              <th>Household-funded</th>
              <th>Receipt total</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((transaction) => (
              <tr key={transaction.id}>
                <td>{formatShortDate(transaction.purchasedOn)}</td>
                <td>
                  {channelLabel(transaction.channel)}
                  {transactionContextLabel(transaction) ? (
                    <span className="purchase-context-badge">{transactionContextLabel(transaction)}</span>
                  ) : null}
                </td>
                <td>{transaction.itemCount}</td>
                <td>
                  {transaction.discountCents
                    ? `−${currency.format(transaction.discountCents / 100)}`
                    : currency.format(0)}
                </td>
                <td>{currency.format(transaction.householdFundedCents / 100)}</td>
                <td>
                  <button
                    type="button"
                    className="receipt-amount-button"
                    onClick={() => onOpenTransaction(transaction.id)}
                  >
                    {currency.format(transaction.receiptTotalCents / 100)}
                    <span>Open</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-receipts" aria-label="Receipt transactions">
        {transactions.map((transaction) => (
          <button
            type="button"
            className="mobile-receipt-row"
            key={transaction.id}
            onClick={() => onOpenTransaction(transaction.id)}
          >
            <span>
              <strong>{formatShortDate(transaction.purchasedOn)}</strong>
              <small>
                {transaction.purchaseContext === "ad_hoc"
                  ? isReturnTransaction(transaction) ? "Ad hoc Costco return · " : "Ad hoc Costco purchase · "
                  : ""}
                {channelLabel(transaction.channel)} · {transaction.itemCount} items
              </small>
            </span>
            <span>
              <strong>{currency.format(transaction.householdFundedCents / 100)}</strong>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function CategoryDetail({
  category,
  transactions,
  lines,
  products,
  selectedMonth,
  auditThrough,
  onBack,
  onOpenTransaction,
  onOpenProduct,
  onReviewProduct,
}: {
  category: DashboardProductCategory;
  transactions: readonly DashboardTransaction[];
  lines: readonly DashboardReceiptLine[];
  products: readonly DashboardProduct[];
  selectedMonth: string;
  auditThrough: string;
  onBack: () => void;
  onOpenTransaction: (transactionId: string) => void;
  onOpenProduct: (productId: string) => void;
  onReviewProduct: (productId: string, receiptItemId: string) => void;
}) {
  const scopeTransactionIds = new Set(transactions.map((transaction) => transaction.id));
  const categoryLines = lines.filter(
    (line) =>
      scopeTransactionIds.has(line.transactionId) &&
      line.categoryKey === category.key,
  );
  const categoryTransactionIds = new Set(categoryLines.map((line) => line.transactionId));
  const channel =
    category.key === "fuel"
      ? "gas"
      : category.key === "optical_services"
        ? "optical"
        : null;
  const categoryTransactions = transactions.filter((transaction) =>
    channel
      ? transaction.channel === channel
      : categoryTransactionIds.has(transaction.id),
  );
  const productByItem = new Map(products.map((product) => [product.itemNumber, product]));
  const spendByItem = new Map<string, { line: DashboardReceiptLine; spendCents: number; count: number }>();
  for (const line of categoryLines) {
    const existing = spendByItem.get(line.itemNumber);
    spendByItem.set(line.itemNumber, {
      line,
      spendCents: (existing?.spendCents ?? 0) + line.netAmountCents,
      count: (existing?.count ?? 0) + 1,
    });
  }
  const topProducts = [...spendByItem.values()]
    .sort((first, second) => second.spendCents - first.spendCents)
    .slice(0, 12);
  const reviewableProducts = topProducts.filter(
    ({ line }) =>
      category.key === "needs_review" &&
      line.itemNumber !== "0000" &&
      productByItem.has(line.itemNumber),
  );
  const monthLabel =
    selectedMonth === "all"
      ? `Audited 2026 through ${formatShortDate(auditThrough)}`
      : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
          new Date(`${selectedMonth}-01T00:00:00Z`),
        );

  return (
    <div className="page detail-page">
      <button className="back-button" type="button" onClick={onBack}>← All categories</button>
      <section className="page-heading detail-heading">
        <p className="section-label">{monthLabel}</p>
        <h1>{category.label}</h1>
        <p>
          {category.classificationBasis === "warehouse_merchandise_before_tax"
            ? "Net warehouse merchandise after line discounts and before sales tax."
            : "Household-funded channel total; external optical benefits are excluded."}
        </p>
      </section>
      <section className="metrics-strip" aria-label={`${category.label} summary`}>
        <article>
          <span>Household view</span>
          <strong>{currency.format(category.householdViewCents / 100)}</strong>
          <small>{category.key === "optical_services" ? "Out-of-pocket only" : "Audited amount"}</small>
        </article>
        <article>
          <span>Trips</span>
          <strong>{categoryTransactions.length}</strong>
          <small>Receipts containing this category</small>
        </article>
        <article>
          <span>Recorded lines</span>
          <strong>{categoryLines.length}</strong>
          <small>{category.itemCount} units across receipt lines</small>
        </article>
      </section>

      {category.key === "needs_review" ? (
        <section className="notice-card">
          <span className="notice-mark" aria-hidden="true">?</span>
          <p>
            Choose <strong>Review &amp; categorize</strong> for each product below to
            confirm its household name and category. Discounts are already applied at
            checkout and do not need a category.
          </p>
        </section>
      ) : null}

      {topProducts.length ? (
        <section className="card category-product-list">
          <div className="card-heading">
            <div>
              <h2>
                {channel
                  ? "Receipt lines"
                  : category.key === "needs_review"
                    ? "Review & categorize products"
                    : "Products in this category"}
              </h2>
              <p>
                {channel
                  ? "Largest recorded receipt-line values first; Optical lines are gross service values."
                  : category.key === "needs_review"
                    ? `${reviewableProducts.length} ${reviewableProducts.length === 1 ? "product is" : "products are"} ready for a quick household decision.`
                  : "Largest recorded net merchandise amounts first."}
              </p>
            </div>
          </div>
          <div className="category-product-rows">
            {topProducts.map(({ line, spendCents, count }) => {
              const product = productByItem.get(line.itemNumber);
              const isDiscountLine = line.itemNumber === "0000";
              const canReviewProduct =
                category.key === "needs_review" && !isDiscountLine && product !== undefined;
              const content = (
                <>
                  <span>
                    <strong>{line.name}</strong>
                    <small>{line.rawDescription} · item {line.itemNumber} · {count} {count === 1 ? "trip" : "trips"}</small>
                  </span>
                  <span>
                    <strong>{currency.format(spendCents / 100)}</strong>
                    <small>
                      {canReviewProduct
                        ? "Review & categorize →"
                        : line.itemNumber === "0000"
                          ? "Receipt discount · already applied"
                          : classificationLabel(line.classificationStatus)}
                    </small>
                  </span>
                </>
              );
              return product && !isDiscountLine ? (
                <button
                  type="button"
                  key={line.itemNumber}
                  data-open-product-id={product.id}
                  aria-label={
                    canReviewProduct
                      ? `Review and categorize ${line.name}`
                      : `Open ${line.name}`
                  }
                  onClick={() =>
                    canReviewProduct
                      ? onReviewProduct(product.id, line.id)
                      : onOpenProduct(product.id)
                  }
                >
                  {content}
                </button>
              ) : (
                <div key={line.itemNumber}>{content}</div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="card trip-table-card">
        <div className="card-heading">
          <div>
            <h2>Trips with {category.shortLabel.toLocaleLowerCase()}</h2>
          </div>
        </div>
        <TransactionTable
          transactions={categoryTransactions}
          onOpenTransaction={onOpenTransaction}
        />
      </section>
    </div>
  );
}

function ReceiptDetail({
  transaction,
  lines,
  products,
  onBack,
  onOpenProduct,
}: {
  transaction: DashboardTransaction;
  lines: readonly DashboardReceiptLine[];
  products: readonly DashboardProduct[];
  onBack: () => void;
  onOpenProduct: (productId: string) => void;
}) {
  const productsByItem = new Map(products.map((product) => [product.itemNumber, product]));
  const lineSubtotal = lines.reduce((sum, line) => sum + line.netAmountCents, 0);
  const sourceLabel =
    transaction.sourceType === "receipt_photo"
      ? "Phone photo"
      : transaction.sourceType === "fuel_receipt"
        ? "Fuel receipt"
        : "Digital receipt";

  return (
    <div className="page detail-page">
      <button className="back-button" type="button" onClick={onBack}>← Back to insights</button>
      <section className="page-heading detail-heading">
        <p className="section-label">{transaction.purchaseContext === "ad_hoc" ? isReturnTransaction(transaction) ? "Ad hoc Costco return" : "Ad hoc Costco purchase" : `${channelLabel(transaction.channel)} receipt`}</p>
        <h1>{formatFullDate(transaction.purchasedOn)}</h1>
        <p>{sourceLabel} · {transaction.itemCount} recorded items{transaction.purchaseContext === "ad_hoc" ? " · not matched to the Saturday list" : ""}</p>
      </section>

      <section className="receipt-total-card card">
        <div>
          <span>Household-funded</span>
          <strong>{currency.format(transaction.householdFundedCents / 100)}</strong>
        </div>
        <dl>
          <div><dt>Merchandise after discounts</dt><dd>{currency.format(transaction.merchandiseSubtotalCents / 100)}</dd></div>
          <div><dt>Sales tax</dt><dd>{currency.format(transaction.taxCents / 100)}</dd></div>
          <div><dt>Receipt total</dt><dd>{currency.format(transaction.receiptTotalCents / 100)}</dd></div>
          {transaction.externalFundingCents ? (
            <div><dt>Insurance / external benefit</dt><dd>−{currency.format(transaction.externalFundingCents / 100)}</dd></div>
          ) : null}
          {transaction.discountCents ? (
            <div><dt>Line discounts already applied</dt><dd>−{currency.format(transaction.discountCents / 100)}</dd></div>
          ) : null}
        </dl>
      </section>

      <section className="notice-card gentle receipt-reconciliation">
        <span className="notice-mark" aria-hidden="true">✓</span>
        <p>
          <strong>Receipt lines reconcile to {currency.format(lineSubtotal / 100)} before tax.</strong>{" "}
          {transaction.channel === "optical"
            ? "Optical line values are gross service value; the household-funded amount above is the out-of-pocket total."
            : "Discounts remain attached to their original line items."}
        </p>
      </section>

      <section className="card receipt-lines-card">
        <div className="card-heading">
          <div>
            <h2>Receipt lines</h2>
          </div>
        </div>
        <div className="receipt-lines">
          {lines.map((line) => {
            const product = productsByItem.get(line.itemNumber);
            const content = (
              <>
                <span className="receipt-line-main">
                  <strong>{line.name}</strong>
                  <small>{line.rawDescription} · item {line.itemNumber}</small>
                  <span className="receipt-line-badges">
                    <EvidenceBadge label={line.categoryLabel} tone="receipt" />
                    <EvidenceBadge
                      label={classificationLabel(line.classificationStatus)}
                      tone={classificationTone(line.classificationStatus)}
                    />
                  </span>
                </span>
                <span className="receipt-line-money">
                  <strong>{currency.format(line.netAmountCents / 100)}</strong>
                  <small>
                    {line.quantity !== 1 ? `${line.quantity} units` : "1 unit"}
                    {line.discountCents ? ` · −${currency.format(line.discountCents / 100)}` : ""}
                  </small>
                </span>
              </>
            );
            return product ? (
              <button
                type="button"
                key={line.id}
                data-open-product-id={product.id}
                onClick={() => onOpenProduct(product.id)}
              >
                {content}
              </button>
            ) : (
              <div key={line.id}>{content}</div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ProductImageStudio({
  product,
  onImagesUpdated,
}: {
  product: SharedProduct;
  onImagesUpdated: () => Promise<void>;
}) {
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState<"upload" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function uploadPhoto(file: File) {
    setLoading("upload");
    setError(null);
    try {
      const form = new FormData();
      form.set("productId", product.id);
      form.set("file", file);
      const response = await fetch("/api/product-images", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: form,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(apiErrorMessage(body, "The product photo was not uploaded."));
      }
      await onImagesUpdated();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "The product photo was not uploaded.",
      );
    } finally {
      if (uploadInput.current) uploadInput.current.value = "";
      setLoading(null);
    }
  }

  const busy = loading !== null;

  return (
    <section className="product-image-studio" aria-label="Product photo library">
      <div className="product-image-studio-heading">
        <div>
          <h3>Product photo</h3>
          <p>
            Add a package photo to replace the current reference image for your
            household.
          </p>
        </div>
        <div className="product-image-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => uploadInput.current?.click()}
          >
            {loading === "upload" ? "Uploading…" : "Add your photo"}
          </button>
          <input
            ref={uploadInput}
            className="product-photo-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadPhoto(file);
            }}
          />
        </div>
      </div>

      {error ? (
        <p className="product-image-error" role="alert">
          {error}
        </p>
      ) : null}

    </section>
  );
}

function ProductImagePreviewDialog({
  preview,
  returnFocusRef,
  onClose,
}: {
  preview: ProductImagePreview;
  returnFocusRef: { current: HTMLElement | null };
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const returnElement = returnFocusRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;

      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      document.body.style.overflow = previousBodyOverflow;
      returnElement?.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div
      className="product-image-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialog}
        className="product-image-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-image-preview-title"
      >
        <div className="product-image-preview-heading">
          <p id="product-image-preview-title">{preview.label}</p>
          <button
            ref={closeButton}
            type="button"
            className="close-button"
            onClick={onClose}
            aria-label={`Close full image for ${preview.label}`}
          >
            ×
          </button>
        </div>
        <img src={preview.imageUrl} alt={preview.alt} />
      </section>
    </div>
  );
}

function ProductsTab({
  products,
  catalogProducts,
  search,
  setSearch,
  category,
  setCategory,
  sort,
  setSort,
  selectedProductId,
  setSelectedProductId,
  detailOpen,
  setDetailOpen,
  reviewRequestedForProductId,
  onReviewRequestHandled,
  reviewRequestedReceiptItemId,
  onReviewCompleted,
  categories,
  auditThrough,
  openedFromInsights,
  onBack,
  onConfirmProduct,
  onConfirmReceiptProduct,
  onSetProductMemory,
  listItems,
  onAddToList,
  failedWrites,
  onOpenTransaction,
  onImagesUpdated,
}: {
  products: readonly DashboardProduct[];
  catalogProducts: readonly SharedProduct[];
  search: string;
  setSearch: (value: string) => void;
  category: ProductCategoryKey | "all";
  setCategory: (value: ProductCategoryKey | "all") => void;
  sort: ProductSort;
  setSort: (value: ProductSort) => void;
  selectedProductId: string;
  setSelectedProductId: (value: string) => void;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  reviewRequestedForProductId: string | null;
  onReviewRequestHandled: () => void;
  reviewRequestedReceiptItemId: string | null;
  onReviewCompleted: () => void;
  categories: readonly DashboardProductCategory[];
  auditThrough: string;
  openedFromInsights: boolean;
  onBack: () => void;
  onConfirmProduct: (
    product: SharedProduct,
    canonicalName: string,
    category: ProductCategoryKey,
  ) => Promise<boolean>;
  onConfirmReceiptProduct: (
    receiptItemId: string,
    canonicalName: string,
    category: ProductCategoryKey,
  ) => Promise<boolean>;
  onSetProductMemory: (
    product: SharedProduct,
    preference: ProductMemoryPreference,
    note: string,
  ) => Promise<boolean>;
  listItems: readonly SharedListItem[];
  onAddToList: (product: SharedProduct) => Promise<boolean>;
  failedWrites: Record<string, FailedWrite>;
  onOpenTransaction: (transactionId: string) => void;
  onImagesUpdated: () => Promise<void>;
}) {
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const imagePreviewReturnFocus = useRef<HTMLElement | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewName, setReviewName] = useState("");
  const [reviewCategory, setReviewCategory] = useState<
    ProductCategoryKey | ""
  >("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [addingProductId, setAddingProductId] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<ProductImagePreview | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<{
    productId: string;
    preference: ProductMemoryPreference | "";
    note: string;
  } | null>(null);
  const [memorySaving, setMemorySaving] = useState(false);
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matching = products.filter((product) => {
      if (category !== "all" && product.categoryKey !== category) return false;
      if (!query) return true;
      return [product.name, product.rawDescription, product.itemNumber].some((value) =>
        value.toLocaleLowerCase().includes(query),
      );
    });
    return matching.sort((left, right) => {
      if (sort === "alphabetical") {
        return (
          productDisplayName(left).localeCompare(productDisplayName(right)) ||
          left.itemNumber.localeCompare(right.itemNumber)
        );
      }
      if (sort === "rank") {
        return (
          right.purchaseCount - left.purchaseCount ||
          productDisplayName(left).localeCompare(productDisplayName(right)) ||
          left.itemNumber.localeCompare(right.itemNumber)
        );
      }
      return (
        (right.lastPurchasedOn ?? "").localeCompare(left.lastPurchasedOn ?? "") ||
        productDisplayName(left).localeCompare(productDisplayName(right)) ||
        left.itemNumber.localeCompare(right.itemNumber)
      );
    });
  }, [category, products, search, sort]);
  const selected =
    products.find((product) => product.id === selectedProductId) ?? products[0];
  const catalogProduct = catalogProducts.find(
    (product) => product.costcoItemNumber === selected?.itemNumber,
  );
  const selectedIllustration = generatedProductIllustration(selected?.itemNumber);
  const reviewFailure = catalogProduct
    ? failedWrites[`product-review-${catalogProduct.id}`]
    : reviewRequestedReceiptItemId
      ? failedWrites[`receipt-product-${reviewRequestedReceiptItemId}`]
      : undefined;
  const selectedListItem = catalogProduct
    ? listItems.find((item) => item.productId === catalogProduct.id)
    : undefined;
  const memoryFailure = catalogProduct
    ? failedWrites[`product-memory-${catalogProduct.id}`]
    : undefined;
  const activeMemoryDraft =
    memoryDraft?.productId === catalogProduct?.id ? memoryDraft : null;
  const memoryPreference =
    activeMemoryDraft?.preference ?? catalogProduct?.memory?.preference ?? "";
  const memoryNote = activeMemoryDraft?.note ?? catalogProduct?.memory?.note ?? "";

  useEffect(() => {
    if (!detailOpen) return;
    const frame = window.requestAnimationFrame(() => detailHeading.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [detailOpen, selectedProductId]);

  function closeProductDetail() {
    if (openedFromInsights) {
      onBack();
      return;
    }
    setDetailOpen(false);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  }

  function openImagePreview(
    event: ReactMouseEvent<HTMLElement>,
    preview: ProductImagePreview,
  ) {
    imagePreviewReturnFocus.current = event.currentTarget;
    setImagePreview(preview);
  }

  const openProductReviewForm = useCallback(() => {
    setReviewName(catalogProduct?.canonicalName ?? selected?.name ?? "");
    const currentCategory = catalogProduct?.category ?? selected?.categoryKey ?? null;
    setReviewCategory(
      isReviewableProductCategory(currentCategory) ? currentCategory : "",
    );
    setReviewOpen(true);
  }, [
    catalogProduct?.canonicalName,
    catalogProduct?.category,
    selected?.categoryKey,
    selected?.name,
    setReviewCategory,
    setReviewName,
    setReviewOpen,
  ]);

  function toggleProductReview() {
    if (reviewOpen) {
      setReviewOpen(false);
      return;
    }
    openProductReviewForm();
  }

  useEffect(() => {
    if (
      reviewRequestedForProductId !== selected?.id ||
      !detailOpen
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      openProductReviewForm();
      onReviewRequestHandled();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    catalogProduct,
    detailOpen,
    onReviewRequestHandled,
    openProductReviewForm,
    reviewRequestedForProductId,
    selected?.id,
  ]);

  async function saveProductReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewName.trim() || !reviewCategory) return;
    setReviewSaving(true);
    const saved = catalogProduct
      ? await onConfirmProduct(catalogProduct, reviewName.trim(), reviewCategory)
      : reviewRequestedReceiptItemId
        ? await onConfirmReceiptProduct(
            reviewRequestedReceiptItemId,
            reviewName.trim(),
            reviewCategory,
          )
        : false;
    setReviewSaving(false);
    if (saved) {
      setReviewOpen(false);
      onReviewCompleted();
    }
  }

  async function saveProductMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!catalogProduct || !memoryPreference) return;
    setMemorySaving(true);
    const saved = await onSetProductMemory(
      catalogProduct,
      memoryPreference,
      memoryNote.trim(),
    );
    setMemorySaving(false);
    if (saved) setMemoryDraft(null);
  }

  async function addProductFromRow(product: SharedProduct) {
    setAddingProductId(product.id);
    try {
      await onAddToList(product);
    } finally {
      setAddingProductId((current) => (current === product.id ? null : current));
    }
  }

  if (!selected) return null;

  return (
    <div className="page products-page">
      <section className="page-heading with-controls product-heading">
        <div>
          <h1>Products</h1>
        </div>
        <div className="product-filters">
          <label className="select-label">
            <span>Category</span>
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as ProductCategoryKey | "all");
                setDetailOpen(false);
              }}
            >
              <option value="all">All warehouse products</option>
              {categories
                .filter(
                  (candidate) =>
                    candidate.key !== "fuel" &&
                    candidate.key !== "optical_services" &&
                    candidate.itemCount > 0,
                )
                .map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.shortLabel}
                  </option>
                ))}
            </select>
          </label>
          <label className="search-field select-label">
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setDetailOpen(false);
              }}
              placeholder="Name or item number"
            />
          </label>
          <label className="select-label">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as ProductSort)}
            >
              <option value="alphabetical">A–Z</option>
              <option value="recent">Most recent</option>
              <option value="rank">Purchase rank</option>
            </select>
          </label>
        </div>
      </section>

      <section className={`product-layout ${detailOpen ? "detail-open" : ""}`}>
        <div className="product-list card" aria-label="Product results">
          <div className="product-list-header">
            <span>{filteredProducts.length} products</span>
            <span>
              {sort === "alphabetical"
                ? "Alphabetical"
                : sort === "rank"
                  ? "Most purchased"
                  : "Most recent"}
            </span>
          </div>
          {filteredProducts.map((product, index) => {
            const priceDelta =
              product.lastPriceCents !== null && product.previousPriceCents !== null
                ? product.lastPriceCents - product.previousPriceCents
                : null;
            const rowProductName = productDisplayName(product);
            const rowCatalogProduct = catalogProducts.find(
              (candidate) => candidate.costcoItemNumber === product.itemNumber,
            );
            const rowIllustration = generatedProductIllustration(product.itemNumber);
            const rowImageUrl =
              rowCatalogProduct?.image?.imageUrl ?? rowIllustration?.imageUrl;
            const rowImageAlt = rowCatalogProduct?.image
              ? `${rowProductName} package photo`
              : rowIllustration?.alt ?? `Illustration of ${rowProductName}`;
            const rowListItem = rowCatalogProduct
              ? listItems.find((item) => item.productId === rowCatalogProduct.id)
              : undefined;
            const rowAddFailure = rowCatalogProduct
              ? failedWrites[`product-list-${rowCatalogProduct.id}`]
              : undefined;
            const isAdding = addingProductId === rowCatalogProduct?.id;
            const isOnList = rowListItem?.included === true;
            return (
              <div
                key={product.id}
                className={`product-row ${selected.id === product.id ? "active" : ""}`}
              >
                {rowImageUrl ? (
                  <button
                    type="button"
                    className="product-row-image-button"
                    aria-label={`Open full image for ${rowProductName}`}
                    onClick={(event) =>
                      openImagePreview(event, {
                        imageUrl: rowImageUrl,
                        alt: rowImageAlt,
                        label: rowProductName,
                      })
                    }
                  >
                    <span className="product-initial has-photo" aria-hidden="true">
                      <img src={rowImageUrl} alt="" loading="lazy" />
                    </span>
                  </button>
                ) : (
                  <span className="product-initial" aria-hidden="true">
                    {product.name.charAt(0)}
                  </span>
                )}
                <button
                  type="button"
                  className="product-row-open"
                  aria-current={selected.id === product.id ? "true" : undefined}
                  aria-label={`Open details for ${rowProductName}`}
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    setSelectedProductId(product.id);
                    setDetailOpen(true);
                    setReviewOpen(false);
                  }}
                >
                  <span className="product-main">
                    <strong title={rowProductName}>{rowProductName}</strong>
                    <small>
                      {sort === "rank" ? `Rank ${index + 1} · ` : ""}
                      {product.categoryLabel} · {product.purchaseCount}{" "}
                      {product.purchaseCount === 1 ? "purchase" : "purchases"}
                    </small>
                    {rowCatalogProduct?.memory ? (
                      <span
                        className={`product-memory-badge memory-${rowCatalogProduct.memory.preference}`}
                      >
                        {productMemoryLabel(rowCatalogProduct.memory.preference)}
                      </span>
                    ) : null}
                  </span>
                  <span className="product-meta">
                    <strong>
                      {product.lastPriceCents === null
                        ? "—"
                        : currency.format(product.lastPriceCents / 100)}
                    </strong>
                    {priceDelta === null || priceDelta !== 0 ? <small
                      className={
                        priceDelta !== null && priceDelta > 0
                          ? "delta-up"
                          : priceDelta !== null && priceDelta < 0
                            ? "delta-down"
                            : ""
                      }
                    >
                      {priceDelta === null
                        ? formatShortDate(product.lastPurchasedOn)
                        : `${priceDelta > 0 ? "+" : ""}${currency.format(priceDelta / 100)}`}
                    </small> : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={`secondary-button product-row-action ${
                    rowAddFailure ? "has-error" : ""
                  }`}
                  disabled={!rowCatalogProduct || isOnList || addingProductId !== null}
                  aria-label={
                    isAdding
                      ? `Adding ${rowProductName} to list`
                      : isOnList
                        ? `${rowProductName} is on the active list`
                        : rowAddFailure
                          ? `Retry adding ${rowProductName} to list`
                          : `Add ${rowProductName} to list`
                  }
                  title={rowAddFailure?.message}
                  onClick={() => {
                    if (rowCatalogProduct) void addProductFromRow(rowCatalogProduct);
                  }}
                >
                  {isAdding
                    ? "Adding…"
                    : isOnList
                      ? "On list"
                      : rowAddFailure
                        ? "Retry"
                        : "Add"}
                </button>
              </div>
            );
          })}
          {!filteredProducts.length ? (
            <div className="empty-state">
              <strong>No matching product</strong>
              <p>Try a shorter product name or an item number.</p>
            </div>
          ) : null}
        </div>

        <article className="product-detail card" aria-live="polite">
          <button
            type="button"
            className={`back-button product-context-back ${
              openedFromInsights ? "from-insights" : "from-products"
            }`}
            onClick={closeProductDetail}
          >
            ← Back to {openedFromInsights ? "Insights" : "products"}
          </button>
          <div className="product-detail-summary">
            <figure
              className={`product-detail-image ${
                catalogProduct?.image || selectedIllustration ? "has-photo" : ""
              }`}
            >
              {catalogProduct?.image ? (
                <>
                  <button
                    type="button"
                    className="product-detail-image-button"
                    onClick={(event) =>
                      openImagePreview(event, {
                        imageUrl: catalogProduct.image!.imageUrl,
                        alt: `${productDisplayName(selected)} package photo`,
                        label: productDisplayName(selected),
                      })
                    }
                  >
                    <div className="product-detail-artwork">
                      <img
                        src={catalogProduct.image.imageUrl}
                        alt={`${productDisplayName(selected)} package`}
                      />
                    </div>
                  </button>
                  {catalogProduct.image.sourceType === "ai_generated" ? (
                    <figcaption className="product-illustration-note">
                      AI-generated reference · packaging may differ
                    </figcaption>
                  ) : null}
                </>
              ) : selectedIllustration ? (
                <>
                  <button
                    type="button"
                    className="product-detail-image-button"
                    onClick={(event) =>
                      openImagePreview(event, {
                        imageUrl: selectedIllustration.imageUrl,
                        alt: selectedIllustration.alt,
                        label: productDisplayName(selected),
                      })
                    }
                  >
                    <div className="product-detail-artwork">
                      <img
                        src={selectedIllustration.imageUrl}
                        alt={selectedIllustration.alt}
                      />
                    </div>
                  </button>
                  <figcaption className="product-illustration-note">
                    AI illustration · package may differ
                  </figcaption>
                </>
              ) : (
                <>
                  <div className="product-detail-artwork">
                    <span aria-hidden="true">{productDisplayName(selected).charAt(0)}</span>
                  </div>
                  <figcaption>Photo pending</figcaption>
                </>
              )}
            </figure>
            <div className="product-detail-top">
              <div>
              <p className="section-label">Item {selected.itemNumber}</p>
              <h2 ref={detailHeading} tabIndex={-1}>
                {productDisplayName(selected)}
              </h2>
              <p>{selected.categoryLabel} · receipt history through {formatShortDate(auditThrough)}</p>
              </div>
              <div className="product-identification-actions">
              <EvidenceBadge
                label={
                  selected.classificationStatus === "reviewed"
                    ? "Reviewed category"
                    : selected.classificationStatus === "rule_based"
                      ? "Rule-matched category"
                      : "Category needs review"
                }
                tone={
                  selected.classificationStatus === "reviewed"
                    ? "confirmed"
                    : selected.classificationStatus === "rule_based"
                      ? "suggestion"
                      : "unknown"
                }
              />
              <button
                type="button"
                className="text-button product-review-trigger"
                onClick={toggleProductReview}
                disabled={!catalogProduct && !reviewRequestedReceiptItemId}
              >
                {selected.classificationStatus === "needs_review"
                  ? "Help identify this item"
                  : "Edit identification"}
              </button>
              <button
                type="button"
                className="secondary-button product-add-to-list"
                disabled={!catalogProduct || selectedListItem?.included}
                onClick={() => {
                  if (catalogProduct) void onAddToList(catalogProduct);
                }}
              >
                {selectedListItem?.included ? "On active list" : "Add to list"}
              </button>
              </div>
            </div>
          </div>
          {reviewOpen && (catalogProduct || reviewRequestedReceiptItemId) ? (
            <form className="product-review-form" onSubmit={saveProductReview}>
              <div className="product-review-copy">
                <strong>Help the household recognize this product</strong>
                <p>
                  This updates the friendly name and category for both spouses. The
                  original receipt text stays unchanged.
                </p>
              </div>
              <label>
                <span>Receipt text</span>
                <input value={selected.rawDescription} readOnly />
              </label>
              <label>
                <span>Friendly product name</span>
                <input
                  value={reviewName}
                  onChange={(event) => setReviewName(event.target.value)}
                  maxLength={140}
                  autoComplete="off"
                  required
                />
              </label>
              <label>
                <span>Category</span>
                <select
                  value={reviewCategory}
                  onChange={(event) =>
                    setReviewCategory(event.target.value as ProductCategoryKey | "")
                  }
                  required
                >
                  <option value="">Choose the best fit</option>
                  {reviewableProductCategories.map((candidate) => (
                    <option key={candidate.key} value={candidate.key}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
              {reviewFailure ? (
                <p className="product-review-error" role="alert">
                  {reviewFailure.message} Review the latest details, then save again.
                </p>
              ) : null}
              <div className="product-review-buttons">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setReviewOpen(false)}
                >
                  Not sure yet
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={reviewSaving || !reviewName.trim() || !reviewCategory}
                >
                  {reviewSaving ? "Saving…" : "Save identification"}
                </button>
              </div>
              {catalogProduct?.categoryReviewedByDisplayName ? (
                <small>
                  Last reviewed by {catalogProduct.categoryReviewedByDisplayName}
                </small>
              ) : null}
            </form>
          ) : null}
          {catalogProduct ? (
            <form className="product-memory-editor" onSubmit={saveProductMemory}>
              <div className="product-memory-editor-heading">
                <div>
                  <strong>Household Product Memory</strong>
                  <p>
                    This explicit choice shapes future Saturday Prep suggestions.
                    Receipt cadence alone never decides it.
                  </p>
                </div>
                {catalogProduct.memory ? (
                  <span
                    className={`product-memory-badge memory-${catalogProduct.memory.preference}`}
                  >
                    {productMemoryLabel(catalogProduct.memory.preference)}
                  </span>
                ) : null}
              </div>
              <div
                className="product-memory-choice-grid"
                role="radiogroup"
                aria-label="Product memory preference"
              >
                {(
                  [
                    ["buy_again", "Buy again", "May appear when its receipt cadence suggests it is due."],
                    ["pause", "Pause for now", "Stays out of Prep until the household changes it."],
                    ["not_for_us", "Not for us", "Stays out of future suggestions until changed."],
                  ] as const
                ).map(([value, label, description]) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={memoryPreference === value}
                    className={memoryPreference === value ? "selected" : ""}
                    key={value}
                    disabled={memorySaving}
                    onClick={() =>
                      setMemoryDraft({
                        productId: catalogProduct.id,
                        preference: value,
                        note: memoryNote,
                      })
                    }
                  >
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </button>
                ))}
              </div>
              <label className="product-memory-editor-note">
                <span>Optional household note</span>
                <input
                  value={memoryNote}
                  onChange={(event) =>
                    setMemoryDraft({
                      productId: catalogProduct.id,
                      preference: memoryPreference,
                      note: event.target.value,
                    })
                  }
                  maxLength={500}
                  placeholder="Smaller package next time"
                  disabled={memorySaving}
                />
              </label>
              {catalogProduct.memory?.sourcePurchasedAt ? (
                <small className="product-memory-source">
                  Current memory traces to a reconciled purchase from{" "}
                  {formatShortDate(catalogProduct.memory.sourcePurchasedAt)}.
                </small>
              ) : null}
              {memoryFailure ? (
                <p className="product-review-error" role="alert">
                  {memoryFailure.message}
                </p>
              ) : null}
              <div className="product-memory-editor-actions">
                <span>
                  {catalogProduct.memory
                    ? "Change this any time. The newest explicit choice is used."
                    : "No household memory has been saved yet."}
                </span>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={memorySaving || !memoryPreference}
                >
                  {memorySaving ? "Saving…" : "Save memory"}
                </button>
              </div>
            </form>
          ) : null}
          {catalogProduct ? (
            <ProductImageStudio
              key={catalogProduct.id}
              product={catalogProduct}
              onImagesUpdated={onImagesUpdated}
            />
          ) : null}
          <div className="detail-metrics">
            <div>
              <span>Median purchase interval</span>
              <strong>
                {selected.medianIntervalDays === null
                  ? "First recorded purchase"
                  : `${selected.medianIntervalDays} days`}
              </strong>
            </div>
            <div>
              <span>Latest package price</span>
              <strong>
                {selected.lastPriceCents === null
                  ? "Not available"
                  : currency.format(selected.lastPriceCents / 100)}
              </strong>
            </div>
            <div>
              <span>Recorded net spend</span>
              <strong>{currency.format(selected.totalSpendCents / 100)}</strong>
            </div>
          </div>
          <div className="evidence-row">
            <EvidenceBadge label="From receipts" tone="receipt" />
            <span>
              {selected.purchaseCount} matching {selected.purchaseCount === 1 ? "transaction" : "transactions"} since{" "}
              {formatShortDate(selected.firstPurchasedOn)}
            </span>
          </div>

          <div className="history-section">
            <div className="section-heading">
              <h3>Exact-product receipt history</h3>
            </div>
            <div className="price-history">
              {selected.priceHistory.slice(-10).map((point) => (
                <button
                  type="button"
                  className="price-point"
                  key={`${point.transactionId}-${point.purchasedOn}`}
                  onClick={() => onOpenTransaction(point.transactionId)}
                >
                  <span>{formatShortDate(point.purchasedOn)}</span>
                  {point.purchaseContext === "ad_hoc" ? <EvidenceBadge label="Ad hoc" tone="receipt" /> : null}
                  <strong>{currency.format(point.netAmountCents / 100)} paid</strong>
                  {point.discountCents > 0 ? (
                    <small className="price-discount">
                      Regular {currency.format(point.grossAmountCents / 100)} · saved{" "}
                      {currency.format(point.discountCents / 100)}
                    </small>
                  ) : (
                    <small>Receipt price · no line discount</small>
                  )}
                  {point.quantity !== 1 ? <small>{point.quantity} units</small> : null}
                </button>
              ))}
            </div>
          </div>

          <div className="raw-name">
            <span>Latest raw receipt description</span>
            <code>{selected.rawDescription}</code>
          </div>

          <div className="product-truth-note">
            <strong>What this cannot tell us yet</strong>
            <p>
              Purchase interval is not consumption interval. Pantry checks, spoilage,
              satisfaction, and household feedback supply the context receipts lack.
            </p>
          </div>
        </article>
      </section>
      {imagePreview ? (
        <ProductImagePreviewDialog
          preview={imagePreview}
          returnFocusRef={imagePreviewReturnFocus}
          onClose={() => setImagePreview(null)}
        />
      ) : null}
    </div>
  );
}

function ReviewTab({
  closedLoop,
  history,
  selectedReceiptId,
  historyStatus,
  historyError,
  canCorrect,
  connected,
  sandboxMode,
  onSelectReceipt,
  onOpenReceipt,
  onCorrectReceipt,
  onRetryHistory,
  onRefresh,
}: {
  closedLoop: ClosedLoopSnapshot | null;
  history: TripReviewHistoryEntry[];
  selectedReceiptId: string | null;
  historyStatus: DeferredViewStatus;
  historyError: string | null;
  canCorrect: boolean;
  connected: boolean;
  sandboxMode: boolean;
  onSelectReceipt: (receiptId: string) => void;
  onOpenReceipt: (step?: ReceiptStep) => void;
  onCorrectReceipt: () => void;
  onRetryHistory: () => void;
  onRefresh: (nextClosedLoop?: ClosedLoopSnapshot) => Promise<void>;
}) {
  const selected = history.find((entry) => entry.receiptId === selectedReceiptId) ?? history[0];
  return (
    <div className="page review-page">
      <section className="page-heading">
        <h1>Receipt recaps</h1>
      </section>

      {historyStatus === "loading" && !history.length ? (
        <section className="card review-history-loading" role="status" aria-busy="true">
          <span className="deferred-loading-mark" aria-hidden="true" />
          <div><strong>Loading trip history</strong><p>Finding your completed receipt reviews.</p></div>
        </section>
      ) : null}
      {historyError ? (
        <section className="card review-history-error" role="alert">
          <div><strong>Trip history needs another try</strong><p>{historyError}</p></div>
          <button type="button" className="secondary-button" onClick={onRetryHistory}>Retry</button>
        </section>
      ) : null}
      {history.length ? (
        <section className="card review-history-picker" aria-labelledby="review-history-title">
          <div>
            <h2 id="review-history-title">Choose a trip</h2>
          </div>
          <label>
            <span className="sr-only">Completed Costco trip</span>
            <select
              value={selected?.receiptId ?? ""}
              onChange={(event) => onSelectReceipt(event.target.value)}
            >
              {history.map((entry) => (
                <option key={entry.receiptId} value={entry.receiptId}>
                  {formatFullDate(entry.scheduledFor)} · {currency.format(entry.totalCents / 100)}
                  {entry.correctionCount ? ` · corrected ${entry.correctionCount}×` : ""}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <div className="review-history-summary">
              <span>{selected.itemCount} receipt {selected.itemCount === 1 ? "line" : "lines"}</span>
              <span>{selected.openQuestionCount ? `${selected.openQuestionCount} open review ${selected.openQuestionCount === 1 ? "question" : "questions"}` : "Review complete"}</span>
              {selected.correctionCount ? <span>Revision {selected.correctionCount + 1}</span> : <span>Original revision</span>}
            </div>
          ) : null}
        </section>
      ) : historyStatus === "ready" ? (
        <section className="card empty-state">
          <strong>No completed receipt reviews yet</strong>
          <p>Your first completed trip will appear here.</p>
        </section>
      ) : null}
      {historyStatus === "loading" && history.length && !closedLoop ? (
        <section className="card review-history-loading" role="status" aria-busy="true">
          <span className="deferred-loading-mark" aria-hidden="true" />
          <div><strong>Loading this trip</strong><p>Rebuilding its saved receipt comparison.</p></div>
        </section>
      ) : null}
      {closedLoop ? (
        <ClosedLoopReview
          closedLoop={closedLoop}
          connected={connected}
          sandboxMode={sandboxMode}
          onOpenReceipt={canCorrect ? () => onCorrectReceipt() : onOpenReceipt}
          canEditReceipt={canCorrect}
          receiptActionLabel="Correct receipt"
          onRefresh={onRefresh}
        />
      ) : null}
    </div>
  );
}

function EvidenceBadge({
  label,
  tone,
}: {
  label: string;
  tone: "receipt" | "confirmed" | "suggestion" | "unknown";
}) {
  return <span className={`evidence-badge ${tone}`}>{label}</span>;
}

function DataDialog({
  viewData,
  error,
  onRetry,
  returnFocusRef,
  onClose,
}: {
  viewData: DashboardViewData | null;
  error: string | null;
  onRetry: () => void;
  returnFocusRef: { current: HTMLElement | null };
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const returnElement = returnFocusRef.current;
    closeButton.current?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;

      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      returnElement?.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialog}
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-dialog-title"
      >
        <div className="dialog-heading">
          <div>
            <p className="section-label">Private household data</p>
            <h2 id="data-dialog-title">Receipt audit &amp; storage</h2>
          </div>
          <button
            ref={closeButton}
            className="close-button"
            onClick={onClose}
            aria-label="Close data and privacy status"
          >
            ×
          </button>
        </div>
        <p className="dialog-intro">
          BasketSense stores structured receipt and Saturday-list data in the private
          household database. When a photo upload succeeds, the original image is kept
          separately in private object storage. Costco credentials are never requested or
          stored.
        </p>

        {viewData ? (
          <div className="data-audit-summary">
            <div>
              <span>Audited through</span>
              <strong>{formatFullDate(viewData.audit.through)}</strong>
            </div>
            <div>
              <span>Receipt transactions</span>
              <strong>{viewData.audit.transactionCount}</strong>
            </div>
            <div>
              <span>Reconciliation issues</span>
              <strong>{viewData.audit.reconciliationIssueCount}</strong>
            </div>
          </div>
        ) : (
          <div className="empty-state" role={error ? "alert" : "status"}>
            <strong>{error ? "Audit summary could not be loaded" : "Loading audit summary"}</strong>
            <p>
              {error
                ? error
                : "BasketSense calculates the receipt summary only when you request it."}
            </p>
            {error ? (
              <button className="secondary-button" type="button" onClick={onRetry}>
                Try again
              </button>
            ) : null}
          </div>
        )}

        <div className="truth-list">
          <h3>Stored for this household</h3>
          <ul>
            <li>Structured receipt totals, line items, and exact item numbers in D1</li>
            <li>The unified Saturday list and its saved pre-trip snapshot in D1</li>
            <li>Household answers with who answered and what they update</li>
            <li>Original receipt photos in private object storage after upload succeeds</li>
          </ul>
        </div>

        <div className="next-ingestion-note">
          <strong>Receipt reading stays reviewable</strong>
          <p>
            Text drafting runs on this device when the optional reader is available; the
            receipt image is not sent to an OCR provider. You check the lines and arithmetic
            before BasketSense treats the receipt as trusted. Paste and manual entry remain
            available when automatic reading cannot load.
          </p>
        </div>

        <div className="dialog-actions">
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}
