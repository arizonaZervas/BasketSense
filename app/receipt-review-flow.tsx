"use client";

import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseCostcoOcrText, reconcileReceipt } from "./receipt-logic";

export type ClosedLoopReceipt = {
  id: string;
  tripId?: string | null;
  purchasedAt?: string | null;
  purchasedOn?: string | null;
  parseStatus?: string | null;
  status?: string | null;
  subtotalCents?: number | null;
  taxCents?: number | null;
  totalCents?: number | null;
  discountCents?: number | null;
  reconciliationDifferenceCents?: number | null;
};

export type ClosedLoopReceiptItem = {
  id?: string;
  sourceLineNumber?: number | null;
  costcoItemNumber?: string | null;
  rawDescription?: string | null;
  description?: string | null;
  quantityMilli?: number | null;
  unitPriceCents?: number | null;
  lineSubtotalCents?: number | null;
  discountCents?: number | null;
  netAmountCents?: number | null;
  taxStatus?: "taxable" | "non_taxable" | "unknown" | null;
};

export type ClosedLoopQuestion = {
  id: string;
  purpose?: string | null;
  prompt: string;
  options: Array<{
    value: string;
    label: string;
    effect?: string | null;
  }>;
  status?: string | null;
  selectedValue?: string | null;
  effectTarget?: string | null;
};

export type ClosedLoopComparison = {
  isProvisional?: boolean;
  frozenEstimateCents?: number | null;
  actualMerchandiseCents?: number | null;
  actualTotalCents?: number | null;
  matchedVarianceCents?: number | null;
  unpricedPlannedActualCents?: number | null;
  additionsCents?: number | null;
  skippedEstimateCents?: number | null;
  discountsCents?: number | null;
  taxCents?: number | null;
  unresolvedCents?: number | null;
  buckets?:
    | Array<{
        key?: string;
        label?: string;
        amountCents?: number | null;
        itemCount?: number | null;
        items?: Array<{ label?: string; amountCents?: number | null }>;
      }>
    | Record<
        string,
        | number
        | Array<Record<string, string | number | null>>
        | {
            label?: string;
            amountCents?: number | null;
            itemCount?: number | null;
            items?: Array<{ label?: string; amountCents?: number | null }>;
          }
      >;
};

export type ClosedLoopSnapshot = {
  receipt?: ClosedLoopReceipt | null;
  items?: ClosedLoopReceiptItem[];
  intentItems?: unknown[];
  matches?: unknown[];
  comparison?: ClosedLoopComparison | null;
  questions?: ClosedLoopQuestion[];
  upload?: {
    id?: string | null;
    status?: string | null;
    filename?: string | null;
    storedAt?: string | null;
  } | null;
};

type ReceiptDraftLine = {
  clientId: string;
  itemNumber: string;
  description: string;
  amount: string;
  quantityMilli: number;
  unitPriceCents: number | null;
  kind: "item" | "discount";
  taxStatus: "taxable" | "non_taxable" | "unknown";
};

type ReceiptDraft = {
  purchasedOn: string;
  subtotal: string;
  tax: string;
  total: string;
  discount: string;
  items: ReceiptDraftLine[];
};

export type ReceiptStep = "capture" | "check" | "bridge";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const bucketLabels: Record<string, string> = {
  matched: "Saved list + purchased",
  planned_and_purchased: "Saved list + purchased",
  missing: "Saved list, not found on receipt",
  planned_not_purchased: "Saved list, not found on receipt",
  in_store: "Added during trip + purchased",
  added_during_trip: "Added during trip + purchased",
  optional: "Check-first or consider item purchased",
  consider: "Check-first or consider item purchased",
  receipt_only: "Not on saved list",
  unplanned: "Not on saved list",
  receiptonly: "Not on saved list",
  substitution: "Possible substitution",
  possiblesubstitutions: "Possible substitution",
  skippedplanned: "Saved list, not found on receipt",
  unpricedplanned: "Saved-list item without an estimate",
  unresolved: "Needs review",
};

function todayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function centsToInput(value: number | null | undefined) {
  return value === null || value === undefined ? "" : (value / 100).toFixed(2);
}

function inputToCents(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const negative = /^\(.*\)$/.test(trimmed) || /^-/.test(trimmed);
  const numeric = Number(trimmed.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) * (negative ? -1 : 1);
}

function clientId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function blankLine(): ReceiptDraftLine {
  return {
    clientId: clientId(),
    itemNumber: "",
    description: "",
    amount: "",
    quantityMilli: 1000,
    unitPriceCents: null,
    kind: "item",
    taxStatus: "unknown",
  };
}

function blankDraft(): ReceiptDraft {
  return {
    purchasedOn: todayInputValue(),
    subtotal: "",
    tax: "",
    total: "",
    discount: "",
    items: [blankLine()],
  };
}

