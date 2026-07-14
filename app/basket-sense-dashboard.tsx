"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";

type Tab = "overview" | "spending" | "products" | "week" | "review";
type Period = "Month" | "Quarter" | "Year";
type ReviewStatus = "open" | "resolved";

type Product = {
  id: string;
  name: string;
  rawName: string;
  category: string;
  brand: string;
  itemNumber: string;
  purchases: number;
  totalSpend: number;
  lastPrice: number;
  previousPrice: number;
  interval: string;
  lastPurchased: string;
  householdLabel: string;
  match: string;
  history: { date: string; price: number; note?: string }[];
};

type ListItem = {
  id: string;
  name: string;
  section: "Essentials" | "Suggested" | "Check first" | "Consider";
  reason: string;
  source: string;
  included: boolean;
  checked: boolean;
  price: number;
};

type ReviewItem = {
  id: string;
  eyebrow: string;
  title: string;
  context: string;
  amount?: number;
  badge: "From receipt" | "System suggestion" | "Not enough information";
  options: string[];
  status: ReviewStatus;
  answer?: string;
};

const tabs: { id: Tab; label: string; short: string }[] = [
  { id: "overview", label: "Overview", short: "O" },
  { id: "spending", label: "Spending", short: "$" },
  { id: "products", label: "Products", short: "P" },
  { id: "week", label: "This Week", short: "W" },
  { id: "review", label: "Review", short: "R" },
];

const monthlySpend = [
  { month: "Jan", current: 1080, previous: 948, trips: 4 },
  { month: "Feb", current: 1110, previous: 1028, trips: 4 },
  { month: "Mar", current: 1220, previous: 1015, trips: 5 },
  { month: "Apr", current: 1160, previous: 1080, trips: 4 },
  { month: "May", current: 1350, previous: 1180, trips: 5 },
  { month: "Jun", current: 1320, previous: 1125, trips: 5 },
  { month: "Jul", current: 1180, previous: 1142, trips: 4 },
];

const categories = [
  { name: "Groceries", amount: 3240, share: 38, color: "var(--sage)" },
  { name: "Household", amount: 1870, share: 22, color: "var(--apricot)" },
  { name: "Prepared food", amount: 1120, share: 13, color: "var(--lilac)" },
  { name: "Personal care", amount: 760, share: 9, color: "var(--sky)" },
  { name: "Other", amount: 1430, share: 17, color: "var(--sand)" },
];

