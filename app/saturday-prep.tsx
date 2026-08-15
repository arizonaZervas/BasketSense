"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type SaturdayPrepItem = {
  id: string;
  productId: string | null;
  label: string;
  section: "essentials" | "suggested" | "check_first" | "consider";
  recommendationReason: string | null;
  confidenceBps: number | null;
  estimatedPriceCents: number | null;
};

type PrepDecision = "add" | "skip" | "later" | "have_enough" | "not_sure";

function prepDateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value.slice(0, 10)}T12:00:00.000Z`));
}

function evidenceLabel(item: SaturdayPrepItem) {
  if (item.recommendationReason) return item.recommendationReason;
  if (item.confidenceBps !== null && item.confidenceBps >= 8_000) {
    return "Strong recurring receipt cadence";
  }
  return "Suggested from your household receipt history";
}

export function SaturdayPrepExperience({
  tripId,
  scheduledFor,
  items,
  suppressedCount,
  pendingItemIds,
  onAdd,
}: {
  tripId: string;
  scheduledFor: string;
  items: readonly SaturdayPrepItem[];
  suppressedCount: number;
  pendingItemIds: ReadonlySet<string>;
  onAdd: (item: SaturdayPrepItem, trigger: HTMLButtonElement) => void;
}) {
  const storageKey = `basketsense-saturday-prep:${tripId}`;
  const [status, setStatus] = useState<"idle" | "open" | "dismissed" | "complete">(
    () => {
      if (typeof window === "undefined") return "idle";
      const saved = window.localStorage.getItem(storageKey);
      return saved === "dismissed" || saved === "complete" ? saved : "idle";
    },
  );
  const [step, setStep] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, PrepDecision>>({});
  const [prepItems, setPrepItems] = useState<readonly SaturdayPrepItem[]>([]);
  const startButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (status === "open") heading.current?.focus();
  }, [status, step]);

  const sourceItems = prepItems.length ? prepItems : items;
  const likelyDue = useMemo(
    () =>
      sourceItems
        .filter((item) => item.section !== "check_first")
        .slice(0, 3),
    [sourceItems],
  );
  const checkAtHome = useMemo(
    () => sourceItems.filter((item) => item.section === "check_first").slice(0, 3),
    [sourceItems],
  );
  const addedCount = Object.values(decisions).filter((value) => value === "add").length;
  const homeCheckedCount = Object.values(decisions).filter((value) =>
    value === "have_enough" || value === "not_sure",
  ).length;

  function startPrep() {
    setPrepItems(items);
    setDecisions({});
    setStep(0);
    setStatus("open");
  }

  function rememberStatus(next: "dismissed" | "complete") {
    window.localStorage.setItem(storageKey, next);
    setStatus(next);
  }

  function choose(
    item: SaturdayPrepItem,
    decision: PrepDecision,
    trigger?: HTMLButtonElement,
  ) {
    const previous = decisions[item.id];
    setDecisions((current) => ({ ...current, [item.id]: decision }));
    if (decision === "add" && previous !== "add" && trigger) {
      onAdd(item, trigger);
    }
  }

  if (status === "dismissed") return null;

  if (status === "complete") {
    return (
      <section className="saturday-prep-complete" aria-label="Saturday Prep complete">
        <span aria-hidden="true">✓</span>
        <div>
          <strong>Saturday Prep is done for this trip</strong>
          <p>Your shared list stays editable until shopping starts.</p>
        </div>
      </section>
    );
  }

  if (status === "idle") {
    return (
      <section className="saturday-prep-card" aria-labelledby="saturday-prep-title">
        <div className="saturday-prep-card-copy">
          <p className="section-label">{prepDateLabel(scheduledFor)} · about 2 minutes</p>
          <h2 id="saturday-prep-title">A quick check before Costco?</h2>
          <p>
            Review a few likely-due and check-at-home ideas. Nothing joins the
            shared list until you choose it.
          </p>
          <div className="saturday-prep-counts" aria-label="Prep overview">
            <span>{likelyDue.length} likely due</span>
            <span>{checkAtHome.length} check at home</span>
            {suppressedCount ? <span>{suppressedCount} remembered choice</span> : null}
          </div>
        </div>
        <div className="saturday-prep-card-actions">
          <button
            ref={startButton}
            type="button"
            className="primary-button prep-start-button"
            onClick={startPrep}
          >
            Start Saturday Prep
          </button>
          <button
            type="button"
            className="text-button prep-dismiss-button"
            onClick={() => rememberStatus("dismissed")}
          >
            Not this week
          </button>
        </div>
      </section>
    );
  }

  const currentItems = step === 0 ? likelyDue : checkAtHome;
  const currentTitle = step === 0 ? "May be worth adding" : "Do you have enough?";
  const currentCopy =
    step === 0
      ? "The evidence is shown with every idea. Skip and Later do not change future suggestions."
      : "BasketSense is asking—not claiming to know what is in the house.";

  return (
    <section className="saturday-prep-flow" aria-labelledby="saturday-prep-step-title">
      <div className="saturday-prep-flow-header">
        <div>
          <p className="section-label">Saturday Prep · step {step + 1} of 3</p>
          <h2 id="saturday-prep-step-title" ref={heading} tabIndex={-1}>
            {step < 2 ? currentTitle : "Your list is ready"}
          </h2>
          <p>
            {step < 2
              ? currentCopy
              : "You made the useful choices. There is no target to beat and no score to improve."}
          </p>
        </div>
        <button
          type="button"
          className="text-button saturday-prep-close"
          onClick={() => {
            setStatus("idle");
            window.requestAnimationFrame(() => startButton.current?.focus());
          }}
        >
          Close
        </button>
      </div>
      <div className="saturday-prep-progress" aria-hidden="true">
        <span style={{ width: `${((step + 1) / 3) * 100}%` }} />
      </div>

      {step < 2 ? (
        currentItems.length ? (
          <div className="saturday-prep-items">
            {currentItems.map((item) => {
              const decision = decisions[item.id];
              const pending = pendingItemIds.has(item.id);
              const options =
                step === 0
                  ? ([
                      ["add", pending ? "Adding…" : "Add"],
                      ["skip", "Skip"],
                      ["later", "Later"],
                    ] as const)
                  : ([
                      ["have_enough", "Have enough"],
                      ["add", pending ? "Adding…" : "Add"],
                      ["not_sure", "Not sure"],
                    ] as const);
              return (
                <article className="saturday-prep-item" key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{evidenceLabel(item)}</p>
                  </div>
                  <div className="saturday-prep-decisions" role="radiogroup" aria-label={`${item.label} decision`}>
                    {options.map(([value, label]) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={decision === value}
                        className={decision === value ? "selected" : ""}
                        key={value}
                        disabled={pending || (decision === "add" && value !== "add")}
                        onClick={(event) => choose(item, value, event.currentTarget)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state saturday-prep-empty">
            <strong>Nothing needs a decision here</strong>
            <p>Your current household evidence did not produce any items for this step.</p>
          </div>
        )
      ) : (
        <div className="saturday-prep-summary">
          <span className="saturday-prep-summary-mark" aria-hidden="true">✓</span>
          <div className="saturday-prep-summary-copy">
            <strong>{addedCount ? `${addedCount} added to the shared list` : "No extra items added"}</strong>
            <p>
              {homeCheckedCount
                ? `${homeCheckedCount} home ${homeCheckedCount === 1 ? "check" : "checks"} completed. `
                : ""}
              Both spouses can keep editing the list before shopping starts.
            </p>
          </div>
          <div className="saturday-prep-discovery">
            <span aria-hidden="true">✦</span>
            <div>
              <strong>Leave room for one good find</strong>
              <p>An optional reminder—not a budget, allowance, or goal.</p>
            </div>
          </div>
        </div>
      )}

      <div className="saturday-prep-navigation">
        {step > 0 ? (
          <button type="button" className="secondary-button" onClick={() => setStep(step - 1)}>
            Back
          </button>
        ) : (
          <button type="button" className="text-button" onClick={() => setStep(1)}>
            Skip this step
          </button>
        )}
        {step < 2 ? (
          <button type="button" className="primary-button" onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={() => rememberStatus("complete")}>
            Finish Prep
          </button>
        )}
      </div>
    </section>
  );
}
