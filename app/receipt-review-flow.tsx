"use client";

import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { reconcileReceipt } from "./receipt-logic";
import {
  PRODUCT_CATEGORY_PRESENTATION,
  type ProductCategoryKey,
} from "./product-categories";

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
  kind?: "item" | "discount";
  taxStatus?: "taxable" | "non_taxable" | "unknown" | null;
  productId?: string | null;
  canonicalName?: string | null;
  category?: ProductCategoryKey | null;
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
  receiptItemId?: string | null;
};

export type ClosedLoopComparison = {
  isProvisional?: boolean;
  isTotalsOnly?: boolean;
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

type SpotlightItem = {
  label?: string;
  amountCents?: number | null;
  note?: string;
};

type SpotlightBucket = {
  key: string;
  label: string;
  amountCents: number;
  itemCount: number;
  items: SpotlightItem[];
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

export type ReceiptDraftLine = {
  clientId: string;
  itemNumber: string;
  description: string;
  amount: string;
  quantityMilli: number;
  unitPriceCents: number | null;
  discountCents: number;
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

// The shared-site request gateway rejects multipart bodies just over 3 MB before
// the receipt route can apply its own 8 MB validation. Keep camera photos below
// that gateway limit while preserving a comfortably readable receipt image.
const LIVE_UPLOAD_SAFE_BYTES = 2 * 1024 * 1024;
const UPLOAD_IMAGE_MAX_EDGE = 2_000;

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

function bucketSpotlightCopy(key: string) {
  switch (key.toLowerCase()) {
    case "matched":
    case "planned_and_purchased":
      return "These receipt lines connect back to the saved list.";
    case "missing":
    case "planned_not_purchased":
    case "skippedplanned":
      return "These saved-list items do not appear on this receipt.";
    case "in_store":
    case "added_during_trip":
    case "receipt_only":
    case "receiptonly":
    case "unplanned":
      return "These receipt lines were not matched to a saved-list item.";
    case "substitution":
    case "possiblesubstitutions":
      return "These lines may be a substitution and are kept separate until confirmed.";
    case "unresolved":
      return "These receipt lines still need a quick check before the recap becomes final.";
    case "discounts":
      return "Each card shows the receipt item that received a Costco discount.";
    default:
      return "These are the receipt lines behind this part of the trip.";
  }
}

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

function compressedReceiptFilename(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, "").trim() || "costco-receipt";
  return `${stem}.jpg`;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

async function prepareReceiptUpload(file: File) {
  const contentType = file.type.toLowerCase();
  if (
    !new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ]).has(contentType)
  ) {
    return file;
  }

  try {
    const source = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const longestEdge = Math.max(source.width, source.height);
      if (file.size <= LIVE_UPLOAD_SAFE_BYTES && longestEdge <= UPLOAD_IMAGE_MAX_EDGE) {
        return file;
      }
      const scale = Math.min(1, UPLOAD_IMAGE_MAX_EDGE / longestEdge);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const initial = await canvasToJpeg(canvas, 0.82);
      const compressed =
        initial && initial.size > LIVE_UPLOAD_SAFE_BYTES
          ? await canvasToJpeg(canvas, 0.68)
          : initial;
      if (!compressed || compressed.size >= file.size) return file;
      return new File([compressed], compressedReceiptFilename(file.name), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      });
    } finally {
      source.close();
    }
  } catch {
    // Browsers that cannot decode a selected image keep the original upload path.
    return file;
  }
}

function blankLine(): ReceiptDraftLine {
  return {
    clientId: clientId(),
    itemNumber: "",
    description: "",
    amount: "",
    quantityMilli: 1000,
    unitPriceCents: null,
    discountCents: 0,
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
          discountCents: Math.max(0, item.discountCents ?? 0),
          kind:
            item.kind ??
            ((item.discountCents ?? 0) > 0 &&
            (item.lineSubtotalCents ?? 0) <= 0 &&
            (item.netAmountCents ?? 0) < 0
              ? "discount"
              : "item"),
          taxStatus: item.taxStatus ?? "unknown",
        }))
      : [blankLine()],
  } satisfies ReceiptDraft;
}