const products: Product[] = [
  {
    id: "milk",
    name: "Organic whole milk",
    rawName: "ORG WHOLE MILK 3PK",
    category: "Dairy",
    brand: "Kirkland Signature",
    itemNumber: "1329509",
    purchases: 24,
    totalSpend: 347.76,
    lastPrice: 14.49,
    previousPrice: 13.99,
    interval: "7–9 days",
    lastPurchased: "Jul 5",
    householdLabel: "Essential",
    match: "Exact item-number match",
    history: [
      { date: "May 24", price: 13.99 },
      { date: "Jun 1", price: 13.99 },
      { date: "Jun 15", price: 14.49, note: "Package price changed" },
      { date: "Jun 28", price: 14.49 },
      { date: "Jul 5", price: 14.49 },
    ],
  },
  {
    id: "berries",
    name: "Organic blueberries",
    rawName: "ORG BLUEBERRIES 18OZ",
    category: "Fresh food",
    brand: "Various",
    itemNumber: "57554",
    purchases: 15,
    totalSpend: 134.85,
    lastPrice: 8.99,
    previousPrice: 7.99,
    interval: "12–16 days",
    lastPurchased: "Jun 28",
    householdLabel: "Check freshness",
    match: "Exact item-number match",
    history: [
      { date: "Apr 19", price: 7.99 },
      { date: "May 3", price: 8.49 },
      { date: "May 24", price: 8.99 },
      { date: "Jun 14", price: 8.99 },
      { date: "Jun 28", price: 8.99, note: "Some went unused" },
    ],
  },
  {
    id: "paper",
    name: "Bath tissue",
    rawName: "KS BATH TISSUE 30RL",
    category: "Household",
    brand: "Kirkland Signature",
    itemNumber: "585578",
    purchases: 7,
    totalSpend: 160.93,
    lastPrice: 22.99,
    previousPrice: 22.99,
    interval: "35–50 days",
    lastPurchased: "May 30",
    householdLabel: "Check supply",
    match: "Exact item-number match",
    history: [
      { date: "Jan 18", price: 22.99 },
      { date: "Mar 1", price: 22.99 },
      { date: "Apr 12", price: 22.99 },
      { date: "May 30", price: 22.99, note: "Already-have check helped" },
    ],
  },
  {
    id: "eggs",
    name: "Organic eggs",
    rawName: "ORG EGGS 24CT",
    category: "Dairy",
    brand: "Kirkland Signature",
    itemNumber: "1068080",
    purchases: 18,
    totalSpend: 161.82,
    lastPrice: 8.99,
    previousPrice: 9.49,
    interval: "10–13 days",
    lastPurchased: "Jul 1",
    householdLabel: "Essential",
    match: "Exact item-number match",
    history: [
      { date: "May 17", price: 9.49 },
      { date: "May 31", price: 9.49 },
      { date: "Jun 14", price: 8.99 },
      { date: "Jul 1", price: 8.99 },
    ],
  },
  {
    id: "dumplings",
    name: "Chicken soup dumplings",
    rawName: "CHKN SOUP DUMPLINGS",
    category: "Frozen & prepared",
    brand: "Bibigo",
    itemNumber: "1657832",
    purchases: 4,
    totalSpend: 55.96,
    lastPrice: 13.99,
    previousPrice: 13.99,
    interval: "21–32 days",
    lastPurchased: "Jun 21",
    householdLabel: "Good discovery",
    match: "Household-confirmed same product",
    history: [
      { date: "Mar 15", price: 13.99, note: "First try" },
      { date: "Apr 12", price: 13.99 },
      { date: "May 10", price: 13.99 },
      { date: "Jun 21", price: 13.99, note: "Would buy again" },
    ],
  },
  {
    id: "olive-oil",
    name: "Extra virgin olive oil",
    rawName: "KS EVOO 2L",
    category: "Pantry",
    brand: "Kirkland Signature",
    itemNumber: "1716202",
    purchases: 3,
    totalSpend: 89.97,
    lastPrice: 29.99,
    previousPrice: 27.99,
    interval: "70–110 days",
    lastPurchased: "May 3",
    householdLabel: "Occasional",
    match: "Package size confirmed",
    history: [
      { date: "Nov 16", price: 27.99 },
      { date: "Feb 8", price: 31.99 },
      { date: "May 3", price: 29.99 },
    ],
  },
  {
    id: "snack",
    name: "Snack assortment",
    rawName: "KS SNACK MIX 36CT",
    category: "Snacks",
    brand: "Kirkland Signature",
    itemNumber: "1782210",
    purchases: 1,
    totalSpend: 18.99,
    lastPrice: 18.99,
    previousPrice: 18.99,
    interval: "Not enough history",
    lastPurchased: "Jun 28",
    householdLabel: "Not for us",
    match: "Household-confirmed same product",
    history: [{ date: "Jun 28", price: 18.99, note: "Not worth repeating" }],
  },
  {
    id: "chocolate",
    name: "Holiday chocolate box",
    rawName: "HOLIDAY CHOC 48PC",
    category: "Seasonal",
    brand: "Various",
    itemNumber: "1745501",
    purchases: 2,
    totalSpend: 49.98,
    lastPrice: 24.99,
    previousPrice: 24.99,
    interval: "Seasonal",
    lastPurchased: "Dec 14",
    householdLabel: "Seasonal",
    match: "Exact item-number match",
    history: [
      { date: "Dec 16, 2024", price: 24.99 },
      { date: "Dec 14, 2025", price: 24.99 },
    ],
  },
];

const initialList: ListItem[] = [
  {
    id: "l1",
    name: "Organic whole milk",
    section: "Essentials",
    reason: "Usually every 7–9 days · last bought 8 days ago",
    source: "Suggested from 24 purchases",
    included: true,
    checked: false,
    price: 14.49,
  },
  {
    id: "l2",
    name: "Bananas",
    section: "Essentials",
    reason: "Added by SH · today at 8:14 AM",
    source: "Household addition",
    included: true,
    checked: false,
    price: 2.49,
  },
  {
    id: "l3",
    name: "Organic eggs",
    section: "Essentials",
    reason: "Usually every 10–13 days · last bought 12 days ago",
    source: "Suggested from 18 purchases",
    included: true,
    checked: false,
    price: 8.99,
  },
  {
    id: "l4",
    name: "Organic blueberries",
    section: "Suggested",
    reason: "Usually every 12–16 days · last bought 15 days ago",
    source: "Medium confidence",
    included: false,
    checked: false,
    price: 8.99,
  },
  {
    id: "l5",
    name: "Organic chicken thighs",
    section: "Suggested",
    reason: "Bought on 5 of the last 8 trips",
    source: "Medium confidence",
    included: false,
    checked: false,
    price: 22.4,
  },
  {
    id: "l6",
    name: "Bath tissue",
    section: "Check first",
    reason: "Last bought 44 days ago · your timing varies",
    source: "Check supply",
    included: false,
    checked: false,
    price: 22.99,
  },
  {
    id: "l7",
    name: "Chicken soup dumplings",
    section: "Consider",
    reason: "A discovery you both marked ‘would buy again’",
    source: "Household favorite",
    included: false,
    checked: false,
    price: 13.99,
  },
];

