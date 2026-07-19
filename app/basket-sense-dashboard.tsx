"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
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
import type { HouseholdListResponse } from "./api/household/types";
import { DataHealthExplorer } from "./data-health-explorer";
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
  ClosedLoopReview,
  ReceiptFlowDialog,
  ReceiptNextStepCard,
  type ClosedLoopSnapshot,
  type ReceiptStep,
} from "./receipt-review-flow";

type Tab = "overview" | "products" | "week" | "review" | "data";
type TripStatus = "planning" | "frozen" | "completed";
type ListItemSource =
  | "manual"
  | "recurring"
  | "predicted"
  | "consider"
  | "in_store";
type SyncStatus = "connecting" | "shared" | "refreshing" | "offline";
type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

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
};

type SharedProduct = HouseholdCatalogProductMetadata & {
  id: string;
  categoryReviewedAt: string | null;
  categoryReviewedByDisplayName: string | null;
  latestPurchasedAt: string | null;
  latestRegularUnitPriceCents: number | null;
  latestPaidUnitPriceCents: number | null;
  latestDiscountUnitCents: number | null;
  updatedAt: string;
};

type SharedFeedback = {
  id: string;
  receiptTransactionId: string | null;
  kind: string;
  value: string;
  rating: number | null;
  createdByMemberId: string | null;
  createdAt: string;
};

type HouseholdSnapshot = {
  household: { id: string; name: string; timeZone: string };
  currentUser: HouseholdMember;
  members: HouseholdMember[];
  currentTrip: SharedTrip;
  listItems: SharedListItem[];
  products: SharedProduct[];
  feedback: SharedFeedback[];
  closedLoop?: ClosedLoopSnapshot | null;
  dashboard: DashboardViewData;
};

type WriteRequest = {
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  successMessage: string;
};

type FailedWrite = {
  message: string;
  request: WriteRequest;
};

type BasketSenseDashboardProps = {
  user: DashboardUser;
  viewData: DashboardViewData;
};

const primaryTabs = [
  { id: "week", label: "List", symbol: "✓" },
  { id: "overview", label: "Insights", symbol: "↗" },
  { id: "products", label: "Products", symbol: "▤" },
  { id: "review", label: "Review", symbol: "?" },
] as const satisfies readonly { id: Tab; label: string; symbol: string }[];

const dataHealthTab = { id: "data", label: "Data Health", symbol: "⌘" } as const;

const THEME_STORAGE_KEY = "basketsense-color-theme";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
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
  description: string;
}[] = [
  {
    key: "essentials",
    label: "Essentials",
    description: "Recurring staples and household additions",
  },
  {
    key: "suggested",
    label: "Recommended",
    description: "Timely ideas from your exact purchase history",
  },
  {
    key: "check_first",
    label: "Check first",
    description: "Confirm the fridge, pantry, or freezer before adding",
  },
  {
    key: "consider",
    label: "Seasonal",
    description: "Optional favorites that may not be available every week",
  },
];

function activeItemStatus(item: SharedListItem, status: TripStatus) {
  if (
    status === "frozen" &&
    (item.addedAfterFreeze || item.includedAtFreeze === false)
  ) {
    return "Added during trip";
  }
  if (status === "frozen" && item.includedAtFreeze) return "Planned";
  return sourceLabel(item.source);
}