export function draftFromParser(value: unknown): ReceiptDraft {
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
    discountCents: Math.max(0, item.discountCents ?? 0),
    kind:
      item.kind ??
      ((item.discountCents ?? 0) > 0 &&
      (item.lineSubtotalCents ?? 0) <= 0 &&
      (item.netAmountCents ?? item.lineSubtotalCents ?? 0) < 0
        ? "discount"
        : "item"),
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

export function receiptDraftLineValue(item: ReceiptDraftLine, index: number) {
  const amountCents = inputToCents(item.amount);
  const looksLikeDiscount =
    item.kind === "discount" ||
    (amountCents < 0 &&
      /coupon|discount|rebate|savings|instant|^\s*\d+\s*\/\s*\d+\s*$/i.test(
        item.description,
      ));
  const discountCents = looksLikeDiscount
    ? Math.abs(amountCents)
    : Math.max(0, item.discountCents);
  return {
    sourceLineNumber: index + 1,
    costcoItemNumber: item.itemNumber.trim() || undefined,
    rawDescription: item.description.trim() || "Unlabeled receipt line",
    quantityMilli: item.quantityMilli,
    unitPriceCents: item.unitPriceCents,
    lineSubtotalCents: looksLikeDiscount ? 0 : amountCents + discountCents,
    netAmountCents: looksLikeDiscount ? -discountCents : amountCents,
    discountCents,
    taxStatus: item.taxStatus,
    kind: looksLikeDiscount ? ("discount" as const) : ("item" as const),
  };
}

function hasMeaningfulDraftData(draft: ReceiptDraft) {
  return Boolean(
    draft.subtotal.trim() ||
      draft.tax.trim() ||
      draft.total.trim() ||
      draft.discount.trim() ||
      draft.items.some((item) => item.itemNumber.trim() || item.description.trim() || item.amount.trim()),
  );
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

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        "Saving took too long. Your receipt is still on this screen—check your connection and retry.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
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
          label: item.rawDescription ?? item.canonicalName ?? item.description ?? "Receipt item",
          amountCents: item.netAmountCents ?? item.lineSubtotalCents ?? null,
          note:
            item.netAmountCents === null || item.netAmountCents === undefined
              ? undefined
              : item.discountCents
                ? `Paid ${money.format(item.netAmountCents / 100)} after Costco savings`
                : `Paid ${money.format(item.netAmountCents / 100)} on this receipt`,
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
            : "Add a photo or Costco PDF, check the draft, then see what changed from the saved list."}
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
  sandboxMode = false,
  onReopenSandboxTrip,
}: {
  open: boolean;
  initialStep?: ReceiptStep;
  tripId: string | null;
  tripStatus: "planning" | "frozen" | "completed" | null;
  closedLoop?: ClosedLoopSnapshot | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenReview: () => void;
  sandboxMode?: boolean;
  onReopenSandboxTrip?: (receiptId: string, tripId: string) => Promise<boolean>;
}) {
  const [step, setStep] = useState<ReceiptStep>(initialStep);
  const [workingClosedLoop, setWorkingClosedLoop] =
    useState<ClosedLoopSnapshot | null>(closedLoop ?? null);
  const [draft, setDraft] = useState<ReceiptDraft>(() =>
    draftFromClosedLoop(closedLoop),
  );
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [receiptIngestionId, setReceiptIngestionId] = useState<string | null>(null);
  const [pollReceiptIngestion, setPollReceiptIngestion] = useState(false);
  const [pendingParsedDraft, setPendingParsedDraft] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(
    closedLoop?.receipt?.id ?? null,
  );
  const [draftRequestId, setDraftRequestId] = useState(clientId);
  const wasOpen = useRef(false);
  const appliedIngestionDraftId = useRef<string | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const stepHeading = useRef<HTMLHeadingElement | null>(null);
  const cameraPicker = useRef<HTMLInputElement | null>(null);
  const libraryPicker = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setReceiptFile(null);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      setOcrStatus(null);
      setOcrProgress(0);
      setOcrError(null);
      setReceiptIngestionId(null);
      setPollReceiptIngestion(false);
      setPendingParsedDraft(null);
      appliedIngestionDraftId.current = null;
      setStep(initialStep);
      setWorkingClosedLoop(closedLoop ?? null);
      setDraft(draftFromClosedLoop(closedLoop));
      setReceiptId(closedLoop?.receipt?.id ?? null);
      setDraftRequestId(clientId());
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
    if (!open || !receiptIngestionId || !pollReceiptIngestion) return;
    let cancelled = false;
    let timer: number | null = null;

    const readStatus = async () => {
      try {
        const response = await fetchWithTimeout(
          `/api/receipt-ingestion?id=${encodeURIComponent(receiptIngestionId)}${sandboxMode ? "&sandbox=1" : ""}`,
          { method: "GET" },
          12_000,
        );
        const body = await responseJson(response, "Could not check the receipt reader.");
        if (cancelled || !body.ingestion || typeof body.ingestion !== "object") return;
        const ingestion = body.ingestion as {
          status?: unknown;
          error?: unknown;
          draft?: unknown;
        };
        const status = typeof ingestion.status === "string" ? ingestion.status : "uploaded";
        if (status === "awaiting_review" && ingestion.draft && typeof ingestion.draft === "object") {
          if (appliedIngestionDraftId.current === receiptIngestionId) return;
          setOcrProgress(1);
          setOcrError(null);
          if (hasMeaningfulDraftData(draft)) {
            setPendingParsedDraft(ingestion.draft);
            setOcrStatus("Draft ready — your edits are still in place");
          } else {
            setDraft(draftFromParser(ingestion.draft));
            appliedIngestionDraftId.current = receiptIngestionId;
            setPendingParsedDraft(null);
            setOcrStatus("Draft ready to check");
            setStep("check");
          }
          return;
        }
        if (status === "failed") {
          setOcrProgress(0);
          setOcrStatus(null);
          setOcrError(
            typeof ingestion.error === "string" && ingestion.error
              ? `The receipt reader needs another try: ${ingestion.error}`
              : "The receipt reader could not finish. Your private upload is saved; enter totals now and try a clearer photo or PDF later.",
          );
          return;
        }
        setOcrProgress(status === "extracting" ? 0.72 : 0.42);
        setOcrStatus(status === "extracting" ? "Reading your receipt in the background" : "Receipt saved — starting the reader");
        timer = window.setTimeout(readStatus, 2_500);
      } catch (error) {
        if (cancelled) return;
        setOcrProgress(0);
        setOcrStatus(null);
        setOcrError(
          error instanceof Error
            ? `${error.message} Your private upload is safe; enter totals now and try again later if needed.`
            : "We could not check the receipt reader. Your private upload is safe; enter totals now and try again later if needed.",
        );
      }
    };

    void readStatus();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [draft, open, pollReceiptIngestion, receiptIngestionId]);

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
        .map(receiptDraftLineValue),
      subtotalCents: inputToCents(draft.subtotal),
      taxCents: inputToCents(draft.tax),
      totalCents: inputToCents(draft.total),
      discountCents: Math.abs(inputToCents(draft.discount)),
      captureMode:
        draft.items.some((item) => item.description.trim() || item.amount.trim())
          ? ("itemized" as const)
          : ("totals_only" as const),
    }),
    [draft],
  );

  const arithmetic = useMemo(() => {
    const totalsOnly = values.captureMode === "totals_only";
    const fallbackItemNetCents = values.items.reduce(
      (sum, item) => sum + item.lineSubtotalCents,
      0,
    );
    const fallbackSubtotalDeltaCents =
      totalsOnly ? 0 : fallbackItemNetCents - values.subtotalCents;
    const fallbackTotalDeltaCents =
      values.subtotalCents + values.taxCents - values.totalCents;
    try {
      const result = reconcileReceipt({ ...values, totalsOnly }) as unknown as {
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
    Boolean(draft.subtotal.trim()) && Boolean(draft.total.trim());
  const canFinalize = hasRequiredReceiptValues && arithmetic.isReconciled;
  const hasAnyDraftData = Boolean(
    receiptFile ||
      draft.subtotal.trim() ||
      draft.total.trim() ||
      draft.items.some((item) => item.description.trim() || item.amount.trim()),
  );

  if (!open) return null;

  function cancelReceiptOcr() {
    if (!receiptIngestionId) setOcrStatus(null);
  }

  async function startReceiptIngestion(file: File) {
    if (!tripId) {
      setOcrError("The shared trip is not ready yet. Refresh the list, then try the receipt again.");
      return;
    }
    setOcrError(null);
    setPendingParsedDraft(null);
    setOcrStatus("Saving and reading your receipt privately");
    setOcrProgress(0.16);
    try {
      const uploadFile = await prepareReceiptUpload(file);
      const form = new FormData();
      form.append("file", uploadFile);
      form.append("tripId", tripId);
      form.append("clientRequestId", clientId());
      if (sandboxMode) form.append("sandbox", "1");
      const response = await fetchWithTimeout(
        "/api/receipt-ingestion",
        { method: "POST", body: form },
        105_000,
      );
      const body = await responseJson(
        response,
        response.status === 413
          ? "This live site needs a smaller receipt upload. For a photo, try a clearer close-up or a file under 2 MB."
          : "The receipt could not be saved for review.",
      );
      const ingestion = body.ingestion as {
        id?: unknown;
        status?: unknown;
        error?: unknown;
        draft?: unknown;
      } | undefined;
      if (!ingestion || typeof ingestion.id !== "string") {
        throw new Error("The receipt saved without a usable review ID.");
      }
      setReceiptIngestionId(ingestion.id);
      setPollReceiptIngestion(body.queued === true);
      const status = typeof ingestion.status === "string" ? ingestion.status : "uploaded";
      if (status === "awaiting_review" && ingestion.draft && typeof ingestion.draft === "object") {
        setOcrProgress(1);
        if (hasMeaningfulDraftData(draft)) {
          setPendingParsedDraft(ingestion.draft);
          setOcrStatus("Draft ready — your edits are still in place");
        } else {
          setDraft(draftFromParser(ingestion.draft));
          appliedIngestionDraftId.current = ingestion.id;
          setOcrStatus("Receipt read — check the totals and items");
        }
      } else if (status === "failed") {
        setOcrProgress(0);
        setOcrStatus(null);
        setOcrError(
          typeof ingestion.error === "string" && ingestion.error
            ? `The receipt reader needs another try: ${ingestion.error}`
            : "The receipt reader could not finish. Your private upload is saved; enter totals now and try a clearer photo or PDF later.",
        );
      } else {
        setOcrProgress(0.34);
        if (body.configurationMissing === true) {
          setOcrStatus("Receipt saved — enter totals while automatic reading is being connected");
        } else if (body.queued === true) {
          setOcrStatus("Receipt saved — reading in the background");
        } else {
          setOcrStatus("Receipt saved — reading will resume when available");
        }
      }
      setStep("check");
    } catch (error) {
      setOcrStatus(null);
      setOcrError(
        error instanceof Error
          ? `${error.message} Your receipt is still on this screen—enter the printed totals if you want to continue now.`
          : "The receipt could not be saved for review. Your receipt is still on this screen—enter the printed totals if you want to continue now.",
      );
    }
  }

  function chooseReceiptFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    // Clearing the native picker lets someone reselect the same saved receipt.
    event.target.value = "";
    cancelReceiptOcr();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const nextPreview = file.type.toLowerCase().startsWith("image/")
      ? URL.createObjectURL(file)
      : null;
    setReceiptFile(file);
    setPreviewUrl(nextPreview);
    setPhotoError(null);
    setReceiptIngestionId(null);
    setPollReceiptIngestion(false);
    appliedIngestionDraftId.current = null;
    void startReceiptIngestion(file);
  }

  function updateLine(id: string, field: "itemNumber" | "description" | "amount", value: string) {
    cancelReceiptOcr();
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.clientId === id ? { ...item, [field]: value } : item,
      ),
    }));
  }

  function updateLineKind(id: string, kind: ReceiptDraftLine["kind"]) {
    cancelReceiptOcr();
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.clientId === id ? { ...item, kind, discountCents: 0 } : item,
      ),
    }));
  }

  function deleteLine(id: string) {
    cancelReceiptOcr();
    setDraft((current) => {
      const items = current.items.filter((item) => item.clientId !== id);
      return { ...current, items: items.length ? items : [blankLine()] };
    });
  }

  async function uploadReceiptFile(savedReceiptId: string) {
    if (!receiptFile) return true;
    const form = new FormData();
    form.append("receiptId", savedReceiptId);
    form.append("file", receiptFile);
    if (sandboxMode) form.append("sandbox", "1");
    try {
      const response = await fetchWithTimeout("/api/receipt-photo", {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setPhotoError(
          body?.error ??
            "The structured receipt was saved, but private receipt storage needs a retry.",
        );
        return false;
      }
      setPhotoError(null);
      return true;
    } catch (error) {
      setPhotoError(
        error instanceof Error
          ? `The structured receipt was saved, but the receipt file needs a retry: ${error.message}`
          : "The structured receipt was saved, but private receipt storage needs a retry.",
      );
      return false;
    }
  }

  async function linkIngestedReceiptFile(savedReceiptId: string) {
    if (!receiptIngestionId) return false;
    try {
      const response = await fetchWithTimeout("/api/receipt-ingestion", {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "link_receipt",
          ingestionId: receiptIngestionId,
          receiptId: savedReceiptId,
          sandbox: sandboxMode,
        }),
      });
      await responseJson(response, "The receipt record was saved, but its private file needs a retry.");
      setPhotoError(null);
      return true;
    } catch (error) {
      setPhotoError(
        error instanceof Error
          ? `The receipt record was saved, but private file linking needs a retry: ${error.message}`
          : "The receipt record was saved, but private file linking needs a retry.",
      );
      return false;
    }
  }

  async function saveDraft(finalize: boolean) {
    if (!tripId) {
      setSaveError("The shared trip is not available yet. Refresh and try again.");
      return;
    }
    if (!hasAnyDraftData) {
      setSaveError("Add a receipt file, total, or line item before saving a draft.");
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
      const response = await fetchWithTimeout("/api/household", {
        method: receiptId ? "PATCH" : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          clientDraftId: draftRequestId,
          receiptId,
          tripId,
          purchasedAt: draft.purchasedOn,
          sandbox: sandboxMode,
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
      const linked = await linkIngestedReceiptFile(savedReceiptId);
      const stored = linked || (await uploadReceiptFile(savedReceiptId));
      if (stored) {
        setReceiptFile(null);
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return null;
        });
      }

      if (finalize) {
        const finalizeResponse = await fetchWithTimeout("/api/household", {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "finalize_receipt",
            receiptId: savedReceiptId,
            sandbox: sandboxMode,
          }),
        });
        const finalizedBody = await responseJson(
          finalizeResponse,
          "The draft was saved, but the receipt could not be finalized.",
        );
        if (finalizedBody.closedLoop && typeof finalizedBody.closedLoop === "object") {
          setWorkingClosedLoop(finalizedBody.closedLoop as ClosedLoopSnapshot);
        }
        setSavedMessage("Receipt checked and linked to the saved trip.");
        setStep("bridge");
        void onRefresh().catch(() => undefined);
      } else {
        setSavedMessage("Needs-review draft saved. You can safely finish the check later.");
        void onRefresh().catch(() => undefined);
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "The receipt draft could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function reopenSandboxTest() {
    const receipt = workingClosedLoop?.receipt;
    if (!receipt?.id || !receipt.tripId || !onReopenSandboxTrip) return;
    setSaving(true);
    setSaveError(null);
    try {
      const reopened = await onReopenSandboxTrip(receipt.id, receipt.tripId);
      if (!reopened) throw new Error("The sandbox test could not be reopened.");
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "The sandbox test could not be reopened.",
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
                Add a photo or Costco PDF
              </h2>
              <p>
                BasketSense saves the original privately, then reads it in the background.
                You can confirm the printed totals while it works.
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

            <div className="receipt-photo-picker">
              <input
                ref={cameraPicker}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={chooseReceiptFile}
                aria-label="Take a Costco receipt photo"
              />
              <input
                ref={libraryPicker}
                type="file"
                accept="image/*,application/pdf"
                onChange={chooseReceiptFile}
                aria-label="Choose a Costco receipt photo or PDF from your library"
              />
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- local camera preview uses a temporary blob URL
                <img src={previewUrl} alt="Preview of the selected Costco receipt" />
              ) : (
                <span aria-hidden="true">{receiptFile?.type === "application/pdf" ? "PDF" : "▣"}</span>
              )}
              <strong>
                {receiptFile
                  ? receiptFile.type === "application/pdf"
                    ? receiptFile.name
                    : "Choose another receipt photo"
                  : "Add a receipt"}
              </strong>
              <small>Use your camera now, a saved photo, or Costco’s PDF when it appears later.</small>
              <div className="receipt-photo-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => cameraPicker.current?.click()}
                >
                  Take photo
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => libraryPicker.current?.click()}
                >
                  Choose photo or PDF
                </button>
              </div>
              <small>PDF, JPG, PNG, and WebP can be drafted automatically.</small>
            </div>

            {ocrStatus ? (
              <div className="ocr-progress" role="status" aria-live="polite">
                <div>
                  <strong>{ocrStatus}</strong>
                  <span>{Math.round(ocrProgress * 100)}%</span>
                </div>
                <progress value={ocrProgress} max={1} aria-label="Receipt drafting progress" />
                <small>Drafted securely — check the printed totals before saving.</small>
              </div>
            ) : null}

            {ocrError ? <div className="receipt-flow-error" role="alert">{ocrError}</div> : null}

            <div className="receipt-flow-actions split">
              <button type="button" className="primary-button" onClick={() => setStep("check")}>
                {receiptFile ? "Continue while it reads" : "Enter receipt totals"}
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
              <p className="section-label">Receipt confirmation</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                Confirm the receipt total
              </h2>
              <p>
                We use the printed numbers for exact spending. Product lines are optional
                and only power item-level learning when they are readable.
              </p>
            </div>

            {ocrStatus ? (
              <div className="ocr-progress" role="status" aria-live="polite">
                <div>
                  <strong>{ocrStatus}</strong>
                  <span>{Math.round(ocrProgress * 100)}%</span>
                </div>
                <progress value={ocrProgress} max={1} aria-label="Receipt drafting progress" />
                <small>Nothing has affected your spending history yet. Confirm the printed total to save it.</small>
              </div>
            ) : null}

            {ocrError ? <div className="receipt-flow-error" role="alert">{ocrError}</div> : null}

            {pendingParsedDraft ? (
              <div className="receipt-flow-note" role="status">
                <strong>We found the product lines.</strong>
                <p>Your totals and edits are unchanged. Use the draft only if you want to replace this screen with the receipt reader’s version.</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setDraft(draftFromParser(pendingParsedDraft));
                    appliedIngestionDraftId.current = receiptIngestionId;
                    setPendingParsedDraft(null);
                    setOcrStatus("Draft ready to check");
                  }}
                >
                  Use receipt draft
                </button>
              </div>
            ) : null}

            <div className="receipt-total-fields">
              <label>
                <span>Purchased</span>
                <input
                  type="date"
                  value={draft.purchasedOn}
                  onChange={(event) => {
                    cancelReceiptOcr();
                    setDraft((current) => ({ ...current, purchasedOn: event.target.value }));
                  }}
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
                      onChange={(event) => {
                        cancelReceiptOcr();
                        setDraft((current) => ({ ...current, [field]: event.target.value }));
                      }}
                      placeholder="0.00"
                    />
                  </span>
                </label>
              ))}
            </div>
            <p className="receipt-discount-help">
              Enter Discounts as a positive total. BasketSense subtracts each discount only
              once, whether it is a receipt total, a separate line, or attached to an item.
            </p>

            <details className="receipt-lines-disclosure">
              <summary>
                {values.items.length
                  ? `Review ${values.items.length} product lines (optional)`
                  : "Add product lines (optional)"}
              </summary>
              <p>
                Totals are enough to save an accurate trip. Product lines improve the item-level comparison and catalog only after you confirm them.
              </p>
              <div className="draft-lines-heading">
                <button
                  type="button"
                  className="add-button"
                  onClick={() => {
                    cancelReceiptOcr();
                    setDraft((current) => ({ ...current, items: [...current.items, blankLine()] }));
                  }}
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
                  <label className="draft-kind">
                    <span>Type</span>
                    <select
                      value={item.kind}
                      onChange={(event) =>
                        updateLineKind(
                          item.clientId,
                          event.target.value as ReceiptDraftLine["kind"],
                        )
                      }
                      aria-label={`Line ${index + 1} type`}
                    >
                      <option value="item">Product</option>
                      <option value="discount">Discount</option>
                    </select>
                  </label>
                  <label className="draft-amount">
                    <span>
                      {item.kind === "discount"
                        ? "Savings"
                        : item.discountCents > 0
                          ? `Paid (after ${money.format(item.discountCents / 100)} off)`
                          : "Amount"}
                    </span>
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
            </details>

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
                      ? "Add the subtotal and total"
                      : values.captureMode === "totals_only"
                        ? "Receipt totals check out"
                      : `${money.format(arithmetic.differenceCents / 100)} still needs a look`}
                </strong>
                <p>
                  {values.captureMode === "totals_only"
                    ? `Subtotal ${money.format(values.subtotalCents / 100)} · tax ${money.format(values.taxCents / 100)} · total ${money.format(values.totalCents / 100)}`
                    : `Lines ${money.format(arithmetic.itemNetCents / 100)} · subtotal difference ${money.format(Math.abs(arithmetic.subtotalDeltaCents) / 100)} · total difference ${money.format(Math.abs(arithmetic.totalDeltaCents) / 100)}`}
                </p>
              </div>
            </div>

            {savedMessage ? <div className="receipt-flow-success" role="status">{savedMessage}</div> : null}
            {saveError ? <div className="receipt-flow-error" role="alert">{saveError}</div> : null}
            {photoError ? (
              <div className="receipt-flow-note warning" role="alert">
                <strong>Structured receipt saved</strong>
                <p>{photoError}</p>
                {receiptId && receiptFile ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving}
                    onClick={() => void uploadReceiptFile(receiptId)}
                  >
                    Retry receipt storage
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="receipt-flow-actions">
              <button type="button" className="text-button" onClick={() => setStep("capture")}>
                Back
              </button>
              {sandboxMode && workingClosedLoop?.receipt?.id && workingClosedLoop.receipt.tripId ? (
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => void reopenSandboxTest()}
                >
                  Reopen this test
                </button>
              ) : null}
              {!canFinalize ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || !hasAnyDraftData}
                  onClick={() => void saveDraft(false)}
                >
                  {saving
                    ? "Saving…"
                    : receiptStored
                      ? "Update needs-review draft"
                      : hasRequiredReceiptValues
                        ? "Save needs-review draft"
                        : "Save receipt for later"}
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
              <p className="finalize-help">Save unlocks when the printed subtotal, tax, and total agree within $0.05.</p>
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
                onReviewReceipt={() => setStep("check")}
              />
            ) : (
              <div className="receipt-flow-note">
                <strong>Receipt saved</strong>
                <p>The comparison is still being prepared. Close and reopen Review after the shared household refreshes.</p>
              </div>
            )}
            {photoError ? (
              <div className="receipt-flow-note warning" role="alert">
                <strong>Receipt saved; original file still needs storage</strong>
                <p>{photoError}</p>
                {receiptId && receiptFile ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving}
                    onClick={() => void uploadReceiptFile(receiptId)}
                  >
                    Retry receipt storage
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="receipt-flow-actions end">
              {sandboxMode && workingClosedLoop?.receipt?.id && workingClosedLoop.receipt.tripId ? (
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => void reopenSandboxTest()}
                >
                  Reopen this test
                </button>
              ) : null}
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
  onReviewReceipt,
}: {
  comparison: ClosedLoopComparison;
  receiptItems?: ClosedLoopReceiptItem[];
  onReviewReceipt?: () => void;
}) {
  const buckets = normalizeBuckets(comparison, receiptItems);
  const totalsOnly = comparison.isTotalsOnly === true;
  const unresolvedCents = Math.abs(comparison.unresolvedCents ?? 0);
  const provisional = comparison.isProvisional || unresolvedCents > 5;
  const expectedCents = comparison.frozenEstimateCents ?? 0;
  const actualCents = comparison.actualTotalCents ?? 0;
  const totalDifferenceCents = actualCents - expectedCents;
  const hasSavedEstimate = comparison.frozenEstimateCents !== null && comparison.frozenEstimateCents !== undefined;
  const differenceDirection = totalDifferenceCents > 5 ? "above" : totalDifferenceCents < -5 ? "below" : "in line with";
  const drivers = [
    {
      key: "price-shifts",
      amountCents: comparison.matchedVarianceCents,
      label: "Prices or quantities shifted",
      detail: "The receipt did not match the saved estimates exactly.",
    },
    {
      key: "unpriced-planned",
      amountCents: comparison.unpricedPlannedActualCents,
      label: "Planned items without an estimate",
      detail: "These saved-list items could not be included in the original estimate.",
    },
    {
      key: "added",
      amountCents: comparison.additionsCents,
      label: "Picked up beyond the saved list",
      detail: "These receipt lines were not matched to a saved-list item.",
    },
    {
      key: "skipped",
      amountCents:
        comparison.skippedEstimateCents === null || comparison.skippedEstimateCents === undefined
          ? null
          : -Math.abs(comparison.skippedEstimateCents),
      label: "Left for another trip",
      detail: "These saved-list items do not appear on this receipt.",
    },
    {
      key: "discounts",
      amountCents:
        comparison.discountsCents === null || comparison.discountsCents === undefined
          ? null
          : -Math.abs(comparison.discountsCents),
      label: "Costco discounts",
      detail: "Savings shown on the receipt reduced the checkout total.",
    },
    {
      key: "tax",
      amountCents: comparison.taxCents,
      label: "Sales tax",
      detail: "Tax is part of checkout but not the saved-list estimate.",
    },
  ].filter(
    (driver): driver is { key: string; amountCents: number; label: string; detail: string } =>
      driver.amountCents !== null && driver.amountCents !== undefined && driver.amountCents !== 0,
  );
  const visibleBuckets: SpotlightBucket[] = buckets.filter(
    (bucket) => bucket.itemCount > 0 || bucket.items.length > 0 || bucket.amountCents !== 0,
  );
  const discountedItems = receiptItems
    .filter((item) => (item.discountCents ?? 0) > 0)
    .map((item) => {
      const discountCents = Math.abs(item.discountCents ?? 0);
      const netAmountCents = item.netAmountCents ?? item.lineSubtotalCents ?? null;
      return {
        label: item.canonicalName ?? item.rawDescription ?? item.description ?? "Receipt item",
        amountCents: -discountCents,
        note:
          netAmountCents === null
            ? undefined
            : `Paid ${money.format(netAmountCents / 100)} after savings`,
      } satisfies SpotlightItem;
    });
  const discountSpotlight: SpotlightBucket | null = discountedItems.length
    ? {
        key: "discounts",
        label: "Costco discounts",
        amountCents: -discountedItems.reduce(
          (sum, item) => sum + Math.abs(item.amountCents ?? 0),
          0,
        ),
        itemCount: discountedItems.length,
        items: discountedItems,
      }
    : null;
  const spotlightBuckets = discountSpotlight
    ? [...visibleBuckets, discountSpotlight]
    : visibleBuckets;
  const [spotlightBucket, setSpotlightBucket] = useState<SpotlightBucket | null>(null);
  const [spotlightIndex, setSpotlightIndex] = useState(0);
  const spotlightRef = useRef<HTMLDialogElement>(null);
  const spotlightItem = spotlightBucket?.items[spotlightIndex] ?? null;
  const spotlightItemCount = spotlightBucket?.items.length ?? 0;

  function signedMoney(value: number) {
    return `${value > 0 ? "+" : value < 0 ? "−" : ""}${money.format(Math.abs(value) / 100)}`;
  }

  function openSpotlight(bucket: SpotlightBucket) {
    setSpotlightBucket(bucket);
    setSpotlightIndex(0);
    window.requestAnimationFrame(() => {
      if (!spotlightRef.current?.open) spotlightRef.current?.showModal();
    });
  }

  function closeSpotlight() {
    if (spotlightRef.current?.open) spotlightRef.current.close();
    setSpotlightBucket(null);
  }

  function reviewReceiptLines() {
    closeSpotlight();
    onReviewReceipt?.();
  }

  function moveSpotlight(direction: -1 | 1) {
    if (!spotlightItemCount) return;
    setSpotlightIndex((current) => (current + direction + spotlightItemCount) % spotlightItemCount);
  }

  function spotlightForDriver(key: string) {
    if (key === "discounts") return discountSpotlight;
    const bucketKeys: Record<string, string[]> = {
      "price-shifts": ["matched", "planned_and_purchased"],
      "unpriced-planned": ["unpricedplanned"],
      added: ["in_store", "added_during_trip", "receipt_only", "receiptonly", "unplanned"],
      skipped: ["missing", "planned_not_purchased", "skippedplanned"],
    };
    const keys = bucketKeys[key] ?? [];
    return spotlightBuckets.find((bucket) => keys.includes(bucket.key.toLowerCase())) ?? null;
  }

  return (
    <div className="expected-actual trip-story">
      <header className="trip-story-intro">
        <div>
          <p className="section-label">Cart replay</p>
          <h3>
            {hasSavedEstimate
              ? `Checkout landed ${differenceDirection} your plan.`
              : "Your checkout story starts here."}
          </h3>
          <p>
            {hasSavedEstimate
              ? `${signedMoney(totalDifferenceCents)} from the saved estimate. The steps below show where that difference came from.`
              : "The receipt total is recorded. Add saved-list estimates to see how the plan and checkout compare."}
          </p>
        </div>
        <span className={`comparison-status ${provisional ? "provisional" : "trusted"}`}>
          {provisional ? "Needs one check" : "Receipt matched"}
        </span>
      </header>

      <div className="trip-story-totals" aria-label="Saved list compared with receipt total">
        <div className="trip-story-total planned">
          <span>Saved list</span>
          <strong>{money.format(expectedCents / 100)}</strong>
          <small>Before checkout changes</small>
        </div>
        <div className="trip-story-path" aria-hidden="true">
          <span className="trip-story-path-line" />
          <span className="trip-story-path-arrow">→</span>
        </div>
        <div className="trip-story-total actual">
          <span>Receipt total</span>
          <strong>{money.format(actualCents / 100)}</strong>
          <small>What Costco charged</small>
        </div>
      </div>

      {totalsOnly ? (
        <div className="receipt-flow-note warning" role="note">
          <strong>Exact total saved; products were not read</strong>
          <p>
            This trip updates spending exactly. Upload a clearer receipt file or add product
            lines later to unlock planned-versus-actual item insights.
          </p>
        </div>
      ) : (
        <section className="trip-story-drivers" aria-labelledby="story-drivers-title">
          <div className="trip-story-section-heading">
            <div>
              <p className="section-label">The why</p>
              <h4 id="story-drivers-title">What moved the total</h4>
            </div>
            <p>Each movement is tied to the saved list or a line on the receipt.</p>
          </div>
          {drivers.length ? (
            <ol>
              {drivers.map((driver) => {
                const bucket = spotlightForDriver(driver.key);
                const contents = <>
                  <span className="trip-story-driver-mark" aria-hidden="true">
                    {driver.amountCents < 0 ? "↓" : "↑"}
                  </span>
                  <span className="trip-story-driver-copy">
                    <strong>{driver.label}</strong>
                    <small>{bucket ? "Tap to see the receipt items" : driver.detail}</small>
                  </span>
                  <span className="trip-story-driver-amount">{signedMoney(driver.amountCents)}</span>
                </>;
                return (
                  <li key={driver.key} className={driver.amountCents < 0 ? "saving" : "added"}>
                    {bucket ? (
                      <button
                        type="button"
                        className="trip-story-driver-trigger"
                        onClick={() => openSpotlight(bucket)}
                        aria-haspopup="dialog"
                        aria-label={`Open receipt items for ${driver.label}`}
                      >
                        {contents}
                      </button>
                    ) : (
                      <div className="trip-story-driver-static">{contents}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="trip-story-quiet">Nothing materially moved the recorded total away from the saved estimate.</p>
          )}
        </section>
      )}

      {!totalsOnly && spotlightBuckets.length ? (
        <section className="comparison-buckets trip-story-buckets" aria-labelledby="item-comparison-title">
          <div className="trip-story-section-heading">
            <div>
              <p className="section-label">The evidence</p>
              <h4 id="item-comparison-title">See the cart take shape</h4>
            </div>
            <p>Open any chapter to see the receipt lines behind it.</p>
          </div>
          <div className="trip-story-bucket-list">
          {spotlightBuckets.map((bucket) => (
            <div key={bucket.key} className="comparison-bucket">
              <button
                type="button"
                className="comparison-bucket-trigger"
                onClick={() => openSpotlight(bucket)}
                aria-haspopup="dialog"
                aria-label={`Open ${bucket.label}: ${bucket.itemCount} ${bucket.itemCount === 1 ? "item" : "items"}`}
              >
                <span>
                  <strong>{bucket.label}</strong>
                  <small>Tap to explore · {bucket.itemCount} {bucket.itemCount === 1 ? "item" : "items"}</small>
                </span>
                <span>
                  <strong>{money.format(bucket.amountCents / 100)}</strong>
                  <small aria-hidden="true">View →</small>
                </span>
              </button>
            </div>
          ))}
          </div>
        </section>
      ) : null}

      {provisional && !totalsOnly ? (
        <div className="trip-story-caveat" role="note">
          <span aria-hidden="true">!</span>
          <div className="trip-story-caveat-copy">
            <p>
              <strong>
                {unresolvedCents > 5
                  ? `${money.format(unresolvedCents / 100)} still needs a receipt check.`
                  : "The receipt arithmetic still needs a quick check."}
              </strong>
              Open the receipt check to correct or confirm the remaining lines.
            </p>
            {onReviewReceipt ? (
              <button type="button" className="secondary-button" onClick={onReviewReceipt}>
                Review receipt lines
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <dialog
        ref={spotlightRef}
        className="receipt-spotlight"
        aria-labelledby="receipt-spotlight-title"
        onClose={() => setSpotlightBucket(null)}
      >
        {spotlightBucket ? (
          <div className="receipt-spotlight-content">
            <header className="receipt-spotlight-heading">
              <div>
                <p className="section-label">Receipt spotlight</p>
                <h3 id="receipt-spotlight-title">{spotlightBucket.label}</h3>
                <p>{bucketSpotlightCopy(spotlightBucket.key)}</p>
              </div>
              <button
                type="button"
                className="receipt-spotlight-close"
                onClick={closeSpotlight}
                aria-label="Close receipt spotlight"
              >
                ×
              </button>
            </header>

            {spotlightItem ? (
              <section className="receipt-flash-card" aria-live="polite">
                <p>
                  {spotlightBucket.key === "discounts" ? "Discount" : "Receipt item"} {spotlightIndex + 1} of {spotlightItemCount}
                </p>
                <strong>{spotlightItem.label ?? "Receipt item"}</strong>
                <span>
                  {spotlightItem.amountCents === null || spotlightItem.amountCents === undefined
                    ? "Amount still needs review"
                    : spotlightBucket.key === "discounts"
                      ? `Saved ${money.format(Math.abs(spotlightItem.amountCents) / 100)}`
                      : `Paid ${money.format(spotlightItem.amountCents / 100)}`}
                </span>
                {spotlightItem.note ? <small>{spotlightItem.note}</small> : null}
              </section>
            ) : (
              <section className="receipt-flash-card quiet" aria-live="polite">
                <p>Summary only</p>
                <strong>No individual receipt lines are available in this chapter yet.</strong>
                <span>The total remains visible in the recap while the evidence is reviewed.</span>
              </section>
            )}

            {spotlightItemCount > 1 ? (
              <div className="receipt-spotlight-controls" aria-label="Browse receipt items">
                <button type="button" className="secondary-button" onClick={() => moveSpotlight(-1)}>
                  ← Previous
                </button>
                <span>{spotlightIndex + 1} / {spotlightItemCount}</span>
                <button type="button" className="primary-button" onClick={() => moveSpotlight(1)}>
                  Next →
                </button>
              </div>
            ) : null}

            <div className="receipt-spotlight-total">
              <span>Chapter total</span>
              <strong>{money.format(spotlightBucket.amountCents / 100)}</strong>
            </div>

            {spotlightBucket.key.toLowerCase() === "unresolved" && onReviewReceipt ? (
              <button
                type="button"
                className="primary-button receipt-spotlight-review-action"
                onClick={reviewReceiptLines}
              >
                Review receipt lines
              </button>
            ) : null}
          </div>
        ) : null}
      </dialog>
    </div>
  );
}

export function ClosedLoopReview({
  closedLoop,
  connected,
  sandboxMode = false,
  onOpenReceipt,
  onRefresh,
}: {
  closedLoop?: ClosedLoopSnapshot | null;
  connected: boolean;
  sandboxMode?: boolean;
  onOpenReceipt: (step?: ReceiptStep) => void;
  onRefresh: () => Promise<void>;
}) {
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [catalogQuestionId, setCatalogQuestionId] = useState<string | null>(null);
  const [catalogName, setCatalogName] = useState("");
  const [catalogCategory, setCatalogCategory] = useState<ProductCategoryKey | "">("");
  const [receiptMatchQuestionId, setReceiptMatchQuestionId] = useState<string | null>(null);
  const [replacementReceiptItemId, setReplacementReceiptItemId] = useState("");
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

  const receiptItemsById = useMemo(
    () => new Map((closedLoop?.items ?? []).flatMap((item) => item.id ? [[item.id, item] as const] : [])),
    [closedLoop?.items],
  );
  const receiptMatchOptions = (closedLoop?.items ?? []).filter((item) => Boolean(item.id));
  const reviewableCategories = PRODUCT_CATEGORY_PRESENTATION.filter(
    (category) => !["fuel", "optical_services", "needs_review"].includes(category.key),
  );

  function beginCatalogConfirmation(question: ClosedLoopQuestion) {
    const item = question.receiptItemId ? receiptItemsById.get(question.receiptItemId) : null;
    setCatalogQuestionId(question.id);
    setCatalogName(item?.canonicalName ?? item?.rawDescription ?? "");
    setCatalogCategory(item?.taxStatus === "non_taxable" ? "groceries_beverages" : "");
    setAnswerError(null);
  }

  async function answer(
    question: ClosedLoopQuestion,
    value: string,
    details?: {
      canonicalName?: string;
      category?: ProductCategoryKey;
      replacementReceiptItemId?: string;
    },
  ) {
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
          ...(sandboxMode ? { sandbox: true } : {}),
          ...details,
        }),
      });
      await responseJson(response, "That answer could not be saved.");
      await onRefresh();
      setCatalogQuestionId(null);
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
                  {uploadStored ? " · original receipt stored privately" : " · structured receipt saved"}
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
              <p>Add a receipt photo or PDF, check the arithmetic, and BasketSense will build the comparison.</p>
            </div>
            <button type="button" className="primary-button" onClick={() => onOpenReceipt("capture")}>
              Add today’s receipt
            </button>
          </article>
        )}
      </section>

      {closedLoop?.comparison ? (
        <section className="review-section" aria-labelledby="comparison-title">
          <div className="review-section-heading story-section-heading">
            <div>
              <p className="section-label">Latest trip story</p>
              <h2 id="comparison-title">From plan to checkout</h2>
              <p>Your saved intent and receipt facts, turned into a short replay—not a score for the trip.</p>
            </div>
          </div>
          <article className="card review-bridge-card trip-story-card">
            <ExpectedActualBridge
              comparison={closedLoop.comparison}
              receiptItems={closedLoop.items ?? []}
              onReviewReceipt={() => onOpenReceipt("check")}
            />
          </article>
        </section>
      ) : null}

      <section className="review-section" aria-labelledby="trip-review-title">
        <div className="review-section-heading">
          <span className="review-section-number" aria-hidden="true">3</span>
          <div>
            <p className="section-label">Only useful follow-ups</p>
            <h2 id="trip-review-title">Questions for this trip</h2>
            <p>Up to three questions, only when an answer improves this recap, an insight, or a future list.</p>
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
                {catalogQuestionId === question.id ? (
                  <form
                    className="catalog-confirmation-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!catalogName.trim() || !catalogCategory) {
                        setAnswerError("Add a household name and choose a category first.");
                        return;
                      }
                      void answer(question, "add_to_catalog", {
                        canonicalName: catalogName.trim(),
                        category: catalogCategory,
                      });
                    }}
                  >
                    <p>This keeps the receipt wording as an alias and uses this confirmed line for its first package price.</p>
                    <label>
                      <span>Household name</span>
                      <input
                        value={catalogName}
                        onChange={(event) => setCatalogName(event.target.value)}
                        maxLength={140}
                        autoFocus
                      />
                    </label>
                    <label>
                      <span>Category</span>
                      <select
                        value={catalogCategory}
                        onChange={(event) => setCatalogCategory(event.target.value as ProductCategoryKey | "")}
                      >
                        <option value="">Choose a category</option>
                        {reviewableCategories.map((category) => (
                          <option key={category.key} value={category.key}>{category.label}</option>
                        ))}
                      </select>
                    </label>
                    <div className="catalog-confirmation-actions">
                      <button type="submit" className="primary-button" disabled={!connected || answeringId === question.id}>
                        {answeringId === question.id ? "Adding…" : "Add to catalog"}
                      </button>
                      <button type="button" className="secondary-button" disabled={answeringId === question.id} onClick={() => setCatalogQuestionId(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : receiptMatchQuestionId === question.id ? (
                  <form
                    className="catalog-confirmation-form receipt-match-confirmation-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!replacementReceiptItemId) {
                        setAnswerError("Choose the receipt line that matches this saved item.");
                        return;
                      }
                      void answer(question, "receipt_needs_fix", {
                        replacementReceiptItemId,
                      });
                    }}
                  >
                    <p>Choose the receipt line that was this saved item. BasketSense will remember this household wording for future receipts.</p>
                    <label>
                      <span>Receipt line</span>
                      <select
                        value={replacementReceiptItemId}
                        onChange={(event) => setReplacementReceiptItemId(event.target.value)}
                        autoFocus
                      >
                        <option value="">Choose a receipt line</option>
                        {receiptMatchOptions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {(item.rawDescription ?? item.canonicalName ?? "Receipt item").slice(0, 80)}{item.netAmountCents === null || item.netAmountCents === undefined ? "" : ` · ${money.format(item.netAmountCents / 100)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="catalog-confirmation-actions">
                      <button type="submit" className="primary-button" disabled={!connected || answeringId === question.id || !replacementReceiptItemId}>
                        {answeringId === question.id ? "Saving…" : "Confirm match"}
                      </button>
                      <button type="button" className="secondary-button" disabled={answeringId === question.id} onClick={() => setReceiptMatchQuestionId(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="question-options">
                  {question.options.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      disabled={!connected || answeringId === question.id}
                      onClick={() => {
                        if (option.value === "add_to_catalog") {
                          beginCatalogConfirmation(question);
                        } else if (option.value === "receipt_needs_fix") {
                          setReplacementReceiptItemId("");
                          setReceiptMatchQuestionId(question.id);
                          setAnswerError(null);
                        } else {
                          void answer(question, option.value);
                        }
                      }}
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
                )}
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
