"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  DataHealthProduct,
  DataHealthResponse,
  DataHealthTableCount,
} from "./api/household/types";

type ExplorerView = "receipts" | "trips" | "products" | "recommendations";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const date = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function displayDate(value: string | null) {
  return value ? date.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)) : "—";
}

function displayMoney(cents: number | null) {
  return cents === null ? "—" : money.format(cents / 100);
}

function errorMessage(body: unknown) {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error
    : "Data Health could not be loaded.";
}

function countFor(tableCounts: DataHealthTableCount[], key: DataHealthTableCount["key"]) {
  return tableCounts.find((entry) => entry.key === key)?.count ?? 0;
}

function productLabel(product: DataHealthProduct) {
  return product.category ? `${product.canonicalName} · ${product.category}` : product.canonicalName;
}

export function DataHealthExplorer() {
  const [data, setData] = useState<DataHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ExplorerView>("receipts");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/household?view=data-health", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) throw new Error(errorMessage(body));
      setData(body as DataHealthResponse);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Data Health could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/household?view=data-health", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) throw new Error(errorMessage(body));
        if (!active) return;
        setData(body as DataHealthResponse);
        setError(null);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Data Health could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const changeView = (next: ExplorerView) => {
    setView(next);
    setQuery("");
    setStatus("all");
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLowerCase();
    const includes = (value: string) => !normalized || value.toLowerCase().includes(normalized);

    if (view === "receipts") {
      return data.receipts.filter((entry) =>
        (status === "all" || entry.parseStatus === status) &&
        includes([entry.purchasedAt, entry.transactionType, entry.sourceType, entry.auditFlag, entry.id].join(" ")),
      );
    }
    if (view === "trips") {
      return data.trips.filter((entry) =>
        (status === "all" || entry.status === status) &&
        includes([entry.scheduledFor, entry.status, entry.id].join(" ")),
      );
    }
    if (view === "products") {
      return data.products.filter((entry) =>
        (status === "all" || entry.categoryStatus === status) &&
        includes([entry.canonicalName, entry.costcoItemNumber ?? "", entry.category ?? "", entry.id].join(" ")),
      );
    }
    return data.recommendationEvents.filter((entry) =>
      (status === "all" || entry.source === status) &&
      includes([entry.label, entry.source, entry.section, entry.recommendationReason ?? "", entry.scheduledFor].join(" ")),
    );
  }, [data, query, status, view]);

  const filterOptions =
    view === "receipts"
      ? ["all", "reconciled", "needs_review", "rejected"]
      : view === "trips"
        ? ["all", "planning", "frozen", "completed"]
        : view === "products"
          ? ["all", "reviewed", "rule_based", "needs_review"]
          : ["all", "recurring", "predicted", "consider"];

  if (loading && !data) {
    return (
      <section className="data-health-loading card" aria-live="polite">
        <strong>Loading the hosted household data…</strong>
        <p>This read-only view is checking the same D1 database that powers the live app.</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="data-health-loading card" role="alert">
        <strong>Data Health is unavailable.</strong>
        <p>{error}</p>
        <button className="secondary-button" type="button" onClick={() => void refresh()}>
          Try again
        </button>
      </section>
    );
  }

  if (!data) return null;

  const totalRecords = data.tableCounts.reduce((total, entry) => total + entry.count, 0);
  const reviewQueue =
    data.unmatchedReceiptLines.length +
    data.productsNeedingReview.length +
    data.openReviewQuestions.length +
    data.failedImports.length;

  return (
    <section className="data-health-page">
      <div className="page-heading with-controls">
        <div>
          <p className="section-label">Owner workspace</p>
          <h1>Data Health &amp; Explorer</h1>
          <p>
            A read-only view of the hosted household database. It is intentionally not a SQL console and has no write controls.
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh data"}
        </button>
      </div>

      <p className="data-health-source">
        Source: hosted D1 · refreshed {new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </p>

      <div className="metrics-strip four data-health-metrics">
        <article>
          <span>Structured records</span>
          <strong>{totalRecords.toLocaleString()}</strong>
          <small>{data.tableCounts.length} household tables</small>
        </article>
        <article>
          <span>Receipts reconciled</span>
          <strong>{data.reconciliation.reconciled}/{data.reconciliation.totalReceipts}</strong>
          <small>{displayMoney(data.reconciliation.unreconciledTotalCents)} awaiting reconciliation</small>
        </article>
        <article>
          <span>Unmatched receipt lines</span>
          <strong>{data.unmatchedReceiptLines.length}</strong>
          <small>Only lines without a product match</small>
        </article>
        <article>
          <span>Review queue</span>
          <strong>{reviewQueue}</strong>
          <small>Data-quality work, not household judgment</small>
        </article>
      </div>

      <div className="data-health-grid">
        <section className="card data-health-card">
          <div className="card-heading compact">
            <div>
              <p className="section-label">Record counts</p>
              <h2>What is stored</h2>
            </div>
            <span className="data-health-note">Live counts</span>
          </div>
          <dl className="record-counts">
            {data.tableCounts.map((entry) => (
              <div key={entry.key}>
                <dt>{entry.label}</dt>
                <dd>{entry.count.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card data-health-card">
          <div className="card-heading compact">
            <div>
              <p className="section-label">Receipt reconciliation</p>
              <h2>Accounting state</h2>
            </div>
          </div>
          <ul className="health-status-list">
            <li><span>Reconciled</span><strong>{data.reconciliation.reconciled}</strong></li>
            <li><span>Needs review</span><strong>{data.reconciliation.needsReview}</strong></li>
            <li><span>Rejected drafts</span><strong>{data.reconciliation.rejected}</strong></li>
            <li><span>Uploaded receipt images</span><strong>{countFor(data.tableCounts, "receiptUploads")}</strong></li>
          </ul>
          <p className="data-health-note">Exact metrics exclude unreconciled receipts; this page makes that boundary visible.</p>
        </section>
      </div>

      <section className="card data-health-card review-queues">
        <div className="card-heading">
          <div>
            <p className="section-label">Focused review queues</p>
            <h2>Only what needs a human look</h2>
            <p>These are evidence and data-quality queues. They do not label purchases as good or bad.</p>
          </div>
        </div>
        <div className="review-queue-grid">
          <Queue title="Unmatched receipt lines" count={data.unmatchedReceiptLines.length} empty="Every stored receipt line has a product match.">
            {data.unmatchedReceiptLines.slice(0, 4).map((line) => (
              <li key={line.id}>
                <strong>{line.rawDescription}</strong>
                <span>{displayDate(line.purchasedAt)} · {displayMoney(line.netAmountCents)}{line.costcoItemNumber ? ` · #${line.costcoItemNumber}` : ""}</span>
              </li>
            ))}
          </Queue>
          <Queue title="Products needing category review" count={data.productsNeedingReview.length} empty="All products have a reviewed or rule-based category.">
            {data.productsNeedingReview.slice(0, 4).map((product) => (
              <li key={product.id}>
                <strong>{product.canonicalName}</strong>
                <span>{product.receiptLineCount} receipt lines · {product.category ?? "No category"}</span>
              </li>
            ))}
          </Queue>
          <Queue title="Open review questions" count={data.openReviewQuestions.length} empty="No evidence-triggered questions are waiting.">
            {data.openReviewQuestions.slice(0, 4).map((question) => (
              <li key={question.id}>
                <strong>{question.prompt}</strong>
                <span>{question.purpose.replaceAll("_", " ")} · {displayDate(question.purchasedAt)}</span>
              </li>
            ))}
          </Queue>
          <Queue title="Rejected receipt drafts" count={data.failedImports.length} empty="No rejected receipt drafts are recorded.">
            {data.failedImports.slice(0, 4).map((entry) => (
              <li key={entry.id}>
                <strong>{displayDate(entry.purchasedAt)} receipt</strong>
                <span>{entry.sourceType.replaceAll("_", " ")} · {displayMoney(entry.totalCents)}</span>
              </li>
            ))}
          </Queue>
        </div>
        <p className="data-health-note">{data.importTracking.message}</p>
      </section>

      <section className="card data-health-card data-export-card">
        <div>
          <p className="section-label">Ownership &amp; export</p>
          <h2>Take your household data with you</h2>
          <p>JSON includes all household-scoped structured records. The receipts CSV is a portable receipt ledger. Receipt images and R2 storage keys stay private and are excluded.</p>
        </div>
        <div className="data-export-actions">
          <a className="secondary-button" href="/api/household?view=export&amp;format=json">
            Download household JSON
          </a>
          <a className="secondary-button" href="/api/household?view=export&amp;format=csv">
            Download receipts CSV
          </a>
        </div>
      </section>

      <section className="card data-health-card data-explorer-card">
        <div className="card-heading">
          <div>
            <p className="section-label">Explorer</p>
            <h2>Browse household records</h2>
            <p>Filter safe, owner-authorized views. Results are capped to keep this utility fast and intentionally narrow.</p>
          </div>
          <span className="data-health-note">{filtered.length} matching</span>
        </div>
        <div className="data-explorer-controls">
          <label className="select-label">
            <span>View</span>
            <select value={view} onChange={(event) => changeView(event.target.value as ExplorerView)}>
              <option value="receipts">Receipts</option>
              <option value="trips">Trips</option>
              <option value="products">Products</option>
              <option value="recommendations">Recommendation events</option>
            </select>
          </label>
          <label className="select-label">
            <span>State</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {filterOptions.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label className="search-field">
            <span className="sr-only">Search this view</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${view}`} />
          </label>
        </div>
        <ExplorerTable view={view} rows={filtered} />
      </section>
    </section>
  );
}

function Queue({ title, count, empty, children }: { title: string; count: number; empty: ReactNode }) {
  return (
    <section className="review-queue">
      <div><h3>{title}</h3><strong>{count}</strong></div>
      {count ? <ul>{children}</ul> : <p>{empty}</p>}
    </section>
  );
}

function ExplorerTable({ view, rows }: { view: ExplorerView; rows: unknown[] }) {
  if (!rows.length) return <div className="empty-state"><strong>No matching records</strong><p>Try a different state or search term.</p></div>;
  if (view === "receipts") {
    return <div className="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Total</th><th>Parse state</th><th>Unmatched</th></tr></thead><tbody>{(rows as DataHealthResponse["receipts"]).map((row) => <tr key={row.id}><td>{displayDate(row.purchasedAt)}<small>{row.sourceType.replaceAll("_", " ")}</small></td><td>{row.transactionType}</td><td>{displayMoney(row.totalCents)}</td><td>{row.parseStatus.replaceAll("_", " ")}</td><td>{row.unmatchedLineCount}</td></tr>)}</tbody></table></div>;
  }
  if (view === "trips") {
    return <div className="table-scroll"><table><thead><tr><th>Saturday</th><th>State</th><th>List items</th><th>Receipts</th><th>Estimate</th></tr></thead><tbody>{(rows as DataHealthResponse["trips"]).map((row) => <tr key={row.id}><td>{displayDate(row.scheduledFor)}</td><td>{row.status}</td><td>{row.listItemCount}</td><td>{row.receiptCount}</td><td>{displayMoney(row.estimatedListTotalAtFreezeCents)}</td></tr>)}</tbody></table></div>;
  }
  if (view === "products") {
    return <div className="table-scroll"><table><thead><tr><th>Product</th><th>Category state</th><th>Item no.</th><th>Receipt lines</th><th>Active</th></tr></thead><tbody>{(rows as DataHealthResponse["products"]).map((row) => <tr key={row.id}><td>{productLabel(row)}</td><td>{row.categoryStatus.replaceAll("_", " ")}</td><td>{row.costcoItemNumber ?? "—"}</td><td>{row.receiptLineCount}</td><td>{row.active ? "Yes" : "No"}</td></tr>)}</tbody></table></div>;
  }
  return <div className="table-scroll"><table><thead><tr><th>Product / list item</th><th>Trip</th><th>Source</th><th>Confidence</th><th>On list</th></tr></thead><tbody>{(rows as DataHealthResponse["recommendationEvents"]).map((row) => <tr key={row.id}><td>{row.label}<small>{row.recommendationReason ?? "No explanation stored"}</small></td><td>{displayDate(row.scheduledFor)}<small>{row.tripStatus}</small></td><td>{row.source}</td><td>{row.confidenceBps === null ? "—" : `${Math.round(row.confidenceBps / 100)}%`}</td><td>{row.included ? "Included" : "Idea"}</td></tr>)}</tbody></table></div>;
}