const initialReviewItems: ReviewItem[] = [
  {
    id: "r1",
    eyebrow: "New · Jun 28 receipt",
    title: "Snack assortment",
    context: "This item was new and wasn’t on the available list. How should we remember it?",
    amount: 18.99,
    badge: "From receipt",
    options: [
      "Needed but forgot",
      "Good discovery",
      "Stock-up",
      "Special occasion",
      "Still deciding",
      "Probably unnecessary",
    ],
    status: "open",
  },
  {
    id: "r2",
    eyebrow: "Purchased sooner than usual",
    title: "Bath tissue",
    context: "Bought 26 days after the prior purchase; your usual range is 35–50 days. Did you still have enough?",
    amount: 22.99,
    badge: "System suggestion",
    options: ["No, we needed it", "Some left", "Plenty left", "Not sure"],
    status: "open",
  },
  {
    id: "r3",
    eyebrow: "Follow-up · bought 3 weeks ago",
    title: "Chicken soup dumplings",
    context: "How did this discovery work out for your household?",
    amount: 13.99,
    badge: "From receipt",
    options: ["Would buy again", "Maybe", "Not for us"],
    status: "open",
  },
  {
    id: "r4",
    eyebrow: "Receipt match",
    title: "KKSNACK MIX 36CT",
    context: "The receipt name is abbreviated. Is this the Snack assortment already in Products?",
    amount: 18.99,
    badge: "Not enough information",
    options: ["Yes, same product", "Create new product", "Review later"],
    status: "open",
  },
];

const recentTrips = [
  { date: "Jul 5", warehouse: "Fremont", items: 17, gross: 249.18, discounts: 12, returns: 0, total: 263.42, type: "Regular" },
  { date: "Jun 28", warehouse: "Fremont", items: 22, gross: 284.62, discounts: 18, returns: 0, total: 289.17, type: "Regular" },
  { date: "Jun 21", warehouse: "Fremont", items: 15, gross: 221.48, discounts: 9, returns: 0, total: 231.55, type: "Regular" },
  { date: "Jun 14", warehouse: "Newark", items: 31, gross: 403.72, discounts: 27, returns: 46.99, total: 356.81, type: "Exceptional" },
];

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const preciseMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function EvidenceBadge({ label }: { label: ReviewItem["badge"] | "Household confirmed" }) {
  const className = label === "From receipt" ? "receipt" : label === "Household confirmed" ? "confirmed" : label === "System suggestion" ? "suggestion" : "unknown";
  return <span className={`evidence-badge ${className}`}>{label}</span>;
}