function draftFromClosedLoop(closedLoop: ClosedLoopSnapshot | null | undefined) {
  const receipt = closedLoop?.receipt;
  if (!receipt) return blankDraft();
  return {
    purchasedOn: (receipt.purchasedAt ?? receipt.purchasedOn ?? todayInputValue()).slice(
      0,
      10,
    ),
    subtotal: centsToInput(receipt.subtotalCents),
    tax: centsToInput(receipt.taxCents),
    total: centsToInput(receipt.totalCents),
    discount: centsToInput(receipt.discountCents),
    items: closedLoop?.items?.length
      ? closedLoop.items.map((item) => ({
          clientId: item.id ?? clientId(),
          itemNumber: item.costcoItemNumber ?? "",
          description: item.rawDescription ?? item.description ?? "",
          amount: centsToInput(item.netAmountCents ?? item.lineSubtotalCents),
          quantityMilli: item.quantityMilli ?? 1000,
          unitPriceCents: item.unitPriceCents ?? null,
          kind:
            (item.discountCents ?? 0) > 0 && (item.lineSubtotalCents ?? 0) === 0
              ? "discount"
              : "item",
          taxStatus: item.taxStatus ?? "unknown",
        }))
      : [blankLine()],
  } satisfies ReceiptDraft;
}

function draftFromParser(value: unknown): ReceiptDraft {
  const parsed = (value ?? {}) as {
    purchasedAt?: string | null;
    purchasedOn?: string | null;
    subtotalCents?: number | null;
    taxCents?: number | null;
    totalCents?: number | null;
    discountCents?: number | null;
    items?: Array<{
      costcoItemNumber?: string | null;
      itemNumber?: string | null;
      rawDescription?: string | null;
      description?: string | null;
      lineSubtotalCents?: number | null;
      netAmountCents?: number | null;
      amountCents?: number | null;
      quantityMilli?: number | null;
      quantity?: number | null;
      unitPriceCents?: number | null;
      discountCents?: number | null;
      kind?: "item" | "discount";
      taxStatus?: "taxable" | "non_taxable" | "unknown";
    }>;
  };
  const items = (parsed.items ?? []).map((item) => ({
    clientId: clientId(),
    itemNumber: item.costcoItemNumber ?? item.itemNumber ?? "",
    description: item.rawDescription ?? item.description ?? "",
    amount: centsToInput(
      item.netAmountCents ?? item.lineSubtotalCents ?? item.amountCents,
    ),
    quantityMilli:
      item.quantityMilli ??
      (item.quantity === null || item.quantity === undefined
        ? 1000
        : Math.round(item.quantity * 1000)),
    unitPriceCents: item.unitPriceCents ?? null,
    kind: item.kind ?? ((item.discountCents ?? 0) > 0 ? "discount" : "item"),
    taxStatus: item.taxStatus ?? "unknown",
  }));
  return {
    purchasedOn: (parsed.purchasedAt ?? parsed.purchasedOn ?? todayInputValue()).slice(
      0,
      10,
    ),
    subtotal: centsToInput(parsed.subtotalCents),
    tax: centsToInput(parsed.taxCents),
    total: centsToInput(parsed.totalCents),
    discount: centsToInput(parsed.discountCents),
    items: items.length ? items : [blankLine()],
  };
}

function friendlyOcrStatus(status?: string) {
  if (!status) return "Reading receipt on this device…";
  return status
    .replace(/^loading tesseract core$/i, "Preparing receipt reader")
    .replace(/^initializing tesseract$/i, "Starting receipt reader")
    .replace(/^loading language traineddata$/i, "Loading text patterns")
    .replace(/^initializing api$/i, "Getting ready")
    .replace(/^recognizing text$/i, "Drafting receipt lines")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

async function responseJson(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const message = body && typeof body.error === "string" ? body.error : fallback;
    throw new Error(message);
  }
  return body ?? {};
}

function normalizeBuckets(
  comparison: ClosedLoopComparison | null | undefined,
  receiptItems: ClosedLoopReceiptItem[] = [],
) {
  const buckets = comparison?.buckets;
  if (!buckets) return [];
  const receiptItemById = new Map(
    receiptItems
      .filter((item): item is ClosedLoopReceiptItem & { id: string } => Boolean(item.id))
      .map((item) => [item.id, item]),
  );
  if (Array.isArray(buckets)) {
    return buckets.map((bucket, index) => ({
      key: bucket.key ?? `bucket-${index}`,
      label:
        bucketLabels[(bucket.key ?? "").toLowerCase()] ??
        bucket.label ??
        "Receipt comparison",
      amountCents: bucket.amountCents ?? 0,
      itemCount: bucket.itemCount ?? bucket.items?.length ?? 0,
      items: bucket.items ?? [],
    }));
  }
  return Object.entries(buckets).map(([key, value]) => {
    let details: {
      label?: string;
      amountCents?: number | null;
      itemCount?: number | null;
      items?: Array<{ label?: string; amountCents?: number | null }>;
    };
    if (typeof value === "number") {
      details = { amountCents: value, items: [] };
    } else if (Array.isArray(value)) {
      const matchedReceiptItems = value.flatMap((entry) => {
        const receiptItemId =
          entry && typeof entry === "object" && "receiptItemId" in entry
            ? String(entry.receiptItemId ?? "")
            : "";
        const receiptItem = receiptItemById.get(receiptItemId);
        return receiptItem ? [receiptItem] : [];
      });
      details = {
        itemCount: value.length,
        amountCents: matchedReceiptItems.reduce(
          (sum, item) => sum + (item.netAmountCents ?? item.lineSubtotalCents ?? 0),
          0,
        ),
        items: matchedReceiptItems.map((item) => ({
          label: item.rawDescription ?? item.description ?? "Receipt item",
          amountCents: item.netAmountCents ?? item.lineSubtotalCents ?? null,
        })),
      };
    } else {
      details = value;
    }
    const fallbackAmount =
      key === "skippedPlanned"
        ? comparison?.skippedEstimateCents ?? 0
        : key === "unresolved"
            ? comparison?.unresolvedCents ?? 0
            : key === "unpricedPlanned"
              ? comparison?.unpricedPlannedActualCents ?? 0
              : 0;
    return {
      key,
      label: bucketLabels[key.toLowerCase()] ?? details.label ?? key.replaceAll("_", " "),
      amountCents: details.amountCents ?? fallbackAmount,
      itemCount: details.itemCount ?? details.items?.length ?? 0,
      items: details.items ?? [],
    };
  });
}

