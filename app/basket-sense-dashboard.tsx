"use client";

import {
  FormEvent,
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
  DashboardSuggestion,
  DashboardTransaction,
  DashboardViewData,
} from "./dashboard-types";
import type { ProductCategoryKey } from "./product-categories";

type Tab = "overview" | "products" | "week" | "review";
type TripStatus = "planning" | "frozen" | "completed";
type ListItemSource =
  | "manual"
  | "recurring"
  | "predicted"
  | "consider"
  | "in_store";
type SyncStatus = "connecting" | "shared" | "refreshing" | "offline";

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

type SharedProduct = {
  id: string;
  costcoItemNumber: string | null;
  canonicalName: string;
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

function listSection(item: SharedListItem, status: TripStatus) {
  if (
    status === "frozen" &&
    (item.addedAfterFreeze || (item.includedAtFreeze === false && item.included))
  ) {
    return "Added during trip";
  }
  if (item.section === "essentials") return "Essentials";
  if (item.section === "suggested") return "Recommended";
  if (item.section === "check_first") return "Check first";
  return "Seasonal consider";
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
  const [insightMonth, setInsightMonth] = useState<string>("all");
  const [insightCategoryKey, setInsightCategoryKey] =
    useState<ProductCategoryKey | null>(null);
  const [insightTransactionId, setInsightTransactionId] = useState<string | null>(
    null,
  );
  const [isDataDialogOpen, setIsDataDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const toastTimer = useRef<number | null>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);

  const refreshHousehold = useCallback(async (quiet = false, forceFresh = false) => {
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

  useEffect(() => {
    void refreshHousehold();

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshHousehold(true);
    };
    const refreshOnFocus = () => void refreshHousehold(true);
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshHousehold]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  function flash(message: string) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 2_600);
  }

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    if (tab === "products") setProductDetailOpen(false);
    window.scrollTo({ top: 0 });
  }

  function openProduct(productId: string) {
    setSelectedProductId(productId);
    setProductSearch("");
    setProductCategory("all");
    setProductDetailOpen(true);
    setActiveTab("products");
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
    setHousehold((current) =>
      current
        ? {
            ...current,
            listItems: current.listItems.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    included: !item.included,
                    checked: item.included ? false : candidate.checked,
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
        included: !item.included,
      },
      successMessage: "Shared list updated",
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
    const request: WriteRequest = {
      method: "POST",
      body: {
        action: "add_list_item",
        tripId: household.currentTrip.id,
        label,
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

  function addSuggestion(suggestion: DashboardSuggestion) {
    if (!household) return;
    const product = household.products.find(
      (candidate) => candidate.costcoItemNumber === suggestion.itemNumber,
    );
    void performWrite(`suggestion-${suggestion.id}`, {
      method: "POST",
      body: {
        action: "add_list_item",
        tripId: household.currentTrip.id,
        label: suggestion.name,
        productId: product?.id ?? null,
        section: suggestion.section,
        source: "predicted",
        recommendationReason: suggestion.reason,
        confidenceBps: suggestion.confidenceBps,
        included: true,
        estimatedPriceCents: suggestion.estimatedPriceCents,
      },
      successMessage: `${suggestion.name} added to the shared list`,
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

  function saveTripFeedback(value: string, rating: number) {
    void performWrite("trip-feedback", {
      method: "POST",
      body: {
        action: "add_feedback",
        receiptTransactionId: viewData.latestWarehouseTransaction.id,
        kind: "trip_enjoyment",
        value,
        rating,
      },
      successMessage: "Your trip note is now part of the shared household history",
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

  const currentUserFeedback = household?.feedback.find(
    (feedback) =>
      feedback.receiptTransactionId === viewData.latestWarehouseTransaction.id &&
      feedback.kind === "trip_enjoyment" &&
      feedback.createdByMemberId === household.currentUser.id,
  );
  const openReviewCount = currentUserFeedback ? 0 : 1;
  const members = household?.members.length ? household.members : [];
  const shownMembers = members.slice(0, 2);
  const visibleUser = household?.currentUser ?? {
    id: "server-user",
    displayName: user.displayName,
    email: user.email,
    role: "member" as const,
  };
  const auditRange = formatAuditRange(
    viewData.transactions,
    viewData.audit.through,
  );

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
          {primaryTabs.map((tab) => (
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
              {viewData.audit.transactionCount} receipt transactions audited · {auditRange}
            </p>
          </div>
          <div className="topbar-actions">
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
            suggestions={viewData.suggestions}
            suggestionPlanDate={viewData.suggestionPlanDate}
            newItem={newItem}
            setNewItem={setNewItem}
            pendingWrites={pendingWrites}
            failedWrites={failedWrites}
            onRetry={retryWrite}
            onAdd={addManualItem}
            onAddSuggestion={addSuggestion}
            onToggleIncluded={toggleIncluded}
            onToggleChecked={toggleChecked}
            onFreeze={freezeTrip}
            onCopy={copyList}
          />
        ) : null}

        {activeTab === "overview" ? (
          <OverviewTab
            viewData={viewData}
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
            products={viewData.products}
            search={productSearch}
            setSearch={setProductSearch}
            category={productCategory}
            setCategory={setProductCategory}
            selectedProductId={selectedProductId}
            setSelectedProductId={setSelectedProductId}
            detailOpen={productDetailOpen}
            setDetailOpen={setProductDetailOpen}
            categories={viewData.productCategories}
            auditThrough={viewData.audit.through}
            onOpenTransaction={openTransaction}
          />
        ) : null}

        {activeTab === "review" ? (
          <ReviewTab
            latestTransaction={viewData.latestWarehouseTransaction}
            currentFeedback={currentUserFeedback}
            householdFeedback={household?.feedback ?? []}
            members={members}
            connected={Boolean(household) && syncStatus !== "offline"}
            pending={pendingWrites.has("trip-feedback")}
            failure={failedWrites["trip-feedback"]}
            onRetry={() => retryWrite("trip-feedback")}
            onSave={saveTripFeedback}
          />
        ) : null}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {primaryTabs.map((tab) => (
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
          viewData={viewData}
          returnFocusRef={dialogReturnFocus}
          onClose={closeDataDialog}
        />
      ) : null}

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
  suggestions,
  suggestionPlanDate,
  newItem,
  setNewItem,
  pendingWrites,
  failedWrites,
  onRetry,
  onAdd,
  onAddSuggestion,
  onToggleIncluded,
  onToggleChecked,
  onFreeze,
  onCopy,
}: {
  household: HouseholdSnapshot | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  lastSyncedAt: Date | null;
  suggestions: readonly DashboardSuggestion[];
  suggestionPlanDate: string;
  newItem: string;
  setNewItem: (value: string) => void;
  pendingWrites: Set<string>;
  failedWrites: Record<string, FailedWrite>;
  onRetry: (key: string) => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onAddSuggestion: (suggestion: DashboardSuggestion) => void;
  onToggleIncluded: (item: SharedListItem) => void;
  onToggleChecked: (item: SharedListItem) => void;
  onFreeze: () => void;
  onCopy: () => void;
}) {
  const trip = household?.currentTrip;
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
  const sections = [
    "Essentials",
    "Recommended",
    "Check first",
    "Seasonal consider",
    "Added during trip",
  ];
  const memberById = new Map(
    household?.members.map((member) => [member.id, member]) ?? [],
  );
  const shoppingStarted = trip?.status === "frozen";
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
  const removedAfterStart = shoppingStarted
    ? items.filter((item) => item.includedAtFreeze === true && !item.included)
    : [];
  const visibleItems = shoppingStarted
    ? items.filter((item) => item.included || item.addedAfterFreeze)
    : items;
  const itemsBySection = new Map(
    sections.map((section) => [
      section,
      visibleItems.filter(
        (item) => listSection(item, trip?.status ?? "planning") === section,
      ),
    ]),
  );

  const syncTitle =
    syncStatus === "connecting"
      ? "Connecting the household list"
      : syncStatus === "offline"
        ? "Shared list is temporarily unavailable"
        : shoppingStarted
          ? "Shared list · shopping started"
          : "Live shared household list";
  const syncCopy =
    syncStatus === "offline"
      ? `${syncError ?? "Try again shortly."} Nothing is stored only on this device.`
      : syncStatus === "connecting"
        ? "Loading the one list shared by both household members."
        : shoppingStarted
          ? `Planned list captured${trip?.frozenAt ? ` at ${new Date(trip.frozenAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. New finds stay visible as added during the trip.`
          : `Changes appear on both phones. ${lastSyncedAt ? `Last checked ${lastSyncedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}`;

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
              className="primary-button"
              onClick={onFreeze}
              disabled={!household || !included.length || pendingWrites.has("freeze-trip")}
            >
              {pendingWrites.has("freeze-trip") ? "Starting…" : "Start shopping"}
            </button>
          ) : (
            <span className="frozen-pill">Shopping started</span>
          )}
        </div>
      </section>

      <ol className="trip-phases" aria-label="Trip progress">
        <li className="complete"><span>1</span>Plan</li>
        <li className={shoppingStarted ? "active" : ""}><span>2</span>Shop</li>
        <li><span>3</span>Review</li>
      </ol>

      <section
        className={`device-notice ${
          syncStatus === "offline"
            ? "warning"
            : syncStatus === "shared"
              ? "compact"
              : ""
        }`}
        aria-live="polite"
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

      <form className="quick-add" onSubmit={onAdd}>
        <label className="sr-only" htmlFor="quick-item">
          Add an item
        </label>
        <input
          id="quick-item"
          value={newItem}
          onChange={(event) => setNewItem(event.target.value)}
          placeholder={shoppingStarted ? "Add something found during the trip…" : "Add milk, fruit, diapers…"}
          disabled={!household || pendingWrites.has("quick-add")}
        />
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

      <div className="week-layout">
        <div className="weekly-list-stack">
          <section className="list-card card" aria-label="Shared Saturday list">
            {!household && syncStatus !== "offline" ? (
              <ListSkeleton />
            ) : items.length ? (
              <>
              {sections.map((section) => {
                const sectionItems = itemsBySection.get(section) ?? [];
                if (!sectionItems.length) return null;
                return (
                  <div className="list-section" key={section}>
                    <div className="list-section-heading">
                      <div>
                        <h2>{section}</h2>
                        <p>
                          {section === "Added during trip"
                            ? "Kept separate from the list captured before shopping"
                            : section === "Recommended"
                              ? "Suggested from explainable purchase patterns"
                              : section === "Check first"
                                ? "A pantry or fridge check should decide"
                              : section === "Seasonal consider"
                                ? "Optional favorites that may be seasonal"
                                : "Recurring essentials and household additions"}
                        </p>
                      </div>
                      <span>
                        {sectionItems.filter((item) => item.included).length}/
                        {sectionItems.length}
                      </span>
                    </div>
                    <div className="list-rows">
                      {sectionItems.map((item) => {
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
                          <div className="list-row-wrap" key={item.id}>
                            <div
                              className={`list-row ${item.included ? "included" : ""} ${item.checked ? "checked" : ""}`}
                            >
                              {item.included ? (
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
                                <span className="suggestion-dot" aria-hidden="true" />
                              )}
                              <div className="list-row-copy">
                                <strong>{item.label}</strong>
                                {!shoppingStarted ? (
                                  <>
                                    <p>{item.recommendationReason ?? sourceLabel(item.source)}</p>
                                    <small>
                                      {[
                                        cadenceConfidence(item.confidenceBps),
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
                                  className={item.included ? "text-button" : "add-button"}
                                  onClick={() => onToggleIncluded(item)}
                                  disabled={pending}
                                  aria-label={`${item.included ? "Remove" : "Add"} ${item.label} ${item.included ? "from" : "to"} the list`}
                                >
                                  {pending ? "Saving…" : item.included ? "Remove" : "Add"}
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
                  </div>
                );
              })}
              {removedAfterStart.length ? (
                <details className="removed-list">
                  <summary>
                    {removedAfterStart.length} planned {removedAfterStart.length === 1 ? "item" : "items"} removed · Undo
                  </summary>
                  <div className="removed-list-rows">
                    {removedAfterStart.map((item) => {
                      const key = `item-${item.id}`;
                      return (
                        <div className="removed-list-row" key={item.id}>
                          <span>
                            <strong>{item.label}</strong>
                            <small>Was on the list when shopping started</small>
                          </span>
                          <button
                            type="button"
                            className="add-button"
                            onClick={() => onToggleIncluded(item)}
                            disabled={pendingWrites.has(key)}
                            aria-label={`Add ${item.label} back to the list`}
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
              </>
            ) : (
              <div className="empty-state">
                <strong>Your shared list is empty</strong>
                <p>
                  Add an item above or accept one of the receipt-rhythm suggestions
                  below. Nothing is included automatically.
                </p>
              </div>
            )}
          </section>

          {!household || !household.listItems.length ? (
          <SuggestionShelf
            suggestions={suggestions}
            suggestionPlanDate={suggestionPlanDate}
              household={household}
              pendingWrites={pendingWrites}
              failedWrites={failedWrites}
              onRetry={onRetry}
              onAdd={onAddSuggestion}
            />
          ) : null}
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
              The database is the shared source of truth. The list refreshes when
              the app regains focus and every 15 seconds while visible.
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
  suggestions,
  suggestionPlanDate,
  household,
  pendingWrites,
  failedWrites,
  onRetry,
  onAdd,
}: {
  suggestions: readonly DashboardSuggestion[];
  suggestionPlanDate: string;
  household: HouseholdSnapshot | null;
  pendingWrites: Set<string>;
  failedWrites: Record<string, FailedWrite>;
  onRetry: (key: string) => void;
  onAdd: (suggestion: DashboardSuggestion) => void;
}) {
  return (
    <section className="suggestion-shelf" aria-labelledby="suggestion-title">
      <div className="card-heading">
        <div>
          <p className="section-label">Explainable starting points</p>
          <h2 id="suggestion-title">
            Suggested starting points for {formatShortDate(household?.currentTrip.scheduledFor ?? suggestionPlanDate)}
          </h2>
          <p>Only recurring essentials start included; every other idea is optional</p>
        </div>
        <EvidenceBadge label="Rule-based suggestion" tone="suggestion" />
      </div>
      <div className="suggestion-list">
        {suggestions.map((suggestion) => {
          const matchingProduct = household?.products.find(
            (product) => product.costcoItemNumber === suggestion.itemNumber,
          );
          const alreadyListed = household?.listItems.some(
            (item) =>
              item.productId === matchingProduct?.id ||
              item.label.toLocaleLowerCase() === suggestion.name.toLocaleLowerCase(),
          );
          const key = `suggestion-${suggestion.id}`;
          return (
            <div className="suggestion-row" key={suggestion.id}>
              <div className="suggestion-copy">
                <strong>{suggestion.name}</strong>
                <p>{suggestion.reason}</p>
                <small>
                  {suggestion.confidence} confidence · last receipt price{" "}
                  {suggestion.estimatedPriceCents === null
                    ? "not available"
                    : currency.format(suggestion.estimatedPriceCents / 100)}
                </small>
              </div>
              <button
                type="button"
                className="add-button"
                onClick={() => onAdd(suggestion)}
                disabled={!household || alreadyListed || pendingWrites.has(key)}
                aria-label={
                  alreadyListed
                    ? `${suggestion.name} is already on the list`
                    : `Add ${suggestion.name} to the list`
                }
              >
                {alreadyListed
                  ? "On list"
                  : pendingWrites.has(key)
                    ? "Adding…"
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

function scopedCategories(
  viewData: DashboardViewData,
  transactions: readonly DashboardTransaction[],
) {
  const transactionIds = new Set(transactions.map((transaction) => transaction.id));
  const lines = viewData.receiptLines.filter((line) =>
    transactionIds.has(line.transactionId),
  );

  return viewData.productCategories.map((category) => {
    const channel =
      category.key === "fuel"
        ? "gas"
        : category.key === "optical_services"
          ? "optical"
          : null;
    const categoryLines = lines.filter((line) => line.categoryKey === category.key);
    const householdViewCents = channel
      ? transactions
          .filter((transaction) => transaction.channel === channel)
          .reduce((sum, transaction) => sum + transaction.householdFundedCents, 0)
      : categoryLines.reduce((sum, line) => sum + line.netAmountCents, 0);

    return {
      ...category,
      householdViewCents,
      itemCount: categoryLines.reduce((sum, line) => sum + line.quantity, 0),
      transactionCount: channel
        ? transactions.filter((transaction) => transaction.channel === channel).length
        : new Set(categoryLines.map((line) => line.transactionId)).size,
    } satisfies DashboardProductCategory;
  });
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
                <button type="button" key={line.itemNumber} onClick={() => onOpenProduct(product.id)}>{content}</button>
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
              <button type="button" key={line.id} onClick={() => onOpenProduct(product.id)}>{content}</button>
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
  onOpenTransaction,
}: {
  products: readonly DashboardProduct[];
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
  onOpenTransaction: (transactionId: string) => void;
}) {
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
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

  useEffect(() => {
    if (!detailOpen) return;
    const frame = window.requestAnimationFrame(() => detailHeading.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [detailOpen, selectedProductId]);

  function closeProductDetail() {
    setDetailOpen(false);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
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
                }}
              >
                <span className="product-initial" aria-hidden="true">
                  {product.name.charAt(0)}
                </span>
                <span className="product-main">
                  <strong>{product.name}</strong>
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
            className="back-button product-mobile-back"
            onClick={closeProductDetail}
          >
            ← Back to products
          </button>
          <div className="product-detail-top">
            <div>
              <p className="section-label">Item {selected.itemNumber}</p>
              <h2 ref={detailHeading} tabIndex={-1}>{selected.name}</h2>
              <p>{selected.categoryLabel} · receipt history through {formatShortDate(auditThrough)}</p>
            </div>
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
          </div>
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
                  <strong>
                    {point.unitPriceCents === null
                      ? currency.format(point.netAmountCents / 100)
                      : currency.format(point.unitPriceCents / 100)}
                  </strong>
                  <small>{point.quantity !== 1 ? `${point.quantity} units · ` : ""}Open receipt →</small>
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
  latestTransaction,
  currentFeedback,
  householdFeedback,
  members,
  connected,
  pending,
  failure,
  onRetry,
  onSave,
}: {
  latestTransaction: DashboardViewData["latestWarehouseTransaction"];
  currentFeedback: SharedFeedback | undefined;
  householdFeedback: SharedFeedback[];
  members: HouseholdMember[];
  connected: boolean;
  pending: boolean;
  failure: FailedWrite | undefined;
  onRetry: () => void;
  onSave: (value: string, rating: number) => void;
}) {
  const answers = householdFeedback.filter(
    (feedback) =>
      feedback.receiptTransactionId === latestTransaction.id &&
      feedback.kind === "trip_enjoyment",
  );
  const memberById = new Map(members.map((member) => [member.id, member]));
  const options = [
    { label: "Enjoyable and easy", rating: 5 },
    { label: "Enjoyable but busy", rating: 4 },
    { label: "Mostly neutral", rating: 3 },
    { label: "More stressful than usual", rating: 2 },
    { label: "Not sure yet", rating: 3 },
  ];

  return (
    <div className="page review-page">
      <section className="page-heading">
        <p className="section-label">One neutral question</p>
        <h1>Review</h1>
        <p>Receipts record the cart. You two provide the meaning, one minute at a time.</p>
      </section>

      <section className="notice-card gentle">
        <span className="notice-mark" aria-hidden="true">
          1
        </span>
        <p>
          <strong>No impulse or regret label is inferred.</strong> This first question
          records whether the Costco ritual still felt good; later questions should be
          asked only when they can change a future decision.
        </p>
      </section>

      <section className="review-flow">
        <article className="review-card card">
          <div className="review-progress">
            <span>{formatShortDate(latestTransaction.purchasedOn)} household follow-up</span>
            <span>{answers.length}/2 household answers</span>
          </div>
          <div className="review-top">
            <div>
              <p className="section-label">From audited receipt</p>
              <h2>How did this Costco trip feel?</h2>
            </div>
            <strong className="review-amount">
              {currency.format(latestTransaction.householdFundedCents / 100)}
            </strong>
          </div>
          <EvidenceBadge label="Receipt + household answer" tone="confirmed" />
          <p className="review-context">
            {latestTransaction.itemCount} items · {currency.format(latestTransaction.discountCents / 100)} in discounts · no judgment attached to the amount.
          </p>

          {currentFeedback ? (
            <div className="feedback-saved" role="status">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>Your answer is shared</strong>
                <p>{currentFeedback.value}</p>
              </div>
            </div>
          ) : (
            <div className="review-options">
              {options.map((option) => (
                <button
                  key={option.label}
                  onClick={() => onSave(option.label, option.rating)}
                  disabled={!connected || pending}
                >
                  {pending ? "Saving…" : option.label}
                </button>
              ))}
            </div>
          )}

          {!connected ? (
            <p className="form-help">Connect the shared household before answering.</p>
          ) : null}
          <InlineWriteError failure={failure} onRetry={onRetry} />
        </article>
      </section>

      {answers.length ? (
        <section className="resolved-section">
          <h2>Shared household responses</h2>
          {answers.map((answer) => (
            <div className="resolved-row" key={answer.id}>
              <span aria-hidden="true">✓</span>
              <div>
                <strong>
                  {answer.createdByMemberId
                    ? memberById.get(answer.createdByMemberId)?.displayName ?? "Household member"
                    : "Household member"}
                </strong>
                <small>{answer.value}</small>
              </div>
            </div>
          ))}
        </section>
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
          BasketSense currently stores sanitized, structured 2026 facts and the shared
          Saturday workflow. It does not store Costco credentials or the raw source files
          in the household database.
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
          <h3>Stored in the shared database</h3>
          <ul>
            <li>Sanitized receipt totals and planning trips</li>
            <li>Receipt line items and exact item numbers</li>
            <li>The unified Saturday list and freeze snapshot</li>
            <li>Household feedback with who answered</li>
          </ul>
        </div>

        <div className="next-ingestion-note">
          <strong>New weekly upload is the next ingestion step</strong>
          <p>
            Photo/PDF upload, OCR, line review, and total reconciliation are not active in
            this screen yet. Until that review gate exists, BasketSense will not claim a
            new receipt was understood automatically.
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