export function BasketSenseDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState<Period>("Year");
  const [categoryFilter, setCategoryFilter] = useState("All categories");
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("milk");
  const [listItems, setListItems] = useState(initialList);
  const [reviewItems, setReviewItems] = useState(initialReviewItems);
  const [newItem, setNewItem] = useState("");
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [dataLabel, setDataLabel] = useState("Sample household · 100 receipts");
  const [toast, setToast] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({
    dumplings: "Easy lunch; our child liked them too.",
  });

  const openReviewCount = reviewItems.filter((item) => item.status === "open").length;
  const includedItems = listItems.filter((item) => item.included);
  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? products[0];
  const filteredProducts = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    return products.filter((product) => {
      const matchesQuery = !query || [product.name, product.rawName, product.category, product.brand].some((value) => value.toLowerCase().includes(query));
      const matchesCategory = categoryFilter === "All categories" || product.category === categoryFilter;
      return matchesQuery && matchesCategory;
    });
  }, [productSearch, categoryFilter]);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleIncluded(id: string) {
    setListItems((items) => items.map((item) => item.id === id ? { ...item, included: !item.included, checked: false } : item));
    flash("List updated and saved automatically");
  }

  function toggleChecked(id: string) {
    setListItems((items) => items.map((item) => item.id === id ? { ...item, checked: !item.checked } : item));
  }

  function addManualItem(event: FormEvent) {
    event.preventDefault();
    const value = newItem.trim();
    if (!value) return;
    setListItems((items) => [
      ...items,
      {
        id: `manual-${Date.now()}`,
        name: value,
        section: "Essentials",
        reason: "Added by HH · just now",
        source: "Household addition",
        included: true,
        checked: false,
        price: 0,
      },
    ]);
    setNewItem("");
    flash(`${value} added to this week`);
  }

  function resolveReview(id: string, answer: string) {
    setReviewItems((items) => items.map((item) => item.id === id ? { ...item, status: "resolved", answer } : item));
    flash("Saved — future suggestions will use that context");
  }

  async function copyList() {
    const text = includedItems.map((item) => `${item.checked ? "✓" : "○"} ${item.name}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      flash("List copied");
    } catch {
      flash("Copy wasn’t available on this device");
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setImportStatus(`Checking ${files.length} ${files.length === 1 ? "file" : "files"}…`);

    const structuredFiles = files.filter((file) => file.name.toLowerCase().endsWith(".json") || file.name.toLowerCase().endsWith(".csv"));
    if (!structuredFiles.length) {
      setImportStatus("Receipt files staged. Photo/PDF reading will be connected after a representative receipt sample is reviewed.");
      return;
    }

    try {
      let rows = 0;
      for (const file of structuredFiles) {
        const content = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          const parsed = JSON.parse(content) as unknown;
          if (Array.isArray(parsed)) rows += parsed.length;
          else if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            const candidate = record.receipts ?? record.transactions ?? record.lines;
            rows += Array.isArray(candidate) ? candidate.length : 1;
          }
        } else {
          rows += Math.max(0, content.trim().split(/\r?\n/).length - 1);
        }
      }
      setDataLabel(`Imported preview · ${rows} structured rows`);
      setImportStatus(`Ready to preview: ${rows} structured rows. No Costco login or credentials were used.`);
    } catch {
      setImportStatus("Couldn’t read that structured file. Nothing was imported; check the file and try again.");
    }
  }

  return (
    <div className="app-shell">
      <aside className="side-rail" aria-label="Primary navigation">
        <button className="brand" onClick={() => changeTab("overview")} aria-label="BasketSense overview">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>
            <strong>BasketSense</strong>
            <small>Our Costco companion</small>
          </span>
        </button>

        <nav className="desktop-nav">
          {tabs.map((tab) => (
            <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => changeTab(tab.id)} aria-current={activeTab === tab.id ? "page" : undefined}>
              <span className="nav-glyph" aria-hidden="true">{tab.short}</span>
              <span>{tab.label}</span>
              {tab.id === "review" && openReviewCount > 0 ? <span className="nav-count">{openReviewCount}</span> : null}
            </button>
          ))}
        </nav>

        <div className="rail-footer">
          <div className="household-row">
            <span className="avatar avatar-one">HH</span>
            <span className="avatar avatar-two">SH</span>
            <span><strong>Our household</strong><small>Private to 2 people</small></span>
          </div>
          <button className="text-button" onClick={() => setIsImportOpen(true)}>Data & privacy</button>
        </div>
      </aside>

      <main className="main-canvas">
        <header className="topbar">
          <div>
            <span className="mobile-kicker">BasketSense</span>
            <p className="data-label"><span className="status-dot" /> {dataLabel}</p>
          </div>
          <div className="topbar-actions">
            <div className="avatar-stack" aria-label="Household members HH and SH">
              <span className="avatar avatar-one">HH</span>
              <span className="avatar avatar-two">SH</span>
            </div>
            <button className="secondary-button import-button" onClick={() => setIsImportOpen(true)}>Add receipts</button>
          </div>
        </header>

        {activeTab === "overview" ? (
          <OverviewTab changeTab={changeTab} openReviewCount={openReviewCount} />
        ) : null}

        {activeTab === "spending" ? (
          <SpendingTab period={period} setPeriod={setPeriod} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} />
        ) : null}

        {activeTab === "products" ? (
          <ProductsTab
            search={productSearch}
            setSearch={setProductSearch}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
            products={filteredProducts}
            selected={selectedProduct}
            setSelectedProductId={setSelectedProductId}
            note={notes[selectedProduct.id] ?? ""}
            setNote={(value) => setNotes((all) => ({ ...all, [selectedProduct.id]: value }))}
            onSaveNote={() => flash("Household note saved")}
          />
        ) : null}

        {activeTab === "week" ? (
          <ThisWeekTab
            items={listItems}
            newItem={newItem}
            setNewItem={setNewItem}
            onAdd={addManualItem}
            onToggleIncluded={toggleIncluded}
            onToggleChecked={toggleChecked}
            onCopy={copyList}
          />
        ) : null}

        {activeTab === "review" ? (
          <ReviewTab items={reviewItems} onResolve={resolveReview} />
        ) : null}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {tabs.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => changeTab(tab.id)} aria-current={activeTab === tab.id ? "page" : undefined}>
            <span className="nav-glyph" aria-hidden="true">{tab.short}</span>
            <span>{tab.label === "This Week" ? "Week" : tab.label}</span>
            {tab.id === "review" && openReviewCount > 0 ? <span className="mobile-count">{openReviewCount}</span> : null}
          </button>
        ))}
      </nav>

      {isImportOpen ? (
        <ImportDialog status={importStatus} onClose={() => setIsImportOpen(false)} onImport={handleImport} />
      ) : null}

      <div className="live-region" aria-live="polite" aria-atomic="true">
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    </div>
  );
}

function OverviewTab({ changeTab, openReviewCount }: { changeTab: (tab: Tab) => void; openReviewCount: number }) {
  return (
    <div className="page page-overview">
      <section className="page-heading">
        <p className="eyebrow">Monday, July 13</p>
        <h1>Good evening, household.</h1>
        <p>Here’s what your Costco history can help with next.</p>
      </section>

      <section className="hero-grid">
        <article className="saturday-card">
          <div className="saturday-topline">
            <span className="pill pill-light">This Saturday</span>
            <span className="auto-saved">Automatically saved</span>
          </div>
          <h2>Your useful list is already taking shape.</h2>
          <p>Three essentials look due, one supply check could prevent a duplicate, and a favorite discovery is waiting in Consider.</p>
          <div className="saturday-stats">
            <span><strong>3</strong> essentials</span>
            <span><strong>2</strong> suggestions</span>
            <span><strong>1</strong> quick check</span>
          </div>
          <button className="light-button" onClick={() => changeTab("week")}>Review Saturday’s list</button>
        </article>

        <article className="next-step-card card">
          <div className="card-heading compact">
            <div>
              <p className="eyebrow">Next useful step</p>
              <h2>{openReviewCount} items can teach the dashboard</h2>
            </div>
            <span className="round-number">{openReviewCount}</span>
          </div>
          <p className="muted">One receipt match, one possible duplicate, and two discovery questions. Answer any three—or leave them unknown.</p>
          <button className="secondary-button" onClick={() => changeTab("review")}>Open review</button>
        </article>
      </section>

      <section className="metrics-strip" aria-label="Costco year-to-date summary">
        <article>
          <span>Costco this year</span>
          <strong>$8,420</strong>
          <small>Sample data · Jan–Jul 2026</small>
        </article>
        <article>
          <span>Trips</span>
          <strong>31</strong>
          <small>4.4 per month</small>
        </article>
        <article>
          <span>Average trip</span>
          <strong>$272</strong>
          <small>About $18 above last year</small>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="card spend-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Movement</p>
              <h2>Monthly Costco spending</h2>
              <p>Net receipt totals · Jan–Jul</p>
            </div>
            <button className="text-button" onClick={() => changeTab("spending")}>Explore spending</button>
          </div>
          <MonthlyBarChart compact />
        </article>

        <article className="card category-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Where it went</p>
              <h2>Category mix</h2>
              <p>$8,420 classified · sample data</p>
            </div>
          </div>
          <CategoryBars limit={5} />
        </article>
      </section>

      <section className="card learning-section">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Patterns worth seeing</p>
            <h2>Useful, not judgmental</h2>
          </div>
          <EvidenceBadge label="System suggestion" />
        </div>
        <div className="learning-grid">
          <button className="insight-card" onClick={() => changeTab("products") }>
            <span className="insight-icon sage">7–9</span>
            <strong>Milk has a steady rhythm</strong>
            <p>Usually repurchased every 7–9 days; last bought 8 days ago.</p>
            <span className="insight-link">See evidence →</span>
          </button>
          <button className="insight-card" onClick={() => changeTab("spending") }>
            <span className="insight-icon apricot">+28</span>
            <strong>Household items moved up</strong>
            <p>Package spending is 28% above the same sample period last year.</p>
            <span className="insight-link">Explore category →</span>
          </button>
          <button className="insight-card" onClick={() => changeTab("review") }>
            <span className="insight-icon lilac">7</span>
            <strong>New products became repeats</strong>
            <p>Seven discoveries were purchased again; four still need context.</p>
            <span className="insight-link">Review discoveries →</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function SpendingTab({ period, setPeriod, categoryFilter, setCategoryFilter }: { period: Period; setPeriod: (value: Period) => void; categoryFilter: string; setCategoryFilter: (value: string) => void }) {
  const shownCategories = categoryFilter === "All categories" ? categories : categories.filter((category) => category.name === categoryFilter);
  return (
    <div className="page">
      <section className="page-heading with-controls">
        <div>
          <p className="eyebrow">Explore</p>
          <h1>Spending</h1>
          <p>Receipt facts first. Household judgment stays with you.</p>
        </div>
        <div className="segmented-control" aria-label="Spending period">
          {(["Month", "Quarter", "Year"] as Period[]).map((value) => (
            <button key={value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{value}</button>
          ))}
        </div>
      </section>

      <section className="notice-card">
        <span className="notice-mark">i</span>
        <p><strong>Intent coverage begins with the available list.</strong> Older receipts support spending and cadence, but they are not labeled planned or unplanned.</p>
      </section>

      <section className="metrics-strip four">
        <article><span>Net spend</span><strong>$8,420</strong><small>31 reconciled receipts</small></article>
        <article><span>Gross purchases</span><strong>$8,711</strong><small>Before discounts & returns</small></article>
        <article><span>Discounts</span><strong>$244</strong><small>Receipt-stated savings</small></article>
        <article><span>Returns</span><strong>−$47</strong><small>Not counted as regret</small></article>
      </section>

      <section className="dashboard-grid spending-grid">
        <article className="card spend-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Trend</p>
              <h2>Monthly net spending</h2>
              <p>Current period versus the same months last year</p>
            </div>
          </div>
          <MonthlyBarChart />
        </article>
        <article className="card category-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Composition</p>
              <h2>Category breakdown</h2>
              <p>Every bar starts at zero</p>
            </div>
            <label className="select-label">
              <span>Category</span>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option>All categories</option>
                {categories.map((category) => <option key={category.name}>{category.name}</option>)}
              </select>
            </label>
          </div>
          <CategoryBars categoriesToShow={shownCategories} limit={5} />
        </article>
      </section>

      <section className="card trip-table-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Receipt trail</p>
            <h2>Recent trips</h2>
            <p>Gross purchases, discounts, returns, and total remain separate.</p>
          </div>
          <EvidenceBadge label="From receipt" />
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Date</th><th>Warehouse</th><th>Items</th><th>Gross</th><th>Discounts</th><th>Returns</th><th>Total</th></tr></thead>
            <tbody>
              {recentTrips.map((trip) => (
                <tr key={trip.date}>
                  <td><strong>{trip.date}</strong><small>{trip.type}</small></td>
                  <td>{trip.warehouse}</td>
                  <td>{trip.items}</td>
                  <td>{preciseMoney.format(trip.gross)}</td>
                  <td>−{preciseMoney.format(trip.discounts)}</td>
                  <td>{trip.returns ? `−${preciseMoney.format(trip.returns)}` : "—"}</td>
                  <td><strong>{preciseMoney.format(trip.total)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ProductsTab({ search, setSearch, categoryFilter, setCategoryFilter, products: shownProducts, selected, setSelectedProductId, note, setNote, onSaveNote }: {
  search: string;
  setSearch: (value: string) => void;
  categoryFilter: string;
  setCategoryFilter: (value: string) => void;
  products: Product[];
  selected: Product;
  setSelectedProductId: (id: string) => void;
  note: string;
  setNote: (value: string) => void;
  onSaveNote: () => void;
}) {
  const productCategories = Array.from(new Set(products.map((product) => product.category)));
  return (
    <div className="page">
      <section className="page-heading with-controls product-heading">
        <div>
          <p className="eyebrow">Search the household history</p>
          <h1>Products</h1>
          <p>Prices, rhythms, raw receipt names, and what worked for your household.</p>
        </div>
        <div className="product-filters">
          <label className="search-field"><span className="sr-only">Search products</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products…" /></label>
          <label className="select-label"><span className="sr-only">Filter by category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option>All categories</option>{productCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
        </div>
      </section>

      <section className="product-layout">
        <div className="product-list card" aria-label="Product results">
          <div className="product-list-header"><span>{shownProducts.length} products</span><span>Most frequent first</span></div>
          {shownProducts.map((product) => {
            const delta = product.lastPrice - product.previousPrice;
            return (
              <button key={product.id} className={`product-row ${selected.id === product.id ? "active" : ""}`} onClick={() => setSelectedProductId(product.id)}>
                <span className="product-initial" aria-hidden="true">{product.name.charAt(0)}</span>
                <span className="product-main"><strong>{product.name}</strong><small>{product.lastPurchased} · {product.purchases} purchases</small></span>
                <span className="product-meta"><strong>{preciseMoney.format(product.lastPrice)}</strong><small className={delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : ""}>{delta === 0 ? "No change" : `${delta > 0 ? "+" : ""}${preciseMoney.format(delta)}`}</small></span>
              </button>
            );
          })}
          {!shownProducts.length ? <div className="empty-state"><strong>No matching products</strong><p>Try a broader search or clear the category filter.</p></div> : null}
        </div>

        <article className="product-detail card">
          <div className="product-detail-top">
            <div><p className="eyebrow">{selected.category}</p><h2>{selected.name}</h2><p>{selected.brand} · item {selected.itemNumber}</p></div>
            <span className="household-label">{selected.householdLabel}</span>
          </div>
          <div className="detail-metrics">
            <div><span>Usual rhythm</span><strong>{selected.interval}</strong></div>
            <div><span>Last package price</span><strong>{preciseMoney.format(selected.lastPrice)}</strong></div>
            <div><span>Total household spend</span><strong>{preciseMoney.format(selected.totalSpend)}</strong></div>
          </div>
          <div className="evidence-row"><EvidenceBadge label="From receipt" /><span>{selected.match}</span></div>

          <div className="history-section">
            <div className="section-heading"><h3>Exact-product history</h3><span>Package prices</span></div>
            <div className="price-history">
              {selected.history.map((point) => (
                <div key={`${point.date}-${point.price}`} className="price-point">
                  <span>{point.date}</span><strong>{preciseMoney.format(point.price)}</strong>{point.note ? <small>{point.note}</small> : null}
                </div>
              ))}
            </div>
          </div>

          <div className="raw-name"><span>Raw receipt description</span><code>{selected.rawName}</code></div>

          <label className="notes-field">
            <span>Household note</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What should the two of you remember?" />
          </label>
          <div className="detail-actions"><button className="secondary-button" onClick={onSaveNote}>Save note</button><button className="text-button">Pause suggestions</button></div>
        </article>
      </section>
    </div>
  );
}

function ThisWeekTab({ items, newItem, setNewItem, onAdd, onToggleIncluded, onToggleChecked, onCopy }: {
  items: ListItem[];
  newItem: string;
  setNewItem: (value: string) => void;
  onAdd: (event: FormEvent) => void;
  onToggleIncluded: (id: string) => void;
  onToggleChecked: (id: string) => void;
  onCopy: () => void;
}) {
  const included = items.filter((item) => item.included);
  const estimated = included.reduce((sum, item) => sum + item.price, 0);
  const sections: ListItem["section"][] = ["Essentials", "Suggested", "Check first", "Consider"];
  return (
    <div className="page week-page">
      <section className="page-heading with-controls">
        <div><p className="eyebrow">Saturday, July 18</p><h1>This Week</h1><p>One shared list, automatically versioned as either of you edits it.</p></div>
        <button className="secondary-button" onClick={onCopy}>Copy list</button>
      </section>

      <section className="week-summary">
        <div><span>On the list</span><strong>{included.length} items</strong></div>
        <div><span>Approximate total</span><strong>{preciseMoney.format(estimated)}</strong><small>Last known package prices</small></div>
        <div><span>Discovery room</span><strong>$30</strong><small>Optional, not a target</small></div>
        <div className="save-state"><span className="status-dot" /><strong>Saved just now</strong><small>HH + SH share this link</small></div>
      </section>

      <form className="quick-add" onSubmit={onAdd}>
        <label className="sr-only" htmlFor="quick-item">Add an item</label>
        <input id="quick-item" value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="Add milk, fruit, diapers…" />
        <button className="primary-button" type="submit">Add item</button>
      </form>

      <div className="week-layout">
        <section className="list-card card">
          {sections.map((section) => {
            const sectionItems = items.filter((item) => item.section === section);
            return (
              <div className="list-section" key={section}>
                <div className="list-section-heading"><div><h2>{section}</h2><p>{section === "Essentials" ? "Already on the shared list" : section === "Suggested" ? "Based on household rhythms" : section === "Check first" ? "A quick supply check may help" : "Optional favorites and ideas"}</p></div><span>{sectionItems.filter((item) => item.included).length}/{sectionItems.length}</span></div>
                <div className="list-rows">
                  {sectionItems.map((item) => (
                    <div className={`list-row ${item.included ? "included" : ""} ${item.checked ? "checked" : ""}`} key={item.id}>
                      {item.included ? (
                        <button className="check-button" onClick={() => onToggleChecked(item.id)} aria-label={`${item.checked ? "Uncheck" : "Check"} ${item.name}`}><span aria-hidden="true">{item.checked ? "✓" : ""}</span></button>
                      ) : <span className="suggestion-dot" aria-hidden="true" />}
                      <div className="list-row-copy"><strong>{item.name}</strong><p>{item.reason}</p><small>{item.source}</small></div>
                      <div className="list-row-actions"><span className="estimated-price">{item.price ? `~${preciseMoney.format(item.price)}` : "No estimate"}</span><button className={item.included ? "text-button" : "add-button"} onClick={() => onToggleIncluded(item.id)}>{item.included ? "Remove" : "Add"}</button></div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </section>

        <aside className="week-rail">
          <article className="card why-card"><p className="eyebrow">How suggestions work</p><h2>Receipts suggest timing. You decide need.</h2><p>Purchase rhythm, time since last purchase, and recent household feedback shape the list. Nothing is assumed to be empty or wasteful.</p><button className="text-button">See recommendation rules</button></article>
          <article className="card share-card"><div className="avatar-stack"><span className="avatar avatar-one">HH</span><span className="avatar avatar-two">SH</span></div><h2>One household link</h2><p>Friday email opens this list. Copy it to Reminders or Keep when that is more convenient.</p><button className="secondary-button" onClick={onCopy}>Copy for sharing</button></article>
        </aside>
      </div>
    </div>
  );
}

function ReviewTab({ items, onResolve }: { items: ReviewItem[]; onResolve: (id: string, answer: string) => void }) {
  const open = items.filter((item) => item.status === "open");
  const resolved = items.filter((item) => item.status === "resolved");
  return (
    <div className="page review-page">
      <section className="page-heading"><p className="eyebrow">Lightweight learning inbox</p><h1>Review</h1><p>Only questions whose answers could improve categories, matches, or future suggestions.</p></section>
      <section className="notice-card gentle"><span className="notice-mark">3</span><p><strong>Three questions is enough.</strong> Unknown is a valid answer, and old questions can be left alone.</p></section>

      <section className="review-grid">
        {open.map((item) => (
          <article className="review-card card" key={item.id}>
            <div className="review-top"><div><p className="eyebrow">{item.eyebrow}</p><h2>{item.title}</h2></div>{item.amount ? <strong className="review-amount">{preciseMoney.format(item.amount)}</strong> : null}</div>
            <EvidenceBadge label={item.badge} />
            <p className="review-context">{item.context}</p>
            <div className="review-options">
              {item.options.map((option) => <button key={option} onClick={() => onResolve(item.id, option)}>{option}</button>)}
            </div>
          </article>
        ))}
        {!open.length ? <div className="empty-state card"><span className="empty-check">✓</span><strong>Nothing needs attention</strong><p>The dashboard will ask again only when a new receipt or later product outcome can teach it something.</p></div> : null}
      </section>

      {resolved.length ? (
        <section className="resolved-section"><h2>Answered this session</h2>{resolved.map((item) => <div className="resolved-row" key={item.id}><span>✓</span><div><strong>{item.title}</strong><small>{item.answer}</small></div></div>)}</section>
      ) : null}
    </div>
  );
}

function MonthlyBarChart({ compact = false }: { compact?: boolean }) {
  const max = Math.max(...monthlySpend.map((item) => item.current));
  return (
    <div className={`bar-chart ${compact ? "compact" : ""}`}>
      <div className="chart-legend"><span><i className="legend-current" />2026</span><span><i className="legend-previous" />2025</span></div>
      <div className="bars" role="img" aria-label="Monthly net Costco spending from January through July 2026 compared with 2025">
        {monthlySpend.map((item) => (
          <div className="bar-group" key={item.month} tabIndex={0} aria-label={`${item.month}: ${money.format(item.current)} in 2026, ${money.format(item.previous)} in 2025, ${item.trips} trips`}>
            <div className="bar-pair"><span className="bar previous" style={{ height: `${Math.max(12, (item.previous / max) * 100)}%` }} /><span className="bar current" style={{ height: `${Math.max(12, (item.current / max) * 100)}%` }} /></div>
            <span className="bar-label">{item.month}</span>
          </div>
        ))}
      </div>
      <p className="chart-summary">2026 sample total is $8,420 across 31 trips, about 12% above the same months in the comparison sample.</p>
    </div>
  );
}

function CategoryBars({ limit = 5, categoriesToShow }: { limit?: number; categoriesToShow?: typeof categories }) {
  const shown = (categoriesToShow ?? categories).slice(0, limit);
  const max = Math.max(...shown.map((category) => category.amount));
  return (
    <div className="category-bars">
      {shown.map((category) => (
        <div className="category-bar-row" key={category.name}>
          <div className="category-label"><span>{category.name}</span><strong>{money.format(category.amount)}</strong></div>
          <div className="category-track" aria-label={`${category.name}: ${money.format(category.amount)}, ${category.share}%`}><span style={{ width: `${(category.amount / max) * 100}%`, background: category.color }} /></div>
          <small>{category.share}% of classified spend</small>
        </div>
      ))}
    </div>
  );
}

function ImportDialog({ status, onClose, onImport }: { status: string | null; onClose: () => void; onImport: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="dialog-heading"><div><p className="eyebrow">Private household data</p><h2 id="import-title">Add receipt history</h2></div><button className="close-button" onClick={onClose} aria-label="Close receipt import">×</button></div>
        <p className="dialog-intro">Upload receipt photos or receipts saved from Costco.com. BasketSense never asks for your Costco password.</p>

        <label className="drop-zone">
          <span className="upload-mark" aria-hidden="true">＋</span>
          <strong>Choose receipt files</strong>
          <span>JPG, PNG, HEIC, PDF, JSON, or CSV · up to 25 at a time</span>
          <input type="file" multiple accept=".jpg,.jpeg,.png,.heic,.pdf,.json,.csv,image/*,application/pdf" onChange={onImport} />
        </label>

        <div className="import-options">
          <div><span className="option-number">1</span><p><strong>Photos & PDFs</strong><small>Staged for receipt reading and total checks</small></p></div>
          <div><span className="option-number">2</span><p><strong>Structured export</strong><small>JSON/CSV is validated locally in this prototype</small></p></div>
        </div>

        {status ? <div className="import-status" role="status"><span className="status-dot" /><p>{status}</p></div> : null}

        <div className="truth-list">
          <h3>What the importer will preserve</h3>
          <ul><li>Original receipt and description</li><li>Products, discounts, tax, returns, and totals separately</li><li>Unknown lines instead of forced guesses</li><li>Exact-product history only when identity is reliable</li></ul>
        </div>
        <div className="dialog-actions"><button className="text-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