export function ReceiptNextStepCard({
  tripStatus,
  closedLoop,
  onOpen,
}: {
  tripStatus: "planning" | "frozen" | "completed";
  closedLoop?: ClosedLoopSnapshot | null;
  onOpen: (step?: ReceiptStep) => void;
}) {
  const hasReceipt = Boolean(closedLoop?.receipt);
  const provisional = closedLoop?.comparison?.isProvisional;

  if (hasReceipt) {
    return (
      <section className="receipt-next-step card" aria-labelledby="receipt-next-title">
        <span className="receipt-step-mark" aria-hidden="true">✓</span>
        <div>
          <p className="section-label">Trip receipt</p>
          <h2 id="receipt-next-title">
            {provisional ? "One quick check remains" : "Receipt linked to this trip"}
          </h2>
          <p>
            {provisional
              ? "The comparison stays provisional until the unresolved amount is checked."
              : "Open the expected-to-actual bridge and the evidence-triggered review."}
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onOpen(provisional ? "check" : "bridge")}
        >
          {provisional ? "Check receipt" : "View comparison"}
        </button>
      </section>
    );
  }

  return (
    <section
      className={`receipt-next-step card ${tripStatus === "planning" ? "quiet" : "ready"}`}
      aria-labelledby="receipt-next-title"
    >
      <span className="receipt-step-mark" aria-hidden="true">3</span>
      <div>
        <p className="section-label">After checkout</p>
        <h2 id="receipt-next-title">Add today’s receipt</h2>
        <p>
          {tripStatus === "planning"
            ? "Start shopping first to capture what you intended to buy. You can still add a receipt now, but the intent comparison will be weaker."
            : "Take a photo, check the draft, then see what changed from the saved list."}
        </p>
      </div>
      <button
        type="button"
        className={tripStatus === "planning" ? "text-button" : "primary-button"}
        onClick={() => onOpen("capture")}
      >
        {tripStatus === "planning" ? "Add without saved plan" : "Add today’s receipt"}
      </button>
    </section>
  );
}