function freezeEvidence(item: SharedListItem, status: TripStatus) {
  if (status !== "frozen") return null;
  if (item.addedAfterFreeze || (item.includedAtFreeze === false && item.included)) {
    return "Added during the trip";
  }
  if (item.includedAtFreeze) return "On the list when shopping started";
  return "Not on the list when shopping started";
}

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
}: BasketSenseDashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("week");
  const [household, setHousehold] = useState<HouseholdSnapshot | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
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
  const [selectedProductId, setSelectedProductId] = useState(
    viewData.products[0]?.id ?? "",
  );
  const [productDetailOpen, setProductDetailOpen] = useState(false);
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
    useState<"current" | "latest">("current");
  const [toast, setToast] = useState<string | null>(null);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("system");
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");
  const [themeReady, setThemeReady] = useState(false);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const listRefreshPromise = useRef<Promise<void> | null>(null);
  const toastTimer = useRef<number | null>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const receiptFlowReturnFocus = useRef<HTMLElement | null>(null);
  const productReturnFocus = useRef<string | null>(null);
  const listMoveFocus = useRef<{
    itemId: string;
    destination: "active" | "ideas" | "active-heading";
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
    themePreference === "system" ? systemTheme : themePreference;

  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () =>
      setSystemTheme(colorScheme.matches ? "dark" : "light");
    const syncStoredTheme = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setThemePreference(
        event.newValue === "light" || event.newValue === "dark"
          ? event.newValue
          : "system",
      );
    };

    const hydrateTheme = window.setTimeout(() => {
      updateSystemTheme();
      try {
        const savedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (savedPreference === "light" || savedPreference === "dark") {
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
        const response = await fetch("/api/household", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
          throw new Error(
            apiErrorMessage(body, "The shared household could not be reached."),
          );
        }
        setHousehold(body as HouseholdSnapshot);
        setSyncStatus("shared");
        setSyncError(null);
        setLastSyncedAt(new Date());
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
  }, []);

  const refreshHouseholdList = useCallback(
    async (tripId: string) => {
      if (refreshPromise.current) return refreshPromise.current;
      if (listRefreshPromise.current) return listRefreshPromise.current;

      let shouldRefreshFullSnapshot = false;
      const refresh = (async () => {
        try {
          const response = await fetch(
            `/api/household?scope=list&tripId=${encodeURIComponent(tripId)}`,
            {
              headers: { Accept: "application/json" },
              cache: "no-store",
            },
          );
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
          setHousehold((current) =>
            !current || current.currentTrip.id !== tripId
              ? current
              : {
                  ...current,
                  currentTrip: snapshot.currentTrip,
                  listItems: snapshot.listItems,
                },
          );
          setSyncStatus("shared");
          setSyncError(null);
          setLastSyncedAt(new Date());
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
    [refreshHousehold],
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
    const refreshPeriodMs = activeTab === "week" ? 5_000 : 15_000;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible" || pendingWrites.size) return;
      const tripId = household?.currentTrip.id;
      if (activeTab === "week" && tripId) {
        void refreshHouseholdList(tripId);
      } else {
        void refreshHousehold(true);
      }
    }, refreshPeriodMs);

    return () => window.clearInterval(interval);
  }, [
    activeTab,
    household?.currentTrip.id,
    pendingWrites.size,
    refreshHousehold,
    refreshHouseholdList,
  ]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
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
      const target =
        request.destination === "active-heading"
          ? document.getElementById("active-list-title")
          : Array.from(
              document.querySelectorAll<HTMLElement>("[data-list-item-focus]"),
            ).find(
              (element) =>
                element.dataset.listItemFocus === request.itemId &&
                element.dataset.listItemLocation === request.destination,
            );
      target?.focus();
      listMoveFocus.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, household?.listItems]);

  function flash(message: string) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 2_600);
  }

  function toggleTheme() {
    setThemePreference(resolvedTheme === "dark" ? "light" : "dark");
  }

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    if (tab === "products") {
      setProductOrigin("products");
      setProductDetailOpen(false);
      productReturnFocus.current = null;
    }
    window.scrollTo({ top: 0 });
  }

  function openProduct(productId: string) {
    productReturnFocus.current = productId;
    setSelectedProductId(productId);
    setProductSearch("");
    setProductCategory("all");
    setProductDetailOpen(true);
    setProductOrigin("insights");
    setActiveTab("products");
    window.scrollTo({ top: 0 });
  }

  function closeProductDetail() {
    setProductDetailOpen(false);
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
    (step: ReceiptStep = "capture", scope: "current" | "latest" = "current") => {
      receiptFlowReturnFocus.current = document.activeElement as HTMLElement | null;
      setReceiptFlowInitialStep(step);
      setReceiptFlowScope(scope);
      setIsReceiptFlowOpen(true);
    },
    [],
  );

  const closeReceiptFlow = useCallback(() => {
    setIsReceiptFlowOpen(false);
    window.setTimeout(() => receiptFlowReturnFocus.current?.focus(), 0);
  }, []);

  const openTripReview = useCallback(() => {
    setIsReceiptFlowOpen(false);
    setActiveTab("review");
    window.scrollTo({ top: 0 });
  }, []);

  async function performWrite(key: string, request: WriteRequest) {
    setPendingWrites((current) => new Set(current).add(key));
    setFailedWrites((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    try {
      const response = await fetch("/api/household", {
        method: request.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(apiErrorMessage(body, "That change was not saved."));
      }
      await refreshHousehold(true, true);
      flash(request.successMessage);
      return true;
    } catch (error) {
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

  function retryWrite(key: string) {
    const failure = failedWrites[key];
    if (failure) void performWrite(key, failure.request);
  }

  function toggleIncluded(item: SharedListItem) {
    const key = `item-${item.id}`;
    const nextIncluded = !item.included;
    const shoppingStarted = household?.currentTrip.status === "frozen";
    listMoveFocus.current = {
      itemId: item.id,
      destination: nextIncluded
        ? "active"
        : shoppingStarted &&
            (item.includedAtFreeze === true || item.addedAfterFreeze)
          ? "active-heading"
          : "ideas",
    };
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
    setHousehold((current) =>
      current
        ? {
            ...current,
            listItems: current.listItems.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, checked: !item.checked }
                : candidate,
            ),
          }
        : current,
    );
    void performWrite(key, {
      method: "PATCH",
      body: {
        action: "set_item_checked",
        itemId: item.id,
        checked: !item.checked,
      },
      successMessage: item.checked ? "Item unchecked" : "Item checked off",
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
  const auditRange = formatAuditRange(
    effectiveViewData.transactions,
    effectiveViewData.audit.through,
  );
  const visibleTabs =
    household?.currentUser.role === "owner"
      ? [...primaryTabs, dataHealthTab]
      : primaryTabs;

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
              <strong>Our household</strong>
              <small>Connected as {visibleUser.displayName}</small>
            </span>
          </div>
          <button className="text-button" onClick={openDataDialog}>
            Data &amp; privacy
          </button>
        </div>
      </aside>

      <main className="main-canvas">
        <header className="topbar">
          <div className="topbar-context">
            <span className="mobile-kicker">BasketSense</span>
            <p className="data-label">
              {effectiveViewData.audit.transactionCount} receipt transactions audited · {auditRange}
            </p>
          </div>
          <div className="topbar-actions">
            <div className="theme-control" role="group" aria-label="Color theme">
              <button
                type="button"
                className={`theme-toggle ${resolvedTheme}`}
                onClick={toggleTheme}
                aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
                aria-pressed={resolvedTheme === "dark"}
                title={
                  themePreference === "system"
                    ? `Following this device’s ${resolvedTheme} preference`
                    : `${resolvedTheme === "dark" ? "Dark" : "Light"} theme saved on this device`
                }
              >
                <span className="theme-toggle-track" aria-hidden="true">
                  <span className="theme-symbol">☀︎</span>
                  <span className="theme-symbol">☾</span>
                  <span className="theme-toggle-knob" />
                </span>
                <span className="theme-toggle-label">
                  {resolvedTheme === "dark" ? "Dark" : "Light"}
                </span>
              </button>
              <button
                type="button"
                className={`theme-auto ${themePreference === "system" ? "active" : ""}`}
                onClick={() => setThemePreference("system")}
                aria-pressed={themePreference === "system"}
                title="Follow this device’s color preference"
              >
                Auto
              </button>
            </div>
            <div
              className="avatar-stack"
              aria-label={
                shownMembers.length
                  ? `Household members ${shownMembers
                      .map((member) => member.displayName)
                      .join(" and ")}`
                  : "Two-person household"
              }
            >
              {shownMembers.map((member, index) => (
                <span
                  className={`avatar ${index === 0 ? "avatar-one" : "avatar-two"}`}
                  key={member.id}
                  aria-hidden="true"
                >
                  {initials(member.displayName)}
                </span>
              ))}
            </div>
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
            lastSyncedAt={lastSyncedAt}
            suggestionPlanDate={effectiveViewData.suggestionPlanDate}
            newItem={newItem}
            setNewItem={setNewItem}
            pendingWrites={pendingWrites}
            failedWrites={failedWrites}
            onRetry={retryWrite}
            onAdd={addManualItem}
            onToggleIncluded={toggleIncluded}
            onToggleChecked={toggleChecked}
            onFreeze={freezeTrip}
            onUnfreeze={unfreezeTrip}
            onCopy={copyList}
            onOpenReceipt={(step) => openReceiptFlow(step, "current")}
          />
        ) : null}

        {activeTab === "overview" ? (
          <OverviewTab
            viewData={effectiveViewData}
            changeTab={changeTab}
            selectedMonth={insightMonth}
            setSelectedMonth={setInsightMonth}
            selectedCategoryKey={insightCategoryKey}
            setSelectedCategoryKey={setInsightCategoryKey}
            selectedTransactionId={insightTransactionId}
            setSelectedTransactionId={setInsightTransactionId}
            onOpenProduct={openProduct}
          />
        ) : null}

        {activeTab === "products" ? (
          <ProductsTab
            products={effectiveViewData.products}
            catalogProducts={household?.products ?? []}
            search={productSearch}
            setSearch={setProductSearch}
            category={productCategory}
            setCategory={setProductCategory}
            selectedProductId={selectedProductId}
            setSelectedProductId={setSelectedProductId}
            detailOpen={productDetailOpen}
            setDetailOpen={setProductDetailOpen}
            categories={effectiveViewData.productCategories}
            auditThrough={effectiveViewData.audit.through}
            openedFromInsights={productOrigin === "insights"}
            onBack={closeProductDetail}
            onConfirmProduct={confirmProductMetadata}
            failedWrites={failedWrites}
            onOpenTransaction={openTransaction}
          />
        ) : null}

        {activeTab === "review" ? (
          <ReviewTab
            closedLoop={closedLoop}
            connected={Boolean(household) && syncStatus !== "offline"}
            onOpenReceipt={(step) => openReceiptFlow(step, "latest")}
            onRefresh={async () => {
              await refreshHousehold(true, true);
            }}
          />
        ) : null}

        {activeTab === "data" && household?.currentUser.role === "owner" ? (
          <DataHealthExplorer />
        ) : null}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => changeTab(tab.id)}
            aria-current={activeTab === tab.id ? "page" : undefined}
          >
            <span className="nav-glyph" aria-hidden="true">
              {tab.symbol}
            </span>
            <span>{tab.label}</span>
            {tab.id === "review" && openReviewCount > 0 ? (
              <span className="mobile-count">{openReviewCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {isDataDialogOpen ? (
        <DataDialog
          viewData={effectiveViewData}
          returnFocusRef={dialogReturnFocus}
          onClose={closeDataDialog}
        />
      ) : null}

      <ReceiptFlowDialog
        open={isReceiptFlowOpen}
        initialStep={receiptFlowInitialStep}
        tripId={household?.currentTrip.id ?? null}
        tripStatus={household?.currentTrip.status ?? null}
        closedLoop={
          receiptFlowScope === "latest" ? closedLoop : currentTripClosedLoop
        }
        onClose={closeReceiptFlow}
        onRefresh={async () => {
          await refreshHousehold(true, true);
        }}
        onOpenReview={openTripReview}
      />

      <div className="live-region" aria-live="polite" aria-atomic="true">
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    </div>
  );
}

function ThisWeekTab({
  household,
  syncStatus,
  syncError,
  lastSyncedAt,
  suggestionPlanDate,
  newItem,
  setNewItem,
  pendingWrites,
  failedWrites,
  onRetry,
  onAdd,
  onToggleIncluded,
  onToggleChecked,
  onFreeze,
  onUnfreeze,
  onCopy,
  onOpenReceipt,
}: {
  household: HouseholdSnapshot | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  lastSyncedAt: Date | null;
  suggestionPlanDate: string;
  newItem: string;
  setNewItem: (value: string) => void;
  pendingWrites: Set<string>;
  failedWrites: Record<string, FailedWrite>;
  onRetry: (key: string) => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onToggleIncluded: (item: SharedListItem) => void;
  onToggleChecked: (item: SharedListItem) => void;
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
  const quickItemRef = useRef<HTMLInputElement>(null);
  const unfreezeTriggerRef = useRef<HTMLButtonElement>(null);
  const startShoppingRef = useRef<HTMLButtonElement>(null);
  const previousTripState = useRef<{
    id: string;
    status: TripStatus;
  } | null>(null);
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
  const memberById = new Map(
    household?.members.map((member) => [member.id, member]) ?? [],
  );
  const shoppingStarted = trip?.status === "frozen";
  const frozenContextKey = shoppingStarted
    ? `${trip.id}:${trip.frozenAt ?? "pending"}`
    : null;
  const confirmUnfreeze =
    frozenContextKey !== null && unfreezeConfirmationKey === frozenContextKey;
  const frozenEstimateCents = trip?.estimatedListTotalAtFreezeCents ?? null;
  const frozenPricedItemCount =
    trip?.estimatedPricedItemCountAtFreeze ?? null;
  const frozenUnpricedItemCount =
    trip?.estimatedUnpricedItemCountAtFreeze ?? null;
  const frozenItemCount =
    frozenPricedItemCount !== null && frozenUnpricedItemCount !== null
      ? frozenPricedItemCount + frozenUnpricedItemCount
      : null;
  const estimateChangeCents =
    shoppingStarted && frozenEstimateCents !== null
      ? estimatedCents - frozenEstimateCents
      : null;
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
  const frozenCoverage =
    frozenPricedItemCount !== null && frozenItemCount !== null
      ? ` · ${frozenPricedItemCount} of ${frozenItemCount} priced`
      : "";
  const freezeEstimateCopy =
    !shoppingStarted
      ? "Updates with the live list · before tax · not a spending cap"
      : frozenEstimateCents === null
        ? "Shopping started · starting estimate unavailable"
        : frozenPricedItemCount === 0
          ? `Started with no price estimate${frozenCoverage}${pricedIncluded.length ? ` · now ~${currency.format(estimatedCents / 100)}` : ""}`
          : `Started at ~${currency.format(frozenEstimateCents / 100)}${frozenCoverage}${estimateChangeCents
            ? ` · ${estimateChangeCents > 0 ? "+" : "−"}${currency.format(Math.abs(estimateChangeCents) / 100)} since then`
            : " · unchanged"}`;
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
  const syncTitle =
    syncStatus === "connecting"
      ? "Connecting the household list"
      : syncStatus === "offline"
        ? "Shared list is temporarily unavailable"
        : shoppingStarted
          ? "Live list · shopping started"
          : "Live shared list · auto-updates";
  const syncCopy =
    syncStatus === "offline"
      ? `${syncError ?? "Try again shortly."} Nothing is stored only on this device.`
      : syncStatus === "connecting"
        ? "Loading the one list shared by both household members."
        : shoppingStarted
          ? `Planned list captured${trip?.frozenAt ? ` at ${new Date(trip.frozenAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Active changes reach both phones in about five seconds.`
          : `Checks for changes every five seconds while this list is visible.${lastSyncedAt ? ` Last checked ${lastSyncedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}.` : ""}`;
  const activeCatalogProduct = catalogResults[activeCatalogIndex] ?? null;
  const showCatalogResults = Boolean(
    catalogOpen && household && catalogResults.length,
  );

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

  return (
    <div className="page week-page">
      <section className="page-heading with-controls">
        <div>
          <p className="section-label">Shared weekly plan</p>
          <h1>This Saturday</h1>
          <p>
            {trip
              ? `${formatFullDate(trip.scheduledFor)} · both spouses edit one list`
              : `${formatFullDate(suggestionPlanDate)} · both spouses edit one list`}
          </p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={onCopy}>
            Copy list
          </button>
          {!shoppingStarted ? (
            <button
              ref={startShoppingRef}
              className="primary-button"
              onClick={onFreeze}
              disabled={!household || !included.length || pendingWrites.has("freeze-trip")}
            >
              {pendingWrites.has("freeze-trip") ? "Starting…" : "Start shopping"}
            </button>
          ) : (
            <>
              <span className="frozen-pill">Shopping started</span>
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

      <section
        className={`device-notice ${
          syncStatus === "offline"
            ? "warning"
            : syncStatus === "shared"
              ? "compact"
              : ""
        }`}
        aria-live={syncStatus === "shared" ? "off" : "polite"}
      >
        <span className="device-notice-mark" aria-hidden="true">
          {syncStatus === "offline" ? "!" : syncStatus === "connecting" ? "…" : "✓"}
        </span>
        <div>
          <strong>{syncTitle}</strong>
          <p>{syncCopy}</p>
        </div>
      </section>

      <InlineWriteError
        failure={failedWrites["freeze-trip"]}
        onRetry={() => onRetry("freeze-trip")}
      />
      <InlineWriteError
        failure={failedWrites["unfreeze-trip"]}
        onRetry={() => onRetry("unfreeze-trip")}
      />

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
            aria-describedby="quick-add-catalog-hint"
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
                        {product.latestPurchasedAt
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
      <p
        className="quick-add-hint"
        id="quick-add-catalog-hint"
        aria-live="polite"
      >
        {matchedCatalogProduct &&
        matchedCatalogProduct.latestRegularUnitPriceCents !== null
          ? `Estimate will use its latest regular package price: ${currency.format(matchedCatalogProduct.latestRegularUnitPriceCents / 100)}${matchedCatalogProduct.latestPurchasedAt ? ` from ${formatShortDate(matchedCatalogProduct.latestPurchasedAt)}` : ""}.`
          : newItem.trim()
            ? "Choose an exact past product to add its receipt-based estimate; genuinely new items can stay unpriced."
            : `Search ${catalogOptions.length} past warehouse products. Select a match to reuse its latest regular package price.`}
      </p>
      <InlineWriteError
        failure={failedWrites["quick-add"]}
        onRetry={() => onRetry("quick-add")}
      />

      <section className="week-summary" aria-label="Saturday list summary">
        <div>
          <span>On the shared list</span>
          <strong>{included.length} items</strong>
        </div>
        <div className="estimate-summary" aria-live="polite">
          <span>Estimated list total</span>
          <strong>{estimateDisplay}</strong>
          <small>{estimateCoverage}</small>
          <small>{freezeEstimateCopy}</small>
        </div>
        <div>
          <span>List status</span>
          <strong>{shoppingStarted ? "Shopping" : "Planning"}</strong>
          <small>
            {shoppingStarted
              ? "Planned list captured"
              : "Review suggestions, then start shopping"}
          </small>
        </div>
      </section>

      {trip ? (
        <ReceiptNextStepCard
          tripStatus={trip.status}
          closedLoop={
            household?.closedLoop?.receipt?.tripId === trip.id
              ? household.closedLoop
              : null
          }
          onOpen={onOpenReceipt}
        />
      ) : null}

      <div className="week-layout">
        <div className="weekly-list-stack">
          <section className="list-card card" aria-labelledby="active-list-title">
            <div className="list-section-heading active-list-heading">
              <div>
                <p className="section-label">This trip</p>
                <h2 id="active-list-title" tabIndex={-1}>Active List</h2>
                <p>Only items your household has chosen to buy.</p>
              </div>
              <span>
                {included.length} {included.length === 1 ? "item" : "items"}
              </span>
            </div>
            {!household && syncStatus !== "offline" ? (
              <ListSkeleton />
            ) : included.length ? (
              <div className="list-rows" role="list">
                {included.map((item) => {
                  const key = `item-${item.id}`;
                  const pending = pendingWrites.has(key);
                  const addedBy = item.addedByMemberId
                    ? memberById.get(item.addedByMemberId)?.displayName
                    : null;
                  const itemEstimateCents = estimatedItemTotalCents(item);
                  const quantityLabel = (item.quantityMilli / 1000).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 3 },
                  );
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
                        className={`list-row included ${item.checked ? "checked" : ""}`}
                      >
                        {shoppingStarted ? (
                          <button
                            type="button"
                            className="check-button"
                            onClick={() => onToggleChecked(item)}
                            aria-label={`${item.checked ? "Uncheck" : "Check"} ${item.label}`}
                            disabled={pending}
                          >
                            <span aria-hidden="true">{item.checked ? "✓" : ""}</span>
                          </button>
                        ) : (
                          <span className="active-list-mark" aria-hidden="true">✓</span>
                        )}
                        <div className="list-row-copy">
                          <strong>{item.label}</strong>
                          {!shoppingStarted ? (
                            <>
                              <p>{item.recommendationReason ?? sourceLabel(item.source)}</p>
                              <small>
                                {[
                                  activeItemStatus(item, trip?.status ?? "planning"),
                                  addedBy ? `Added by ${addedBy}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || sourceLabel(item.source)}
                              </small>
                            </>
                          ) : (
                            <details className="item-evidence">
                              <summary>Why it is here</summary>
                              <p>{item.recommendationReason ?? sourceLabel(item.source)}</p>
                              <small>
                                {[
                                  freezeEvidence(item, trip?.status ?? "planning"),
                                  addedBy ? `Added by ${addedBy}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                            </details>
                          )}
                        </div>
                        <div className="list-row-actions">
                          <span className="estimated-price">
                            {item.estimatedPriceCents === null
                              ? "No estimate"
                              : item.quantityMilli === 1000
                                ? `~${currency.format(item.estimatedPriceCents / 100)}`
                                : `~${currency.format((itemEstimateCents ?? 0) / 100)} · ${quantityLabel} × ${currency.format(item.estimatedPriceCents / 100)}`}
                          </span>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onToggleIncluded(item)}
                            disabled={pending}
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
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state active-list-empty">
                <strong>Your active list is empty</strong>
                <p>
                  Search the household catalog above or add an idea below. The
                  estimate only counts items moved here.
                </p>
              </div>
            )}
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
            suggestionPlanDate={suggestionPlanDate}
            household={household}
            items={ideaItems}
            pendingWrites={pendingWrites}
            failedWrites={failedWrites}
            onRetry={onRetry}
            onAdd={onToggleIncluded}
          />
        </div>

        <aside className="week-rail">
          <article className="card why-card">
            <p className="section-label">How suggestions work</p>
            <h2>Receipts suggest timing. You decide need.</h2>
            <p>
              Purchase cadence is not consumption cadence. BasketSense shows the
              evidence and waits for either spouse to add the item.
            </p>
            <details className="rules-disclosure">
              <summary>See the first rules</summary>
              <ul>
                <li>Exact item-number purchase count</li>
                <li>Median days between matching purchases</li>
                <li>Days since the last matching receipt</li>
                <li>No pantry or waste claim without household input</li>
              </ul>
            </details>
          </article>
          <article className="card share-card">
            <div className="avatar-stack" aria-hidden="true">
              <span className="avatar avatar-one">1</span>
              <span className="avatar avatar-two">2</span>
            </div>
            <h2>One list, two phones</h2>
            <p>
              The database is the shared source of truth. This list checks for
              your spouse’s changes every five seconds while visible.
            </p>
            <button className="secondary-button" onClick={onCopy}>
              Copy a snapshot
            </button>
          </article>
        </aside>
      </div>
    </div>
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
  suggestionPlanDate,
  household,
  items,
  pendingWrites,
  failedWrites,
  onRetry,
  onAdd,
}: {
  suggestionPlanDate: string;
  household: HouseholdSnapshot | null;
  items: readonly SharedListItem[];
  pendingWrites: Set<string>;
  failedWrites: Record<string, FailedWrite>;
  onRetry: (key: string) => void;
  onAdd: (item: SharedListItem) => void;
}) {
  const shoppingStarted = household?.currentTrip.status === "frozen";
  const ideaGroups = IDEA_SECTIONS.map((section) => ({
    ...section,
    items: items.filter((item) => item.section === section.key),
  })).filter((section) => section.items.length);

  return (
    <section className="suggestion-shelf" aria-labelledby="ideas-title">
      <div className="card-heading ideas-heading">
        <div>
          <p className="section-label">
            Suggested starting points for {formatShortDate(household?.currentTrip.scheduledFor ?? suggestionPlanDate)}
          </p>
          <h2 id="ideas-title">Ideas</h2>
          <p>
            {shoppingStarted
              ? "These were not on the starting list. Add one if it makes sense in the warehouse."
              : "Nothing here affects the estimate until either spouse adds it to the Active List."}
          </p>
        </div>
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
                  <div>
                    <h3 id={headingId}>{group.label}</h3>
                    <p>{group.description}</p>
                  </div>
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
                          <strong>{item.label}</strong>
                          <p>{item.recommendationReason ?? sourceLabel(item.source)}</p>
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
                        </div>
                        <button
                          type="button"
                          className="add-button"
                          onClick={() => onAdd(item)}
                          disabled={pending}
                          aria-label={`Add ${item.label} to the Active List`}
                        >
                          {pending
                            ? "Adding…"
                            : shoppingStarted
                              ? "Add during trip"
                              : "Add to list"}
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
          <p>Remove an item before shopping if you want to keep it here for later.</p>
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
  changeTab,
  selectedMonth,
  setSelectedMonth,
  selectedCategoryKey,
  setSelectedCategoryKey,
  selectedTransactionId,
  setSelectedTransactionId,
  onOpenProduct,
}: {
  viewData: DashboardViewData;
  changeTab: (tab: Tab) => void;
  selectedMonth: string;
  setSelectedMonth: (month: string) => void;
  selectedCategoryKey: ProductCategoryKey | null;
  setSelectedCategoryKey: (category: ProductCategoryKey | null) => void;
  selectedTransactionId: string | null;
  setSelectedTransactionId: (transactionId: string | null) => void;
  onOpenProduct: (productId: string) => void;
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
      <section className="page-heading">
        <p className="section-label">Audited household history</p>
        <h1>Insights</h1>
        <p>
          Explore 2026 spending from category to trip to receipt line. Planned
          comparisons begin only after Start shopping captures a pre-trip list.
        </p>
      </section>

      <section className="notice-card gentle">
        <span className="notice-mark" aria-hidden="true">✓</span>
        <p>
          <strong>
            {viewData.audit.reconciliationIssueCount === 0
              ? `All ${viewData.audit.transactionCount} receipt transactions reconcile.`
              : "The audit still has open reconciliation work."}
          </strong>{" "}
          Category mappings are visible and reviewable. Receipts alone cannot prove
          need, use, waste, regret, or whether a purchase was planned.
        </p>
      </section>

      <section className="metrics-strip four" aria-label={`${scopeLabel} Costco summary`}>
        <article>
          <span>Household-funded</span>
          <strong>{currency.format(scopeHouseholdCents / 100)}</strong>
          <small>{scopeLabel}</small>
        </article>
        <article>
          <span>Receipt transactions</span>
          <strong>{transactions.length}</strong>
          <small>{transactions.filter((transaction) => transaction.channel === "warehouse").length} warehouse shops</small>
        </article>
        <article>
          <span>Warehouse tax</span>
          <strong>{currency.format(scopeWarehouseTaxCents / 100)}</strong>
          <small>Shown separately from product categories</small>
        </article>
        <article>
          <span>Needs review</span>
          <strong>{currency.format(scopeNeedsReviewCents / 100)}</strong>
          <small>Uncertain receipt abbreviations stay visible</small>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="card spend-card">
          <div className="card-heading">
            <div>
              <h2>Household-funded spend by month</h2>
              <p>Select a month to update categories and receipts below.</p>
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
              <p>Tap a category to see its trips and products.</p>
            </div>
            <EvidenceBadge label="After discounts" tone="receipt" />
          </div>
          <ProductCategoryBars
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
            <p>Tap an amount to open the complete receipt and every recorded line.</p>
          </div>
        </div>
        <TransactionTable
          transactions={receiptRows}
          onOpenTransaction={setSelectedTransactionId}
        />
      </section>

      <section className="learning-section">
        <div className="card-heading">
          <div>
            <p className="section-label">Next useful actions</p>
            <h2>Behavioral insight starts with intent</h2>
          </div>
          <EvidenceBadge label="Truth boundary" tone="unknown" />
        </div>
        <div className="learning-grid">
          <button className="insight-card" onClick={() => changeTab("week")}>
            <span className="insight-icon sage">1</span>
            <span className="insight-copy">
              <strong>Start shopping from the shared plan</strong>
              <p>That captures the first defensible planned-versus-added comparison.</p>
            </span>
            <span className="insight-link">Open list</span>
          </button>
          <button className="insight-card" onClick={() => changeTab("review")}>
            <span className="insight-icon apricot">1 min</span>
            <span className="insight-copy">
              <strong>Keep feedback lightweight</strong>
              <p>One neutral trip question adds context receipts cannot provide.</p>
            </span>
            <span className="insight-link">Review trip</span>
          </button>
          <button className="insight-card" onClick={() => changeTab("products")}>
            <span className="insight-icon lilac">SKU</span>
            <span className="insight-copy">
              <strong>Follow exact product history</strong>
              <p>See item-number cadence and package prices without guessing use.</p>
            </span>
            <span className="insight-link">View products</span>
          </button>
        </div>
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
  return (
    <div className="bar-chart">
      <div className="chart-scope-actions">
        <span>Household-funded 2026</span>
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

function ProductCategoryBars({
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
  const visibleCategories = categories.filter(
    (category) => category.householdViewCents > 0,
  );
  const max = Math.max(
    taxCents,
    ...visibleCategories.map((category) => category.householdViewCents),
  );
  return (
    <div className="category-bars">
      {visibleCategories.map((category) => {
        const share = totalCents
          ? Math.round((category.householdViewCents / totalCents) * 100)
          : 0;
        return (
          <button
            type="button"
            className="category-bar-row category-bar-button"
            key={category.key}
            onClick={() => onSelectCategory(category.key)}
          >
            <div className="category-label">
              <span>{category.shortLabel}</span>
              <strong>{currency.format(category.householdViewCents / 100)}</strong>
            </div>
            <div
              className="category-track"
              aria-label={`${category.label}: ${currency.format(category.householdViewCents / 100)}, ${share}% of household-funded spend`}
            >
              <span
                style={{
                  width: `${(category.householdViewCents / max) * 100}%`,
                  background: category.color,
                }}
              />
            </div>
            <small>
              {category.transactionCount} {category.transactionCount === 1 ? "trip" : "trips"} · {share}% · Open details →
            </small>
          </button>
        );
      })}
      <div className="category-bar-row tax-row">
        <div className="category-label">
          <span>Warehouse sales tax</span>
          <strong>{currency.format(taxCents / 100)}</strong>
        </div>
        <div className="category-track" aria-label={`Warehouse sales tax: ${currency.format(taxCents / 100)}`}>
          <span
            style={{
              width: `${max ? (taxCents / max) * 100 : 0}%`,
              background: "var(--review)",
            }}
          />
        </div>
        <small>Kept separate instead of being silently allocated to products</small>
      </div>
      <p className="channel-footnote">
        Warehouse categories use merchandise after discounts and before tax. Fuel
        and optical use household-funded totals; optical excludes insurance benefits.
      </p>
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
                <td>{channelLabel(transaction.channel)}</td>
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
              <small>{channelLabel(transaction.channel)} · {transaction.itemCount} items</small>
            </span>
            <span>
              <strong>{currency.format(transaction.householdFundedCents / 100)}</strong>
              <small>Open receipt →</small>
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
            These abbreviations are intentionally unallocated. Opening a product shows
            the raw Costco text so the household can confirm it before totals move.
          </p>
        </section>
      ) : null}

      {topProducts.length ? (
        <section className="card category-product-list">
          <div className="card-heading">
            <div>
              <h2>{channel ? "Receipt lines" : "Products in this category"}</h2>
              <p>
                {channel
                  ? "Largest recorded receipt-line values first; Optical lines are gross service values."
                  : "Largest recorded net merchandise amounts first."}
              </p>
            </div>
          </div>
          <div className="category-product-rows">
            {topProducts.map(({ line, spendCents, count }) => {
              const product = productByItem.get(line.itemNumber);
              const content = (
                <>
                  <span>
                    <strong>{line.name}</strong>
                    <small>{line.rawDescription} · item {line.itemNumber} · {count} {count === 1 ? "trip" : "trips"}</small>
                  </span>
                  <span>
                    <strong>{currency.format(spendCents / 100)}</strong>
                    <small>{classificationLabel(line.classificationStatus)}</small>
                  </span>
                </>
              );
              return product ? (
                <button
                  type="button"
                  key={line.itemNumber}
                  data-open-product-id={product.id}
                  onClick={() => onOpenProduct(product.id)}
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
            <p>Open a receipt to see the exact contributing lines.</p>
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
        <p className="section-label">{channelLabel(transaction.channel)} receipt</p>
        <h1>{formatFullDate(transaction.purchasedOn)}</h1>
        <p>{sourceLabel} · {transaction.itemCount} recorded items</p>
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
            <p>Tap a warehouse product to open its exact item-number history.</p>
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

function ProductsTab({
  products,
  catalogProducts,
  search,
  setSearch,
  category,
  setCategory,
  selectedProductId,
  setSelectedProductId,
  detailOpen,
  setDetailOpen,
  categories,
  auditThrough,
  openedFromInsights,
  onBack,
  onConfirmProduct,
  failedWrites,
  onOpenTransaction,
}: {
  products: readonly DashboardProduct[];
  catalogProducts: readonly SharedProduct[];
  search: string;
  setSearch: (value: string) => void;
  category: ProductCategoryKey | "all";
  setCategory: (value: ProductCategoryKey | "all") => void;
  selectedProductId: string;
  setSelectedProductId: (value: string) => void;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  categories: readonly DashboardProductCategory[];
  auditThrough: string;
  openedFromInsights: boolean;
  onBack: () => void;
  onConfirmProduct: (
    product: SharedProduct,
    canonicalName: string,
    category: ProductCategoryKey,
  ) => Promise<boolean>;
  failedWrites: Record<string, FailedWrite>;
  onOpenTransaction: (transactionId: string) => void;
}) {
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewName, setReviewName] = useState("");
  const [reviewCategory, setReviewCategory] = useState<
    ProductCategoryKey | ""
  >("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return products.filter((product) => {
      if (category !== "all" && product.categoryKey !== category) return false;
      if (!query) return true;
      return [product.name, product.rawDescription, product.itemNumber].some((value) =>
        value.toLocaleLowerCase().includes(query),
      );
    });
  }, [category, products, search]);
  const selected =
    products.find((product) => product.id === selectedProductId) ?? products[0];
  const catalogProduct = catalogProducts.find(
    (product) => product.costcoItemNumber === selected?.itemNumber,
  );
  const reviewFailure = catalogProduct
    ? failedWrites[`product-review-${catalogProduct.id}`]
    : undefined;

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

  function toggleProductReview() {
    if (reviewOpen) {
      setReviewOpen(false);
      return;
    }
    setReviewName(catalogProduct?.canonicalName ?? selected?.name ?? "");
    const currentCategory = catalogProduct?.category ?? selected?.categoryKey ?? null;
    setReviewCategory(
      isReviewableProductCategory(currentCategory) ? currentCategory : "",
    );
    setReviewOpen(true);
  }

  async function saveProductReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!catalogProduct || !reviewName.trim() || !reviewCategory) return;
    setReviewSaving(true);
    const saved = await onConfirmProduct(
      catalogProduct,
      reviewName.trim(),
      reviewCategory,
    );
    setReviewSaving(false);
    if (saved) setReviewOpen(false);
  }

  if (!selected) return null;

  return (
    <div className="page products-page">
      <section className="page-heading with-controls product-heading">
        <div>
          <p className="section-label">Exact receipt item numbers</p>
          <h1>Products</h1>
          <p>Purchase cadence and package price—not inferred household consumption.</p>
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
        </div>
      </section>

      <section className="notice-card gentle">
        <span className="notice-mark" aria-hidden="true">
          i
        </span>
        <p>
          Names are conservative household-friendly normalizations of Costco receipt
          abbreviations. Exact item number is the matching anchor; ambiguous names stay
          visible as raw receipt text.
        </p>
      </section>

      <section className={`product-layout ${detailOpen ? "detail-open" : ""}`}>
        <div className="product-list card" aria-label="Product results">
          <div className="product-list-header">
            <span>{filteredProducts.length} products</span>
            <span>Repeat count, then spend</span>
          </div>
          {filteredProducts.map((product) => {
            const priceDelta =
              product.lastPriceCents !== null && product.previousPriceCents !== null
                ? product.lastPriceCents - product.previousPriceCents
                : null;
            return (
              <button
                type="button"
                key={product.id}
                className={`product-row ${selected.id === product.id ? "active" : ""}`}
                aria-current={selected.id === product.id ? "true" : undefined}
                onClick={(event) => {
                  returnFocus.current = event.currentTarget;
                  setSelectedProductId(product.id);
                  setDetailOpen(true);
                  setReviewOpen(false);
                }}
              >
                <span className="product-initial" aria-hidden="true">
                  {product.name.charAt(0)}
                </span>
                <span className="product-main">
                  <strong title={productDisplayName(product)}>
                    {productDisplayName(product)}
                  </strong>
                  <small>
                    {product.categoryLabel} · {product.purchaseCount}{" "}
                    {product.purchaseCount === 1 ? "purchase" : "purchases"}
                  </small>
                </span>
                <span className="product-meta">
                  <strong>
                    {product.lastPriceCents === null
                      ? "—"
                      : currency.format(product.lastPriceCents / 100)}
                  </strong>
                  <small className={priceDelta !== null && priceDelta > 0 ? "delta-up" : priceDelta !== null && priceDelta < 0 ? "delta-down" : ""}>
                    {priceDelta === null
                      ? formatShortDate(product.lastPurchasedOn)
                      : priceDelta === 0
                      ? "No latest change"
                      : `${priceDelta > 0 ? "+" : ""}${currency.format(priceDelta / 100)}`}
                  </small>
                </span>
              </button>
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
                disabled={!catalogProduct}
              >
                {selected.classificationStatus === "needs_review"
                  ? "Help identify this item"
                  : "Edit identification"}
              </button>
            </div>
          </div>
          {reviewOpen && catalogProduct ? (
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
              {catalogProduct.categoryReviewedByDisplayName ? (
                <small>
                  Last reviewed by {catalogProduct.categoryReviewedByDisplayName}
                </small>
              ) : null}
            </form>
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
              <span>Open any trip</span>
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
                  <strong>{currency.format(point.netAmountCents / 100)} paid</strong>
                  {point.discountCents > 0 ? (
                    <small className="price-discount">
                      Regular {currency.format(point.grossAmountCents / 100)} · saved{" "}
                      {currency.format(point.discountCents / 100)}
                    </small>
                  ) : (
                    <small>Receipt price · no line discount</small>
                  )}
                  <small>
                    {point.quantity !== 1 ? `${point.quantity} units · ` : ""}
                    Open receipt →
                  </small>
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
    </div>
  );
}

function ReviewTab({
  closedLoop,
  connected,
  onOpenReceipt,
  onRefresh,
}: {
  closedLoop: ClosedLoopSnapshot | null;
  connected: boolean;
  onOpenReceipt: (step?: ReceiptStep) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="page review-page">
      <section className="page-heading">
        <p className="section-label">One useful closed loop</p>
        <h1>Review</h1>
        <p>Check the receipt first. Then add only the household context the receipt cannot know.</p>
      </section>
      <ClosedLoopReview
        closedLoop={closedLoop}
        connected={connected}
        onOpenReceipt={onOpenReceipt}
        onRefresh={onRefresh}
      />
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
  returnFocusRef,
  onClose,
}: {
  viewData: DashboardViewData;
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
