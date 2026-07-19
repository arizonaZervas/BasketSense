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
  DashboardSuggestion,
  DashboardViewData,
} from "./dashboard-types";

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
  { id: "week", label: "Saturday", symbol: "✓" },
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
  if (source === "predicted") return "Receipt-rhythm suggestion";
  if (source === "consider") return "Consider item";
  return "Added in store";
}

function listSection(item: SharedListItem, status: TripStatus) {
  if (
    status === "frozen" &&
    (item.addedAfterFreeze || (item.includedAtFreeze === false && item.included))
  ) {
    return "Added in store";
  }
  if (item.section === "essentials") return "Essentials";
  if (item.section === "suggested") return "Suggested";
  if (item.section === "check_first") return "Check first";
  return "Consider";
}

function freezeEvidence(item: SharedListItem, status: TripStatus) {
  if (status !== "frozen") return null;
  if (item.addedAfterFreeze || (item.includedAtFreeze === false && item.included)) {
    return "Added after the planned list was frozen";
  }
  if (item.includedAtFreeze) return "Included when planning intent was saved";
  return "Not included when planning intent was saved";
}

function cadenceConfidence(confidenceBps: number | null) {
  if (confidenceBps === null) return null;
  if (confidenceBps >= 8000) return "High cadence confidence";
  if (confidenceBps >= 6000) return "Medium cadence confidence";
  return "Check-first signal";
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
  const [selectedProductId, setSelectedProductId] = useState(
    viewData.products[0]?.id ?? "",
  );
  const [isDataDialogOpen, setIsDataDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const toastTimer = useRef<number | null>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);

  const refreshHousehold = useCallback(async (quiet = false) => {
    if (refreshPromise.current) return refreshPromise.current;

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
      await refreshHousehold(true);
      flash(request.successMessage);
      return true;
    } catch (error) {
      const failure = {
        message:
          error instanceof Error ? error.message : "That change was not saved.",
        request,
      };
      setFailedWrites((current) => ({ ...current, [key]: failure }));
      await refreshHousehold(true);
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
          ? `${label} added in store`
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
      successMessage: "Planned list saved for comparison after the trip",
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
              38 receipt transactions audited · Jan 2–Jul 18, 2026
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
          <OverviewTab viewData={viewData} changeTab={changeTab} />
        ) : null}

        {activeTab === "products" ? (
          <ProductsTab
            products={viewData.products}
            search={productSearch}
            setSearch={setProductSearch}
            selectedProductId={selectedProductId}
            setSelectedProductId={setSelectedProductId}
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
  const estimatedCents = included.reduce(
    (sum, item) => sum + (item.estimatedPriceCents ?? 0),
    0,
  );
  const sections = [
    "Essentials",
    "Suggested",
    "Check first",
    "Consider",
    "Added in store",
  ];
  const memberById = new Map(
    household?.members.map((member) => [member.id, member]) ?? [],
  );
  const itemsBySection = new Map(
    sections.map((section) => [
      section,
      items.filter((item) => listSection(item, trip?.status ?? "planning") === section),
    ]),
  );
  const frozen = trip?.status === "frozen";

  const syncTitle =
    syncStatus === "connecting"
      ? "Connecting the household list"
      : syncStatus === "offline"
        ? "Shared list is temporarily unavailable"
        : frozen
          ? "Planning intent saved"
          : "Live shared household list";
  const syncCopy =
    syncStatus === "offline"
      ? `${syncError ?? "Try again shortly."} Nothing is stored only on this device.`
      : syncStatus === "connecting"
        ? "Loading the one list shared by both household members."
        : frozen
          ? `The pre-trip list is preserved${trip?.frozenAt ? ` from ${new Date(trip.frozenAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Later additions are labeled separately.`
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
              : "Jul 25, 2026 · both spouses edit one list"}
          </p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={onCopy}>
            Copy list
          </button>
          {!frozen ? (
            <button
              className="primary-button"
              onClick={onFreeze}
              disabled={!household || !included.length || pendingWrites.has("freeze-trip")}
            >
              {pendingWrites.has("freeze-trip") ? "Saving…" : "Save planned list"}
            </button>
          ) : (
            <span className="frozen-pill">Intent saved</span>
          )}
        </div>
      </section>

      <section
        className={`device-notice ${syncStatus === "offline" ? "warning" : ""}`}
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
          placeholder={frozen ? "Add something found in store…" : "Add milk, fruit, diapers…"}
          disabled={!household || pendingWrites.has("quick-add")}
        />
        <button
          className="primary-button"
          type="submit"
          disabled={!household || !newItem.trim() || pendingWrites.has("quick-add")}
        >
          {pendingWrites.has("quick-add") ? "Adding…" : frozen ? "Add in store" : "Add item"}
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
        <div>
          <span>Known-price estimate</span>
          <strong>{currency.format(estimatedCents / 100)}</strong>
          <small>Only items with a receipt price</small>
        </div>
        <div>
          <span>List status</span>
          <strong>{frozen ? "Frozen" : "Planning"}</strong>
          <small>{frozen ? "Later changes stay visible" : "Save before entering Costco"}</small>
        </div>
      </section>

      <div className="week-layout">
        <div className="weekly-list-stack">
          <section className="list-card card" aria-label="Shared Saturday list">
            {!household && syncStatus !== "offline" ? (
              <ListSkeleton />
            ) : items.length ? (
              sections.map((section) => {
                const sectionItems = itemsBySection.get(section) ?? [];
                if (!sectionItems.length) return null;
                return (
                  <div className="list-section" key={section}>
                    <div className="list-section-heading">
                      <div>
                        <h2>{section}</h2>
                        <p>
                          {section === "Added in store"
                            ? "Kept separate from the frozen pre-trip intent"
                            : section === "Suggested"
                              ? "Accepted from explainable receipt rhythms"
                              : section === "Check first"
                                ? "A pantry or fridge check should decide"
                              : section === "Consider"
                                ? "Optional ideas the household chose to keep"
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
                                <p>{item.recommendationReason ?? sourceLabel(item.source)}</p>
                                <small>
                                  {[
                                    cadenceConfidence(item.confidenceBps),
                                    freezeEvidence(item, trip?.status ?? "planning"),
                                    addedBy ? `Added by ${addedBy}` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ") || sourceLabel(item.source)}
                                </small>
                              </div>
                              <div className="list-row-actions">
                                <span className="estimated-price">
                                  {item.estimatedPriceCents === null
                                    ? "No estimate"
                                    : `~${currency.format(item.estimatedPriceCents / 100)}`}
                                </span>
                                <button
                                  type="button"
                                  className={item.included ? "text-button" : "add-button"}
                                  onClick={() => onToggleIncluded(item)}
                                  disabled={pending}
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
              })
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
  household,
  pendingWrites,
  failedWrites,
  onRetry,
  onAdd,
}: {
  suggestions: readonly DashboardSuggestion[];
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
          <h2 id="suggestion-title">Likely due for Jul 25</h2>
          <p>Receipt rhythm only · each item stays optional until you add it</p>
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
                  {currency.format(suggestion.estimatedPriceCents / 100)}
                </small>
              </div>
              <button
                type="button"
                className="add-button"
                onClick={() => onAdd(suggestion)}
                disabled={!household || alreadyListed || pendingWrites.has(key)}
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

function OverviewTab({
  viewData,
  changeTab,
}: {
  viewData: DashboardViewData;
  changeTab: (tab: Tab) => void;
}) {
  const optical = viewData.channels.find((channel) => channel.key === "optical");
  return (
    <div className="page page-overview">
      <section className="page-heading">
        <p className="section-label">Audited household history</p>
        <h1>Insights</h1>
        <p>
          Exact household-funded totals through {formatFullDate(viewData.audit.through)}.
          Planning comparisons begin only after a list is frozen.
        </p>
      </section>

      <section className="notice-card gentle">
        <span className="notice-mark" aria-hidden="true">
          ✓
        </span>
        <p>
          <strong>{viewData.audit.reconciliationIssueCount === 0 ? "All 38 receipt transactions reconcile." : "The audit still has open reconciliation work."}</strong>{" "}
          Historical receipts can show purchase cadence, but cannot prove what was
          planned, necessary, used, wasted, or regretted.
        </p>
      </section>

      <section className="metrics-strip four" aria-label="2026 Costco summary">
        <article>
          <span>Household-funded</span>
          <strong>{currency.format(viewData.audit.householdFundedCents / 100)}</strong>
          <small>Jan 2–Jul 18, 2026</small>
        </article>
        <article>
          <span>Gross receipt value</span>
          <strong>{currency.format(viewData.audit.grossReceiptTotalCents / 100)}</strong>
          <small>Includes optical insurance benefits</small>
        </article>
        <article>
          <span>Receipt transactions</span>
          <strong>{viewData.audit.transactionCount}</strong>
          <small>{viewData.audit.warehouseTransactionCount} warehouse shops</small>
        </article>
        <article>
          <span>Average warehouse shop</span>
          <strong>{currency.format(viewData.audit.averageWarehouseCents / 100)}</strong>
          <small>Household-funded warehouse total ÷ 29</small>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="card spend-card">
          <div className="card-heading">
            <div>
              <p className="section-label">Spending by month</p>
              <h2>Household-funded Costco spend</h2>
              <p>Audited 2026 only · no incomplete prior-year comparison</p>
            </div>
          </div>
          <MonthlyBarChart data={viewData.months} />
        </article>

        <article className="card category-card">
          <div className="card-heading">
            <div>
              <p className="section-label">Reliable channel split</p>
              <h2>Where the money went</h2>
              <p>Product categories follow after normalization review</p>
            </div>
          </div>
          <ChannelBars
            channels={viewData.channels}
            totalCents={viewData.audit.householdFundedCents}
          />
          {optical ? (
            <p className="channel-footnote">
              Optical shows {currency.format(optical.householdFundedCents / 100)}
              out-of-pocket. Its gross receipt value was{" "}
              {currency.format(optical.grossReceiptTotalCents / 100)}; the rest was
              insurance-funded.
            </p>
          ) : null}
        </article>
      </section>

      <section className="learning-section">
        <div className="card-heading">
          <div>
            <p className="section-label">What becomes useful next</p>
            <h2>Behavioral insight starts with intent</h2>
          </div>
          <EvidenceBadge label="Truth boundary" tone="unknown" />
        </div>
        <div className="learning-grid">
          <button className="insight-card" onClick={() => changeTab("week")}>
            <span className="insight-icon sage">1</span>
            <span className="insight-copy">
              <strong>Freeze the Jul 25 plan</strong>
              <p>That creates the first defensible planned-versus-added comparison.</p>
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
            <span className="insight-icon lilac">12</span>
            <span className="insight-copy">
              <strong>Use exact repeat-product history</strong>
              <p>See real item-number cadence and price history without guessing use.</p>
            </span>
            <span className="insight-link">View products</span>
          </button>
        </div>
      </section>

      <section className="card trip-table-card">
        <div className="card-heading">
          <div>
            <p className="section-label">Latest audited activity</p>
            <h2>Receipt transactions</h2>
            <p>Warehouse and gas can be separate transactions on the same day.</p>
          </div>
        </div>
        <div className="table-scroll">
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
              {viewData.recentTransactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{formatShortDate(transaction.purchasedOn)}</td>
                  <td>{transaction.channel === "gas" ? "Gas" : "Warehouse"}</td>
                  <td>{transaction.itemCount}</td>
                  <td>{currency.format(transaction.discountCents / 100)}</td>
                  <td>{currency.format(transaction.householdFundedCents / 100)}</td>
                  <td>{currency.format(transaction.receiptTotalCents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MonthlyBarChart({ data }: { data: DashboardViewData["months"] }) {
  const max = Math.max(...data.map((month) => month.householdFundedCents));
  const total = data.reduce((sum, month) => sum + month.householdFundedCents, 0);
  const transactions = data.reduce((sum, month) => sum + month.transactionCount, 0);
  return (
    <div className="bar-chart">
      <div className="chart-legend">
        <span>
          <i className="legend-current" /> Household-funded 2026
        </span>
      </div>
      <div
        className="bars"
        style={{ gridTemplateColumns: `repeat(${data.length}, minmax(44px, 1fr))` }}
        role="img"
        aria-label={`Monthly household-funded Costco spending from January through July 18, totaling ${currency.format(total / 100)}`}
      >
        {data.map((month) => (
          <div
            className="bar-group"
            key={month.key}
            tabIndex={0}
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
          </div>
        ))}
      </div>
      <p className="chart-summary">
        {currency.format(total / 100)} household-funded across {transactions}{" "}
        receipt transactions. July is partial through Jul 18.
      </p>
    </div>
  );
}

function ChannelBars({
  channels,
  totalCents,
}: {
  channels: DashboardViewData["channels"];
  totalCents: number;
}) {
  const max = Math.max(...channels.map((channel) => channel.householdFundedCents));
  return (
    <div className="category-bars">
      {channels.map((channel) => {
        const share = Math.round((channel.householdFundedCents / totalCents) * 100);
        return (
          <div className="category-bar-row" key={channel.key}>
            <div className="category-label">
              <span>{channel.label}</span>
              <strong>{currency.format(channel.householdFundedCents / 100)}</strong>
            </div>
            <div
              className="category-track"
              aria-label={`${channel.label}: ${currency.format(channel.householdFundedCents / 100)}, ${share}% of household-funded spend`}
            >
              <span
                style={{
                  width: `${(channel.householdFundedCents / max) * 100}%`,
                  background: channel.color,
                }}
              />
            </div>
            <small>
              {channel.transactionCount} transactions · {share}% of household-funded spend
            </small>
          </div>
        );
      })}
    </div>
  );
}

function ProductsTab({
  products,
  search,
  setSearch,
  selectedProductId,
  setSelectedProductId,
}: {
  products: readonly DashboardProduct[];
  search: string;
  setSearch: (value: string) => void;
  selectedProductId: string;
  setSelectedProductId: (value: string) => void;
}) {
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return products;
    return products.filter((product) =>
      [product.name, product.rawDescription, product.itemNumber].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [products, search]);
  const selected =
    products.find((product) => product.id === selectedProductId) ?? products[0];

  if (!selected) return null;

  return (
    <div className="page products-page">
      <section className="page-heading with-controls product-heading">
        <div>
          <p className="section-label">Exact receipt item numbers</p>
          <h1>Products</h1>
          <p>Purchase cadence and package price—not inferred household consumption.</p>
        </div>
        <label className="search-field">
          <span className="sr-only">Search products</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search repeat products…"
          />
        </label>
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

      <section className="product-layout">
        <div className="product-list card" aria-label="Repeat product results">
          <div className="product-list-header">
            <span>{filteredProducts.length} repeat products</span>
            <span>Most frequent first</span>
          </div>
          {filteredProducts.map((product) => {
            const priceDelta = product.lastPriceCents - product.previousPriceCents;
            return (
              <button
                key={product.id}
                className={`product-row ${selected.id === product.id ? "active" : ""}`}
                onClick={() => setSelectedProductId(product.id)}
              >
                <span className="product-initial" aria-hidden="true">
                  {product.name.charAt(0)}
                </span>
                <span className="product-main">
                  <strong>{product.name}</strong>
                  <small>
                    {formatShortDate(product.lastPurchasedOn)} · {product.purchaseCount}{" "}
                    purchases
                  </small>
                </span>
                <span className="product-meta">
                  <strong>{currency.format(product.lastPriceCents / 100)}</strong>
                  <small className={priceDelta > 0 ? "delta-up" : priceDelta < 0 ? "delta-down" : ""}>
                    {priceDelta === 0
                      ? "No latest change"
                      : `${priceDelta > 0 ? "+" : ""}${currency.format(priceDelta / 100)}`}
                  </small>
                </span>
              </button>
            );
          })}
          {!filteredProducts.length ? (
            <div className="empty-state">
              <strong>No matching repeat product</strong>
              <p>Try a shorter product name or an item number.</p>
            </div>
          ) : null}
        </div>

        <article className="product-detail card">
          <div className="product-detail-top">
            <div>
              <p className="section-label">Item {selected.itemNumber}</p>
              <h2>{selected.name}</h2>
              <p>Receipt-derived repeat history through Jul 18</p>
            </div>
            <EvidenceBadge label="Exact item number" tone="receipt" />
          </div>
          <div className="detail-metrics">
            <div>
              <span>Median purchase interval</span>
              <strong>{selected.medianIntervalDays} days</strong>
            </div>
            <div>
              <span>Latest package price</span>
              <strong>{currency.format(selected.lastPriceCents / 100)}</strong>
            </div>
            <div>
              <span>Recorded net spend</span>
              <strong>{currency.format(selected.totalSpendCents / 100)}</strong>
            </div>
          </div>
          <div className="evidence-row">
            <EvidenceBadge label="From receipts" tone="receipt" />
            <span>
              {selected.purchaseCount} matching transactions since{" "}
              {formatShortDate(selected.firstPurchasedOn)}
            </span>
          </div>

          <div className="history-section">
            <div className="section-heading">
              <h3>Latest exact-product prices</h3>
              <span>Package prices</span>
            </div>
            <div className="price-history">
              {selected.priceHistory.map((point) => (
                <div className="price-point" key={`${point.purchasedOn}-${point.unitPriceCents}`}>
                  <span>{formatShortDate(point.purchasedOn)}</span>
                  <strong>{currency.format(point.unitPriceCents / 100)}</strong>
                </div>
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
              The interval describes purchases, not when the package ran out. Pantry
              checks and household feedback must supply that missing context.
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
            <span>Jul 18 household follow-up</span>
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