export function ReceiptFlowDialog({
  open,
  initialStep = "capture",
  tripId,
  tripStatus,
  closedLoop,
  onClose,
  onRefresh,
  onOpenReview,
}: {
  open: boolean;
  initialStep?: ReceiptStep;
  tripId: string | null;
  tripStatus: "planning" | "frozen" | "completed" | null;
  closedLoop?: ClosedLoopSnapshot | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenReview: () => void;
}) {
  const [step, setStep] = useState<ReceiptStep>(initialStep);
  const [workingClosedLoop, setWorkingClosedLoop] =
    useState<ClosedLoopSnapshot | null>(closedLoop ?? null);
  const [draft, setDraft] = useState<ReceiptDraft>(() =>
    draftFromClosedLoop(closedLoop),
  );
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(
    closedLoop?.receipt?.id ?? null,
  );
  const [draftRequestId] = useState(clientId);
  const wasOpen = useRef(false);
  const dialog = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const stepHeading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep(initialStep);
      setWorkingClosedLoop(closedLoop ?? null);
      setDraft(draftFromClosedLoop(closedLoop));
      setReceiptId(closedLoop?.receipt?.id ?? null);
      setSaveError(null);
      setPhotoError(null);
      setSavedMessage(null);
      window.setTimeout(() => closeButton.current?.focus(), 0);
    }
    wasOpen.current = open;
  }, [closedLoop, initialStep, open]);

  useEffect(() => {
    if (!open) return;
    stepHeading.current?.focus();
  }, [open, step]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    if (!open) return;
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    window.addEventListener("keydown", handleKeys);
    return () => window.removeEventListener("keydown", handleKeys);
  }, [onClose, open]);

  const values = useMemo(
    () => ({
      items: draft.items
        .filter((item) => item.description.trim() || item.amount.trim())
        .map((item, index) => {
          const amountCents = inputToCents(item.amount);
          const looksLikeDiscount =
            item.kind === "discount" ||
            (amountCents < 0 && /coupon|discount|rebate|savings/i.test(item.description));
          return {
            sourceLineNumber: index + 1,
            costcoItemNumber: item.itemNumber.trim() || undefined,
            rawDescription: item.description.trim() || "Unlabeled receipt line",
            quantityMilli: item.quantityMilli,
            unitPriceCents: item.unitPriceCents,
            lineSubtotalCents: looksLikeDiscount ? 0 : amountCents,
            netAmountCents: amountCents,
            discountCents: looksLikeDiscount ? Math.abs(amountCents) : 0,
            taxStatus: item.taxStatus,
            kind: looksLikeDiscount ? ("discount" as const) : ("item" as const),
          };
        }),
      subtotalCents: inputToCents(draft.subtotal),
      taxCents: inputToCents(draft.tax),
      totalCents: inputToCents(draft.total),
      discountCents: Math.abs(inputToCents(draft.discount)),
    }),
    [draft],
  );

  const arithmetic = useMemo(() => {
    const fallbackItemNetCents = values.items.reduce(
      (sum, item) => sum + item.lineSubtotalCents,
      0,
    );
    const fallbackSubtotalDeltaCents =
      fallbackItemNetCents - values.subtotalCents;
    const fallbackTotalDeltaCents =
      values.subtotalCents + values.taxCents - values.totalCents;
    try {
      const result = reconcileReceipt(values) as unknown as {
        itemNetCents?: number;
        computedSubtotalCents?: number;
        subtotalDeltaCents?: number;
        subtotalDelta?: number;
        totalDeltaCents?: number;
        totalDelta?: number;
        isReconciled?: boolean;
        reconciled?: boolean;
      };
      const subtotalDeltaCents =
        result.subtotalDeltaCents ??
        result.subtotalDelta ??
        fallbackSubtotalDeltaCents;
      const totalDeltaCents =
        result.totalDeltaCents ?? result.totalDelta ?? fallbackTotalDeltaCents;
      const differenceCents = Math.max(
        Math.abs(subtotalDeltaCents),
        Math.abs(totalDeltaCents),
      );
      return {
        itemNetCents:
          result.itemNetCents ?? result.computedSubtotalCents ?? fallbackItemNetCents,
        subtotalDeltaCents,
        totalDeltaCents,
        differenceCents,
        isReconciled:
          result.isReconciled ?? result.reconciled ?? differenceCents <= 5,
      };
    } catch {
      const differenceCents = Math.max(
        Math.abs(fallbackSubtotalDeltaCents),
        Math.abs(fallbackTotalDeltaCents),
      );
      return {
        itemNetCents: fallbackItemNetCents,
        subtotalDeltaCents: fallbackSubtotalDeltaCents,
        totalDeltaCents: fallbackTotalDeltaCents,
        differenceCents,
        isReconciled: differenceCents <= 5,
      };
    }
  }, [values]);

  const hasRequiredReceiptValues =
    values.items.length > 0 && Boolean(draft.subtotal.trim()) && Boolean(draft.total.trim());
  const canFinalize = hasRequiredReceiptValues && arithmetic.isReconciled;
  const hasAnyDraftData = Boolean(
    photo ||
      draft.subtotal.trim() ||
      draft.total.trim() ||
      draft.items.some((item) => item.description.trim() || item.amount.trim()),
  );

  if (!open) return null;

  function applyParsedText(text: string) {
    const parsed = parseCostcoOcrText(text);
    setDraft(draftFromParser(parsed));
    setOcrText(text);
    setOcrError(null);
    setStep("check");
  }

  async function runOcr(file: File) {
    setOcrError(null);
    setOcrStatus("Preparing receipt reader");
    setOcrProgress(0);
    try {
      const optionalOcrModule = "tesseract.js";
      const tesseract = (await import(optionalOcrModule)) as {
        createWorker?: (
          language: string,
          engineMode: number,
          options: {
            logger: (message: { status?: string; progress?: number }) => void;
          },
        ) => Promise<{
          recognize: (file: File) => Promise<{ data: { text: string } }>;
          terminate: () => Promise<void>;
        }>;
      };
      if (typeof tesseract.createWorker !== "function") {
        throw new Error("The on-device receipt reader is unavailable.");
      }
      const worker = await tesseract.createWorker("eng", 1, {
        logger(message: { status?: string; progress?: number }) {
          setOcrStatus(friendlyOcrStatus(message.status));
          if (typeof message.progress === "number") setOcrProgress(message.progress);
        },
      });
      try {
        const result = await worker.recognize(file);
        if (!result.data.text.trim()) throw new Error("No receipt text was found.");
        setOcrProgress(1);
        setOcrStatus("Draft ready");
        applyParsedText(result.data.text);
      } finally {
        await worker.terminate();
      }
    } catch (error) {
      setOcrStatus(null);
      setOcrError(
        error instanceof Error
          ? `${error.message} Your photo is still here—paste text or enter the receipt manually.`
          : "The receipt reader could not load. Your photo is still here—paste text or enter the receipt manually.",
      );
    }
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const nextPreview = URL.createObjectURL(file);
    setPhoto(file);
    setPreviewUrl(nextPreview);
    setPhotoError(null);
    void runOcr(file);
  }

  function updateLine(id: string, field: "itemNumber" | "description" | "amount", value: string) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.clientId === id ? { ...item, [field]: value } : item,
      ),
    }));
  }

  function deleteLine(id: string) {
    setDraft((current) => {
      const items = current.items.filter((item) => item.clientId !== id);
      return { ...current, items: items.length ? items : [blankLine()] };
    });
  }

  async function uploadPhoto(savedReceiptId: string) {
    if (!photo) return true;
    const form = new FormData();
    form.append("receiptId", savedReceiptId);
    form.append("file", photo);
    const response = await fetch("/api/receipt-photo", {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setPhotoError(
        body?.error ??
          "The structured receipt was saved, but private photo storage needs a retry.",
      );
      return false;
    }
    setPhotoError(null);
    return true;
  }

  async function saveDraft(finalize: boolean) {
    if (!tripId) {
      setSaveError("The shared trip is not available yet. Refresh and try again.");
      return;
    }
    if (!hasAnyDraftData) {
      setSaveError("Add a photo, receipt total, or line item before saving a draft.");
      return;
    }
    if (finalize && !canFinalize) {
      setSaveError("Check the highlighted totals before marking this receipt trusted.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    try {
      const action = receiptId ? "update_receipt_draft" : "ingest_receipt_draft";
      const response = await fetch("/api/household", {
        method: receiptId ? "PATCH" : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          clientDraftId: draftRequestId,
          receiptId,
          tripId,
          purchasedAt: draft.purchasedOn,
          ...values,
        }),
      });
      const body = await responseJson(response, "The receipt draft could not be saved.");
      if (body.closedLoop && typeof body.closedLoop === "object") {
        setWorkingClosedLoop(body.closedLoop as ClosedLoopSnapshot);
      }
      const bodyReceipt = body.receipt as { id?: unknown } | undefined;
      const savedReceiptId =
        (typeof body.receiptId === "string" ? body.receiptId : null) ??
        (typeof bodyReceipt?.id === "string" ? bodyReceipt.id : null) ??
        receiptId;
      if (!savedReceiptId) throw new Error("The receipt saved without a usable receipt ID.");
      setReceiptId(savedReceiptId);
      await uploadPhoto(savedReceiptId);

      if (finalize) {
        const finalizeResponse = await fetch("/api/household", {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ action: "finalize_receipt", receiptId: savedReceiptId }),
        });
        const finalizedBody = await responseJson(
          finalizeResponse,
          "The draft was saved, but the receipt could not be finalized.",
        );
        if (finalizedBody.closedLoop && typeof finalizedBody.closedLoop === "object") {
          setWorkingClosedLoop(finalizedBody.closedLoop as ClosedLoopSnapshot);
        }
        await onRefresh();
        setSavedMessage("Receipt checked and linked to the saved trip.");
        setStep("bridge");
      } else {
        await onRefresh();
        setSavedMessage("Needs-review draft saved. You can safely finish the check later.");
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "The receipt draft could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  const planningWithoutFreeze = tripStatus === "planning";
  const receiptStored = Boolean(receiptId);

  return (
    <div
      className="receipt-flow-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialog}
        className="receipt-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-flow-title"
      >
        <header className="receipt-flow-header">
          <div>
            <p className="section-label">Weekly closed loop</p>
            <strong>Receipt → comparison → learning</strong>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="close-button"
            onClick={onClose}
            aria-label="Close receipt flow"
          >
            ×
          </button>
        </header>

        <ol className="receipt-flow-steps" aria-label="Receipt progress">
          <li className={step === "capture" ? "active" : "complete"}>
            <span>1</span> Add
          </li>
          <li className={step === "check" ? "active" : step === "bridge" ? "complete" : ""}>
            <span>2</span> Check
          </li>
          <li className={step === "bridge" ? "active" : ""}>
            <span>3</span> Compare
          </li>
        </ol>

        {step === "capture" ? (
          <div className="receipt-flow-body capture-step">
            <div className="receipt-step-heading">
              <p className="section-label">Add today’s receipt</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                Take a clear photo
              </h2>
              <p>
                Text is drafted on this device. The photo is uploaded privately only after
                you save the structured receipt.
              </p>
            </div>

            {planningWithoutFreeze ? (
              <div className="receipt-flow-note warning" role="note">
                <strong>No saved pre-trip plan</strong>
                <p>
                  You can continue, but BasketSense can only compare against the current
                  list, so intent evidence will be weaker.
                </p>
              </div>
            ) : null}

            <label className="receipt-photo-picker">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={choosePhoto}
                aria-label="Take or choose a Costco receipt photo"
              />
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- local camera preview uses a temporary blob URL
                <img src={previewUrl} alt="Preview of the selected Costco receipt" />
              ) : (
                <span aria-hidden="true">▣</span>
              )}
              <strong>{previewUrl ? "Choose a different photo" : "Take receipt photo"}</strong>
              <small>Camera or photo library · JPG, PNG, or HEIC when supported</small>
            </label>

            {ocrStatus ? (
              <div className="ocr-progress" role="status" aria-live="polite">
                <div>
                  <strong>{ocrStatus}</strong>
                  <span>{Math.round(ocrProgress * 100)}%</span>
                </div>
                <progress value={ocrProgress} max={1} aria-label="Receipt drafting progress" />
                <small>Drafted on this device — check before saving.</small>
              </div>
            ) : null}

            {ocrError ? <div className="receipt-flow-error" role="alert">{ocrError}</div> : null}

            <details className="receipt-paste-fallback" open={Boolean(ocrError)}>
              <summary>Paste receipt text instead</summary>
              <label htmlFor="receipt-ocr-text">Receipt text</label>
              <textarea
                id="receipt-ocr-text"
                value={ocrText}
                onChange={(event) => setOcrText(event.target.value)}
                placeholder="Paste text copied from a receipt PDF, photo, or scanner…"
              />
              <button
                type="button"
                className="secondary-button"
                disabled={!ocrText.trim()}
                onClick={() => applyParsedText(ocrText)}
              >
                Draft from pasted text
              </button>
            </details>

            <div className="receipt-flow-actions split">
              <button type="button" className="text-button" onClick={() => setStep("check")}>
                Enter manually
              </button>
              <button type="button" className="secondary-button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {step === "check" ? (
          <div className="receipt-flow-body check-step">
            <div className="receipt-step-heading">
              <p className="section-label">Quick receipt check</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                Check the numbers, not every character
              </h2>
              <p>Drafted on this device — check before saving. Correct only what affects the receipt record.</p>
            </div>

            <div className="receipt-total-fields">
              <label>
                <span>Purchased</span>
                <input
                  type="date"
                  value={draft.purchasedOn}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, purchasedOn: event.target.value }))
                  }
                />
              </label>
              {(
                [
                  ["subtotal", "Subtotal"],
                  ["discount", "Discounts"],
                  ["tax", "Tax"],
                  ["total", "Total"],
                ] as const
              ).map(([field, label]) => (
                <label key={field}>
                  <span>{label}</span>
                  <span className="money-input">
                    <span aria-hidden="true">$</span>
                    <input
                      inputMode="decimal"
                      aria-label={`${label} in dollars`}
                      value={draft[field]}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [field]: event.target.value }))
                      }
                      placeholder="0.00"
                    />
                  </span>
                </label>
              ))}
            </div>

            <div className="draft-lines-heading">
              <div>
                <h3>Receipt lines</h3>
                <p>Abbreviations are okay. Fix the product number, description, or amount only when needed.</p>
              </div>
              <button
                type="button"
                className="add-button"
                onClick={() =>
                  setDraft((current) => ({ ...current, items: [...current.items, blankLine()] }))
                }
              >
                + Add line
              </button>
            </div>

            <div className="draft-lines">
              {draft.items.map((item, index) => (
                <div className="draft-line" key={item.clientId}>
                  <span className="draft-line-number" aria-hidden="true">{index + 1}</span>
                  <label className="draft-item-number">
                    <span>Item #</span>
                    <input
                      inputMode="numeric"
                      value={item.itemNumber}
                      onChange={(event) => updateLine(item.clientId, "itemNumber", event.target.value)}
                      aria-label={`Line ${index + 1} Costco item number`}
                    />
                  </label>
                  <label className="draft-description">
                    <span>Description</span>
                    <input
                      value={item.description}
                      onChange={(event) => updateLine(item.clientId, "description", event.target.value)}
                      aria-label={`Line ${index + 1} description`}
                    />
                  </label>
                  <label className="draft-amount">
                    <span>Amount</span>
                    <span className="money-input">
                      <span aria-hidden="true">$</span>
                      <input
                        inputMode="decimal"
                        value={item.amount}
                        onChange={(event) => updateLine(item.clientId, "amount", event.target.value)}
                        aria-label={`Line ${index + 1} amount in dollars`}
                      />
                    </span>
                  </label>
                  <button
                    type="button"
                    className="delete-line-button"
                    onClick={() => deleteLine(item.clientId)}
                    aria-label={`Delete line ${index + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div
              className={`reconciliation-card ${canFinalize ? "trusted" : "needs-review"}`}
              role="status"
            >
              <span className="reconciliation-mark" aria-hidden="true">
                {canFinalize ? "✓" : "!"}
              </span>
              <div>
                <strong>
                  {canFinalize
                    ? "Receipt arithmetic checks out"
                    : !hasRequiredReceiptValues
                      ? "Add the subtotal, total, and at least one line"
                      : `${money.format(arithmetic.differenceCents / 100)} still needs a look`}
                </strong>
                <p>
                  Lines {money.format(arithmetic.itemNetCents / 100)} · subtotal difference {money.format(Math.abs(arithmetic.subtotalDeltaCents) / 100)} · total difference {money.format(Math.abs(arithmetic.totalDeltaCents) / 100)}
                </p>
              </div>
            </div>

            {savedMessage ? <div className="receipt-flow-success" role="status">{savedMessage}</div> : null}
            {saveError ? <div className="receipt-flow-error" role="alert">{saveError}</div> : null}
            {photoError ? (
              <div className="receipt-flow-note warning" role="alert">
                <strong>Structured receipt saved</strong>
                <p>{photoError}</p>
                {receiptId && photo ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving}
                    onClick={() => void uploadPhoto(receiptId)}
                  >
                    Retry photo storage
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="receipt-flow-actions">
              <button type="button" className="text-button" onClick={() => setStep("capture")}>
                Back
              </button>
              {!canFinalize ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || !hasAnyDraftData}
                  onClick={() => void saveDraft(false)}
                >
                  {saving ? "Saving…" : receiptStored ? "Update needs-review draft" : "Save needs-review draft"}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-button"
                disabled={saving || !canFinalize}
                onClick={() => void saveDraft(true)}
              >
                {saving ? "Saving…" : "Save & compare"}
              </button>
            </div>
            {!canFinalize ? (
              <p className="finalize-help">Trusted comparison unlocks when both differences are within $0.05.</p>
            ) : null}
          </div>
        ) : null}

        {step === "bridge" ? (
          <div className="receipt-flow-body bridge-step">
            <div className="receipt-step-heading">
              <p className="section-label">Expected → actual</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                What changed at checkout
              </h2>
              <p>This is a factual comparison with the saved list—not a score for the trip.</p>
            </div>
            {savedMessage ? <div className="receipt-flow-success" role="status">{savedMessage}</div> : null}
            {workingClosedLoop?.comparison ? (
              <ExpectedActualBridge
                comparison={workingClosedLoop.comparison}
                receiptItems={workingClosedLoop.items ?? []}
              />
            ) : (
              <div className="receipt-flow-note">
                <strong>Receipt saved</strong>
                <p>The comparison is still being prepared. Close and reopen Review after the shared household refreshes.</p>
              </div>
            )}
            <div className="receipt-flow-actions end">
              <button type="button" className="secondary-button" onClick={() => setStep("check")}>
                Recheck receipt
              </button>
              <button type="button" className="primary-button" onClick={onOpenReview}>
                Continue to trip review
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function ExpectedActualBridge({
  comparison,
  receiptItems = [],
}: {
  comparison: ClosedLoopComparison;
  receiptItems?: ClosedLoopReceiptItem[];
}) {
  const buckets = normalizeBuckets(comparison, receiptItems);
  const unresolvedCents = Math.abs(comparison.unresolvedCents ?? 0);
  const provisional = comparison.isProvisional || unresolvedCents > 5;
  const bridgeRows = [
    ["Saved-list estimate", comparison.frozenEstimateCents],
    ["Matched price or quantity change", comparison.matchedVarianceCents],
    ["Saved-list items without estimates", comparison.unpricedPlannedActualCents],
    ["Added during trip or not on saved list", comparison.additionsCents],
    ["Saved-list items not found", comparison.skippedEstimateCents === null || comparison.skippedEstimateCents === undefined ? null : -Math.abs(comparison.skippedEstimateCents)],
    ["Discounts", comparison.discountsCents === null || comparison.discountsCents === undefined ? null : -Math.abs(comparison.discountsCents)],
    ["Tax", comparison.taxCents],
  ] as const;

  return (
    <div className="expected-actual">
      <div className="bridge-totals">
        <div>
          <span>Expected</span>
          <strong>{money.format((comparison.frozenEstimateCents ?? 0) / 100)}</strong>
          <small>Saved-list estimate</small>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <span>Actual</span>
          <strong>{money.format((comparison.actualTotalCents ?? 0) / 100)}</strong>
          <small>Receipt total</small>
        </div>
        <span className={`comparison-status ${provisional ? "provisional" : "trusted"}`}>
          {provisional ? "Provisional" : "Reconciled"}
        </span>
      </div>

      <dl className="bridge-ledger">
        {bridgeRows.map(([label, value]) =>
          value === null || value === undefined ? null : (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={value < 0 ? "negative" : value > 0 ? "positive" : ""}>
                {value > 0 && label !== "Saved-list estimate" ? "+" : ""}
                {money.format(value / 100)}
              </dd>
            </div>
          ),
        )}
      </dl>

      {buckets.length ? (
        <div className="comparison-buckets">
          <h3>Item comparison</h3>
          {buckets.map((bucket) => (
            <details key={bucket.key} className="comparison-bucket">
              <summary>
                <span>
                  <strong>{bucket.label}</strong>
                  <small>{bucket.itemCount} {bucket.itemCount === 1 ? "item" : "items"}</small>
                </span>
                <span>{money.format(bucket.amountCents / 100)}</span>
              </summary>
              {bucket.items.length ? (
                <ul>
                  {bucket.items.map((item, index) => (
                    <li key={`${item.label ?? "item"}-${index}`}>
                      <span>{item.label ?? "Receipt item"}</span>
                      {item.amountCents === null || item.amountCents === undefined ? null : (
                        <strong>{money.format(item.amountCents / 100)}</strong>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No line-level detail is available for this bucket yet.</p>
              )}
            </details>
          ))}
        </div>
      ) : null}

      {provisional ? (
        <div className="receipt-flow-note warning" role="note">
          <strong>{money.format(unresolvedCents / 100)} unresolved</strong>
          <p>Insights stay provisional until this amount is matched or corrected.</p>
        </div>
      ) : null}
    </div>
  );
}

export function ClosedLoopReview({
  closedLoop,
  connected,
  onOpenReceipt,
  onRefresh,
}: {
  closedLoop?: ClosedLoopSnapshot | null;
  connected: boolean;
  onOpenReceipt: (step?: ReceiptStep) => void;
  onRefresh: () => Promise<void>;
}) {
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const receipt = closedLoop?.receipt;
  const questions = (closedLoop?.questions ?? []).slice(0, 3);
  const openQuestions = questions.filter(
    (question) =>
      !["answered", "resolved", "skipped", "dismissed"].includes(
        question.status ?? "open",
      ),
  );
  const resolvedQuestions = questions.filter((question) => !openQuestions.includes(question));
  const provisional = closedLoop?.comparison?.isProvisional;
  const uploadStored = ["stored", "uploaded", "complete"].includes(
    closedLoop?.upload?.status ?? "",
  );

  async function answer(question: ClosedLoopQuestion, value: string) {
    setAnsweringId(question.id);
    setAnswerError(null);
    try {
      const response = await fetch("/api/household", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "answer_review_question",
          questionId: question.id,
          value,
        }),
      });
      await responseJson(response, "That answer could not be saved.");
      await onRefresh();
    } catch (error) {
      setAnswerError(error instanceof Error ? error.message : "That answer could not be saved.");
    } finally {
      setAnsweringId(null);
    }
  }

  return (
    <div className="closed-loop-review">
      <section className="review-section" aria-labelledby="receipt-check-title">
        <div className="review-section-heading">
          <span className="review-section-number" aria-hidden="true">1</span>
          <div>
            <p className="section-label">Data correctness</p>
            <h2 id="receipt-check-title">Receipt check</h2>
            <p>First confirm what the receipt says. Household meaning comes after.</p>
          </div>
        </div>

        {receipt ? (
          <article className="receipt-check-card card">
            <div className="receipt-check-status">
              <span className={provisional ? "needs-review" : "trusted"} aria-hidden="true">
                {provisional ? "!" : "✓"}
              </span>
              <div>
                <strong>{provisional ? "Receipt needs a quick check" : "Receipt arithmetic checked"}</strong>
                <p>
                  {money.format((receipt.totalCents ?? 0) / 100)} total
                  {uploadStored ? " · original photo stored privately" : " · structured receipt saved"}
                </p>
              </div>
            </div>
            <button type="button" className="secondary-button" onClick={() => onOpenReceipt("check")}>
              Open receipt check
            </button>
          </article>
        ) : (
          <article className="receipt-check-card card empty">
            <div>
              <strong>No receipt linked to this trip yet</strong>
              <p>Add the photo, check the arithmetic, and BasketSense will build the comparison.</p>
            </div>
            <button type="button" className="primary-button" onClick={() => onOpenReceipt("capture")}>
              Add today’s receipt
            </button>
          </article>
        )}
      </section>

      {closedLoop?.comparison ? (
        <section className="review-section" aria-labelledby="comparison-title">
          <div className="review-section-heading">
            <span className="review-section-number" aria-hidden="true">2</span>
            <div>
              <p className="section-label">Saved plan + receipt</p>
              <h2 id="comparison-title">Expected → actual</h2>
              <p>Neutral facts first. No receipt-only item is labeled impulsive.</p>
            </div>
          </div>
          <article className="card review-bridge-card">
            <ExpectedActualBridge
              comparison={closedLoop.comparison}
              receiptItems={closedLoop.items ?? []}
            />
          </article>
        </section>
      ) : null}

      <section className="review-section" aria-labelledby="trip-review-title">
        <div className="review-section-heading">
          <span className="review-section-number" aria-hidden="true">3</span>
          <div>
            <p className="section-label">Household meaning</p>
            <h2 id="trip-review-title">Trip review</h2>
            <p>Up to three questions, only when an answer changes the record, an insight, or a future list.</p>
          </div>
        </div>

        {!receipt ? (
          <div className="receipt-flow-note">
            <strong>Receipt check comes first</strong>
            <p>Evidence-triggered questions appear after a receipt is linked to this trip.</p>
          </div>
        ) : openQuestions.length ? (
          <div className="evidence-questions">
            {openQuestions.map((question, index) => (
              <article className="evidence-question card" key={question.id}>
                <div className="question-heading">
                  <span>Question {index + 1} of {openQuestions.length}</span>
                  <span>{question.purpose ?? "Trip context"}</span>
                </div>
                <h3>{question.prompt}</h3>
                <div className="question-options">
                  {question.options.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      disabled={!connected || answeringId === question.id}
                      onClick={() => void answer(question, option.value)}
                    >
                      <strong>{option.label}</strong>
                      {option.effect ? <small>This will {option.effect}</small> : null}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="skip-question"
                    disabled={!connected || answeringId === question.id}
                    onClick={() => void answer(question, "skip")}
                  >
                    <strong>Skip</strong>
                    <small>This will leave the current evidence unchanged.</small>
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="review-complete-card card" role="status">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>No useful weekly questions right now</strong>
              <p>Silence is intentional—BasketSense asks only when your answer has somewhere to go.</p>
            </div>
          </div>
        )}
        {answerError ? <div className="receipt-flow-error" role="alert">{answerError}</div> : null}

        {resolvedQuestions.length ? (
          <div className="resolved-review-answers">
            <h3>What your answers changed</h3>
            {resolvedQuestions.map((question) => {
              const selected = question.options.find(
                (option) => option.value === question.selectedValue,
              );
              return (
                <div key={question.id}>
                  <span aria-hidden="true">✓</span>
                  <p>
                    <strong>
                      {selected?.label ??
                        (["skipped", "dismissed"].includes(question.status ?? "")
                          ? "Skipped"
                          : "Answered")}
                    </strong>
                    <small>
                      {selected?.effect
                        ? `Changed: ${selected.effect}`
                        : question.effectTarget
                          ? `Updated ${question.effectTarget}`
                          : "The answer is stored with this trip."}
                    </small>
                  </p>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <aside className="ritual-guardrail">
        <strong>Monthly ritual check, not a weekly chore</strong>
        <p>Once a month, BasketSense can ask whether Costco still feels enjoyable and easy. It does not use that answer to judge a single cart.</p>
      </aside>
    </div>
  );
}
