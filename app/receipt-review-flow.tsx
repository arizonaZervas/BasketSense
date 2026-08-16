"use client";

import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConfettiCanvas } from "./confetti-canvas";
import { reconcileReceipt } from "./receipt-logic";
import {
  PRODUCT_CATEGORY_PRESENTATION,
  type ProductCategoryKey,
} from "./product-categories";
import { isReceiptImageContentType } from "./receipt-upload-formats";

export type ClosedLoopReceipt = {
  id: string;
  tripId?: string | null;
  transactionType?: "warehouse" | "return";
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
  finalListEstimateCents?: number | null;
  listEstimateChangeCents?: number | null;
  finalPricedItemCount?: number | null;
  finalUnpricedItemCount?: number | null;
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
  transactionType: "warehouse" | "return";
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

export function comparisonExpectedCents(comparison: ClosedLoopComparison) {
  return comparison.finalListEstimateCents ?? comparison.frozenEstimateCents ?? 0;
}

// The shared-site request gateway rejects multipart bodies before the receipt
// route can apply its own 8 MB validation. Leave room for multipart metadata so
// a camera photo that looks just under the limit does not still receive a 413.
const LIVE_UPLOAD_SAFE_BYTES = Math.floor(1.5 * 1024 * 1024);
const RECEIPT_MIN_READABLE_WIDTH = 1_200;
const RECEIPT_RECOVERY_TILE_OVERLAP = 0.18;

const bucketLabels: Record<string, string> = {
  matched: "Saved list + purchased",
  planned_and_purchased: "Saved list + purchased",
  missing: "Saved list, not found on receipt",
  planned_not_purchased: "Saved list, not found on receipt",
  in_store: "Added during trip + purchased",
  added_during_trip: "Added during trip + purchased",
  addedduringtrip: "Added during trip + purchased",
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
    case "addedduringtrip":
      return "These receipt lines match items added after shopping began.";
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

type ReceiptImageSource = {
  drawable: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

async function decodeReceiptImage(file: File): Promise<ReceiptImageSource> {
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      let bitmap: ImageBitmap;
      try {
        bitmap = await globalThis.createImageBitmap(file, {
          imageOrientation: "from-image",
        });
      } catch {
        // Some iOS WebKit versions implement createImageBitmap but reject the
        // options object. The default still honors the file's orientation.
        bitmap = await globalThis.createImageBitmap(file);
      }
      return {
        drawable: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to the broadly supported HTMLImageElement decoder.
    }
  }

  if (typeof Image === "undefined") {
    throw new Error("This browser could not decode the selected receipt photo.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The selected receipt photo could not be decoded."));
      image.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("The selected receipt photo has no readable dimensions.");
    }
    return {
      drawable: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export async function prepareReceiptUpload(file: File) {
  const contentType = file.type.toLowerCase();
  if (!isReceiptImageContentType(contentType)) {
    return file;
  }

  // Preserve already-uploadable photos byte-for-byte and avoid a large image
  // decode on memory-constrained phones.
  if (file.size <= LIVE_UPLOAD_SAFE_BYTES) {
    return file;
  }

  try {
    const source = await decodeReceiptImage(file);
    try {
      const encode = async (targetWidth: number, quality: number) => {
        const scale = Math.min(1, targetWidth / source.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const context = canvas.getContext("2d");
        if (!context) return null;
        try {
          context.drawImage(source.drawable, 0, 0, canvas.width, canvas.height);
          return await canvasToJpeg(canvas, quality);
        } finally {
          // Explicitly release tall canvas backing stores before the recovery
          // pass decodes the image again on iOS.
          canvas.width = 1;
          canvas.height = 1;
        }
      };

      // First reduce JPEG weight without throwing away pixels. Only then
      // reduce by receipt width, never by the much longer receipt height.
      let compressed = await encode(source.width, 0.72);
      if (!compressed || compressed.size > LIVE_UPLOAD_SAFE_BYTES) {
        compressed = await encode(source.width, 0.56);
      }
      if (!compressed || compressed.size > LIVE_UPLOAD_SAFE_BYTES) {
        compressed = await encode(Math.max(RECEIPT_MIN_READABLE_WIDTH, Math.min(1_600, source.width)), 0.68);
      }
      if (!compressed || compressed.size > LIVE_UPLOAD_SAFE_BYTES) {
        compressed = await encode(Math.min(RECEIPT_MIN_READABLE_WIDTH, source.width), 0.58);
      }
      if (!compressed || compressed.size > LIVE_UPLOAD_SAFE_BYTES) {
        compressed = await encode(Math.min(1_050, source.width), 0.52);
      }
      if (!compressed || compressed.size > LIVE_UPLOAD_SAFE_BYTES) {
        throw new Error("BasketSense could not create a safe-size copy of this receipt photo.");
      }
      return new File([compressed], compressedReceiptFilename(file.name), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      });
    } finally {
      source.release();
    }
  } catch (error) {
    // Never send the oversized original: the Sites gateway would reject it
    // before the receipt route could save it, and Retry would repeat the same
    // opaque 413 failure.
    throw error instanceof Error
      ? error
      : new Error("BasketSense could not prepare this large receipt photo.");
  }
}

/**
 * Creates private recovery evidence without replacing the original upload.
 * The full enhanced image helps with shadows; overlapping vertical sections
 * keep long-receipt type large enough for the second extraction pass.
 */
export async function prepareReceiptRecoveryAssets(file: File) {
  if (!isReceiptImageContentType(file.type.toLowerCase())) return [] as File[];
  try {
    const source = await decodeReceiptImage(file);
    try {
      const assets: File[] = [];
      const stem = file.name.replace(/\.[^.]+$/, "").trim() || "costco-receipt";
      const encodeRegion = async (
        sourceY: number,
        sourceHeight: number,
        targetWidth: number,
        quality: number,
      ) => {
        const scale = Math.min(1, targetWidth / source.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.filter = "grayscale(1) contrast(1.38) brightness(1.08)";
        try {
          context.drawImage(
            source.drawable,
            0,
            sourceY,
            source.width,
            sourceHeight,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          let blob = await canvasToJpeg(canvas, quality);
          if (blob && blob.size > LIVE_UPLOAD_SAFE_BYTES) {
            blob = await canvasToJpeg(canvas, 0.46);
          }
          return blob && blob.size <= LIVE_UPLOAD_SAFE_BYTES ? blob : null;
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      };

      const enhanced = await encodeRegion(
        0,
        source.height,
        Math.min(1_400, source.width),
        0.62,
      );
      if (enhanced) {
        assets.push(new File([enhanced], `${stem}-enhanced.jpg`, {
          type: "image/jpeg",
          lastModified: file.lastModified,
        }));
      }

      if (source.height > source.width * 1.7) {
        const tileHeight = Math.min(source.height, Math.round(source.width * 1.65));
        const step = Math.max(1, Math.round(tileHeight * (1 - RECEIPT_RECOVERY_TILE_OVERLAP)));
        const starts: number[] = [];
        for (let start = 0; start < source.height && starts.length < 6; start += step) {
          starts.push(Math.min(start, Math.max(0, source.height - tileHeight)));
          if (start + tileHeight >= source.height) break;
        }
        for (let index = 0; index < starts.length; index += 1) {
          const start = starts[index];
          const height = Math.min(tileHeight, source.height - start);
          const tile = await encodeRegion(
            start,
            height,
            Math.min(1_300, source.width),
            0.68,
          );
          if (!tile) continue;
          assets.push(new File([tile], `${stem}-section-${index + 1}.jpg`, {
            type: "image/jpeg",
            lastModified: file.lastModified,
          }));
        }
      }
      return assets;
    } finally {
      source.release();
    }
  } catch {
    return [] as File[];
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
    transactionType: "warehouse",
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
    transactionType: receipt.transactionType === "return" ? "return" : "warehouse",
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

function receiptDateForExpectedTrip(
  parsedDate: string | null | undefined,
  expectedPurchasedOn?: string | null,
) {
  const fallback = expectedPurchasedOn ?? todayInputValue();
  if (!parsedDate) return fallback;
  const purchasedOn = parsedDate.slice(0, 10);
  const expectedOn = expectedPurchasedOn?.slice(0, 10);
  if (
    expectedOn &&
    purchasedOn.slice(5) === expectedOn.slice(5) &&
    purchasedOn.slice(0, 4) !== expectedOn.slice(0, 4)
  ) {
    return expectedOn;
  }
  return purchasedOn;
}

export function draftFromParser(
  value: unknown,
  expectedPurchasedOn?: string | null,
  transactionTypeOverride?: ReceiptDraft["transactionType"],
): ReceiptDraft {
  const parsed = (value ?? {}) as {
    transactionType?: "warehouse" | "return";
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
  const transactionType = transactionTypeOverride ??
    (parsed.transactionType === "return" ? "return" : "warehouse");
  const displayCents = (amount: number | null | undefined) =>
    centsToInput(transactionType === "return" && amount ? Math.abs(amount) : amount);
  const representedDiscountCents = (parsed.items ?? []).reduce(
    (sum, item) => sum + Math.max(0, item.discountCents ?? 0),
    0,
  );
  const printedDiscountGapCents =
    transactionType === "warehouse" &&
    Number.isInteger(parsed.subtotalCents) &&
    Number.isInteger(parsed.taxCents) &&
    Number.isInteger(parsed.totalCents)
      ? (parsed.subtotalCents as number) +
        (parsed.taxCents as number) -
        (parsed.totalCents as number)
      : 0;
  const inferredDiscountCents =
    Math.max(0, parsed.discountCents ?? 0) > 0
      ? Math.max(0, parsed.discountCents ?? 0)
      : printedDiscountGapCents > 5 &&
          representedDiscountCents > 0 &&
          Math.abs(printedDiscountGapCents - representedDiscountCents) <= 5
        ? printedDiscountGapCents
        : 0;
  const items = (parsed.items ?? []).map((item) => ({
    clientId: clientId(),
    itemNumber: item.costcoItemNumber ?? item.itemNumber ?? "",
    description: item.rawDescription ?? item.description ?? "",
    amount: displayCents(
      item.kind !== "discount" &&
      (item.discountCents ?? 0) > 0 &&
      Number.isInteger(item.lineSubtotalCents)
        ? (item.lineSubtotalCents as number) - (item.discountCents ?? 0)
        : item.netAmountCents ?? item.lineSubtotalCents ?? item.amountCents,
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
    transactionType,
    purchasedOn: receiptDateForExpectedTrip(
      parsed.purchasedAt ?? parsed.purchasedOn,
      expectedPurchasedOn,
    ),
    subtotal: displayCents(parsed.subtotalCents),
    tax: displayCents(parsed.taxCents),
    total: displayCents(parsed.totalCents),
    discount: transactionType === "return" ? "" : centsToInput(inferredDiscountCents),
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

export function receiptDraftLineValueForTransaction(
  item: ReceiptDraftLine,
  index: number,
  transactionType: ReceiptDraft["transactionType"],
) {
  if (transactionType !== "return") return receiptDraftLineValue(item, index);
  const amountCents = -Math.abs(inputToCents(item.amount));
  return {
    sourceLineNumber: index + 1,
    costcoItemNumber: item.itemNumber.trim() || undefined,
    rawDescription: item.description.trim() || "Unlabeled returned product",
    quantityMilli: item.quantityMilli,
    unitPriceCents:
      item.unitPriceCents === null ? null : -Math.abs(item.unitPriceCents),
    lineSubtotalCents: amountCents,
    netAmountCents: amountCents,
    discountCents: 0,
    taxStatus: item.taxStatus,
    kind: "item" as const,
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

function correctionDraftSummary(draft: ReceiptDraft) {
  const lines = draft.items.filter(
    (item) => item.itemNumber.trim() || item.description.trim() || item.amount.trim(),
  );
  return {
    totalCents: inputToCents(draft.total),
    lines,
  };
}

function correctionLineChanges(current: ReceiptDraft, proposed: ReceiptDraft) {
  const keyFor = (line: ReceiptDraftLine) =>
    line.itemNumber.trim().toLowerCase() || line.description.trim().toLowerCase();
  const currentLines = correctionDraftSummary(current).lines;
  const proposedLines = correctionDraftSummary(proposed).lines;
  const currentByKey = new Map(currentLines.map((line) => [keyFor(line), line]));
  const proposedByKey = new Map(proposedLines.map((line) => [keyFor(line), line]));
  const added = proposedLines.filter((line) => !currentByKey.has(keyFor(line)));
  const removed = currentLines.filter((line) => !proposedByKey.has(keyFor(line)));
  const changed = proposedLines.filter((line) => {
    const before = currentByKey.get(keyFor(line));
    return Boolean(before && inputToCents(before.amount) !== inputToCents(line.amount));
  });
  return { added: added.length, removed: removed.length, changed: changed.length };
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
  const receiptId = closedLoop?.receipt?.id ?? null;
  const frozenEstimateCents = closedLoop?.comparison?.frozenEstimateCents ?? null;
  const finalListEstimateCents =
    closedLoop?.comparison?.finalListEstimateCents ?? frozenEstimateCents;
  const actualTotalCents =
    closedLoop?.comparison?.actualTotalCents ?? closedLoop?.receipt?.totalCents ?? null;
  const isCelebrationEligible =
    !provisional &&
    finalListEstimateCents !== null &&
    finalListEstimateCents > 0 &&
    actualTotalCents !== null &&
    actualTotalCents <= finalListEstimateCents * 1.2;
  const [showBudgetCelebration, setShowBudgetCelebration] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!receiptId || !isCelebrationEligible) {
        setShowBudgetCelebration(false);
        return;
      }
      const dismissalKey = `basket-sense-receipt-celebration:${receiptId}`;
      setShowBudgetCelebration(window.sessionStorage.getItem(dismissalKey) !== "dismissed");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isCelebrationEligible, receiptId]);

  if (hasReceipt) {
    return (
      <>
        {showBudgetCelebration ? (
          <section className="shopping-complete receipt-celebration" role="status" aria-live="polite">
            <ConfettiCanvas />
            <span className="shopping-complete-mark" aria-hidden="true">✦</span>
            <div>
              <strong>
                {actualTotalCents !== null && finalListEstimateCents !== null && actualTotalCents <= finalListEstimateCents
                  ? "Under plan — great cart day."
                  : "Close to plan — great cart day."}
              </strong>
              <p>
                Checkout was {money.format((actualTotalCents ?? 0) / 100)} against the final shopping-list estimate of {money.format((finalListEstimateCents ?? 0) / 100)}. Room for the fun finds included.
              </p>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (receiptId) {
                  window.sessionStorage.setItem(
                    `basket-sense-receipt-celebration:${receiptId}`,
                    "dismissed",
                  );
                }
                setShowBudgetCelebration(false);
              }}
            >
              Nice
            </button>
          </section>
        ) : null}
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
      </>
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
  tripScheduledFor,
  tripStatus,
  closedLoop,
  onClose,
  onRefresh,
  onOpenReview,
  sandboxMode = false,
  onReopenSandboxTrip,
  standalone = false,
  correction = false,
  standaloneReceiptId = null,
  onStandaloneReceiptIdChange,
}: {
  open: boolean;
  initialStep?: ReceiptStep;
  tripId: string | null;
  tripScheduledFor?: string | null;
  tripStatus: "planning" | "frozen" | "completed" | null;
  closedLoop?: ClosedLoopSnapshot | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenReview: () => void;
  sandboxMode?: boolean;
  onReopenSandboxTrip?: (receiptId: string, tripId: string) => Promise<boolean>;
  /** A Costco purchase that intentionally has no Saturday-list comparison. */
  standalone?: boolean;
  /** Owner-confirmed replacement for an already completed trip receipt. */
  correction?: boolean;
  /** A local, needs-review standalone receipt to reopen on this device. */
  standaloneReceiptId?: string | null;
  onStandaloneReceiptIdChange?: (receiptId: string | null) => void;
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
  const [ocrAttemptCount, setOcrAttemptCount] = useState(0);
  const [retryingReceipt, setRetryingReceipt] = useState(false);
  const [receiptIngestionId, setReceiptIngestionId] = useState<string | null>(null);
  const [receiptUploadRequestId, setReceiptUploadRequestId] = useState(clientId);
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
      setOcrAttemptCount(0);
      setRetryingReceipt(false);
      setReceiptIngestionId(null);
      setReceiptUploadRequestId(clientId());
      setPollReceiptIngestion(false);
      setPendingParsedDraft(null);
      appliedIngestionDraftId.current = null;
      setStep(initialStep);
      setWorkingClosedLoop(closedLoop ?? null);
      setDraft(draftFromClosedLoop(closedLoop));
      setReceiptId(standalone ? standaloneReceiptId : closedLoop?.receipt?.id ?? null);
      setDraftRequestId(clientId());
      setSaveError(null);
      setPhotoError(null);
      setSavedMessage(null);
      window.setTimeout(() => closeButton.current?.focus(), 0);
    }
    wasOpen.current = open;
  }, [closedLoop, initialStep, open, standalone, standaloneReceiptId]);

  useEffect(() => {
    if (!open || !standalone || !standaloneReceiptId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithTimeout(
          `/api/household?view=ad-hoc-receipt&receiptId=${encodeURIComponent(standaloneReceiptId)}${sandboxMode ? "&sandbox=1" : ""}`,
          { method: "GET", headers: { Accept: "application/json" } },
          12_000,
        );
        const body = await responseJson(response, "The saved Costco receipt could not be reopened.");
        if (cancelled || !body.receipt || typeof body.receipt !== "object") return;
        const receipt = body.receipt as {
          purchasedAt?: string;
          transactionType?: "warehouse" | "return";
          subtotalCents?: number;
          taxCents?: number;
          totalCents?: number;
          discountCents?: number;
          parseStatus?: string;
        };
        const items = Array.isArray(body.items) ? body.items : [];
        setReceiptId(standaloneReceiptId);
        setDraft(draftFromParser({ ...receipt, items }));
        setStep(receipt.parseStatus === "reconciled" ? "bridge" : "check");
      } catch (error) {
        if (!cancelled) {
          setSaveError(error instanceof Error ? error.message : "The saved Costco receipt could not be reopened.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sandboxMode, standalone, standaloneReceiptId]);

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
          attemptCount?: unknown;
          error?: unknown;
          draft?: unknown;
        };
        if (typeof ingestion.attemptCount === "number") {
          setOcrAttemptCount(ingestion.attemptCount);
        }
        const status = typeof ingestion.status === "string" ? ingestion.status : "uploaded";
        if (status === "awaiting_review" && ingestion.draft && typeof ingestion.draft === "object") {
          setPollReceiptIngestion(false);
          if (appliedIngestionDraftId.current === receiptIngestionId) return;
          setOcrProgress(1);
          setOcrError(null);
          if (hasMeaningfulDraftData(draft)) {
            setPendingParsedDraft(ingestion.draft);
            setOcrStatus("Draft ready — your edits are still in place");
          } else {
            setDraft(draftFromParser(
              ingestion.draft,
              tripScheduledFor,
              standalone ? draft.transactionType : undefined,
            ));
            appliedIngestionDraftId.current = receiptIngestionId;
            setPendingParsedDraft(null);
            setOcrStatus("Draft ready to check");
            setStep("check");
          }
          return;
        }
        if (status === "failed") {
          setPollReceiptIngestion(false);
          setOcrProgress(0);
          setOcrStatus(null);
          setOcrError(
            typeof ingestion.error === "string" && ingestion.error
              ? `Receipt reading attempt ${typeof ingestion.attemptCount === "number" ? ingestion.attemptCount : 1} failed: ${ingestion.error}`
              : "The receipt reader could not finish. Your private upload is saved; enter totals now and try a clearer photo or PDF later.",
          );
          return;
        }
        setOcrProgress(status === "extracting" ? 0.72 : 0.42);
        setOcrStatus(status === "extracting" ? "Reading your receipt in the background" : "Receipt saved — starting the reader");
        timer = window.setTimeout(readStatus, 2_500);
      } catch (error) {
        if (cancelled) return;
        setPollReceiptIngestion(false);
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
  }, [
    draft,
    open,
    pollReceiptIngestion,
    receiptIngestionId,
    sandboxMode,
    standalone,
    tripScheduledFor,
  ]);

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
        .map((item, index) =>
          receiptDraftLineValueForTransaction(item, index, draft.transactionType)
        ),
      subtotalCents:
        draft.transactionType === "return"
          ? -Math.abs(inputToCents(draft.subtotal))
          : inputToCents(draft.subtotal),
      taxCents:
        draft.transactionType === "return"
          ? -Math.abs(inputToCents(draft.tax))
          : inputToCents(draft.tax),
      totalCents:
        draft.transactionType === "return"
          ? -Math.abs(inputToCents(draft.total))
          : inputToCents(draft.total),
      discountCents:
        draft.transactionType === "return" ? 0 : Math.abs(inputToCents(draft.discount)),
      captureMode:
        draft.items.some((item) => item.description.trim() || item.amount.trim())
          ? ("itemized" as const)
          : ("totals_only" as const),
    }),
    [draft],
  );
  const officialCorrectionDraft = useMemo(
    () => draftFromClosedLoop(closedLoop),
    [closedLoop],
  );
  const pendingCorrectionDraft = useMemo(
    () => correction && pendingParsedDraft
      ? draftFromParser(pendingParsedDraft, tripScheduledFor)
      : null,
    [correction, pendingParsedDraft, tripScheduledFor],
  );
  const correctionPreviewDraft = pendingCorrectionDraft ?? draft;
  const correctionPreview = useMemo(() => {
    if (!correction) return null;
    return {
      official: correctionDraftSummary(officialCorrectionDraft),
      proposed: correctionDraftSummary(correctionPreviewDraft),
      changes: correctionLineChanges(officialCorrectionDraft, correctionPreviewDraft),
    };
  }, [correction, correctionPreviewDraft, officialCorrectionDraft]);

  const arithmetic = useMemo(() => {
    const totalsOnly = values.captureMode === "totals_only";
    const fallbackItemNetCents = values.items.reduce(
      (sum, item) => sum + item.lineSubtotalCents,
      0,
    );
    const fallbackSubtotalDeltaCents =
      totalsOnly ? 0 : fallbackItemNetCents - values.subtotalCents;
    const fallbackTotalDeltaCents =
      values.subtotalCents + values.taxCents - values.discountCents - values.totalCents;
    try {
      const result = reconcileReceipt({ ...values, totalsOnly }) as unknown as {
        itemNetCents?: number;
        computedSubtotalCents?: number;
        subtotalDeltaCents?: number;
        subtotalDelta?: number;
        totalDeltaCents?: number;
        totalDelta?: number;
        subtotalUsesGrossItemCents?: boolean;
        totalUsesReceiptDiscount?: boolean;
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
        subtotalUsesGrossItemCents: result.subtotalUsesGrossItemCents ?? false,
        totalUsesReceiptDiscount: result.totalUsesReceiptDiscount ?? false,
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
        subtotalUsesGrossItemCents: false,
        totalUsesReceiptDiscount: values.discountCents > 0,
        differenceCents,
        isReconciled: differenceCents <= 5,
      };
    }
  }, [values]);

  const hasRequiredReceiptValues =
    Boolean(draft.subtotal.trim()) && Boolean(draft.total.trim());
  const canFinalize = hasRequiredReceiptValues && arithmetic.isReconciled;
  const correctionReadyToApply =
    !correction ||
    Boolean(
      receiptIngestionId &&
        !pendingParsedDraft &&
        (appliedIngestionDraftId.current === receiptIngestionId || ocrError),
    );
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

  async function startReceiptIngestion(
    file: File,
    targetReceiptId = receiptId,
    requestId = receiptUploadRequestId,
  ) {
    if (!standalone && !tripId) {
      setOcrError("The shared trip is not ready yet. Refresh the list, then try the receipt again.");
      return;
    }
    if (standalone && !targetReceiptId) {
      setOcrStatus("Add the printed totals to save this receipt, then BasketSense can read the file.");
      setOcrProgress(0);
      return;
    }
    setOcrError(null);
    setPendingParsedDraft(null);
    setOcrStatus("Saving and reading your receipt privately");
    setOcrProgress(0.16);
    try {
      if (file.size > LIVE_UPLOAD_SAFE_BYTES && isReceiptImageContentType(file.type.toLowerCase())) {
        setOcrStatus("Preparing this large photo without shrinking the receipt text");
        setOcrProgress(0.08);
      }
      // Do not decode a long phone photo twice in parallel. Two 10-megapixel
      // bitmaps plus tall canvases can exhaust iOS WebKit memory, causing the
      // old path to silently send the oversized original and receive a 413.
      const uploadFile = await prepareReceiptUpload(file);
      setOcrStatus("Preparing clearer receipt sections for recovery");
      setOcrProgress(0.13);
      const recoveryAssets = await prepareReceiptRecoveryAssets(uploadFile);
      const form = new FormData();
      form.append("file", uploadFile);
      if ((standalone || correction) && targetReceiptId) {
        form.append("receiptId", targetReceiptId);
        if (correction) form.append("correction", "1");
      } else if (tripId) {
        form.append("tripId", tripId);
      }
      form.append("clientRequestId", requestId);
      if (recoveryAssets.length) form.append("deferExtraction", "1");
      if (sandboxMode) form.append("sandbox", "1");
      const primaryReadTimer = window.setTimeout(() => {
        setOcrStatus("Receipt saved privately — reading original, pass 1 of 2");
        setOcrProgress(0.46);
      }, 1_200);
      const primaryRecoveryTimer = window.setTimeout(() => {
        setOcrStatus("Original read was incomplete — starting recovery pass 2 of 2");
        setOcrProgress(0.72);
      }, 8_000);
      const response = await fetchWithTimeout(
        "/api/receipt-ingestion",
        { method: "POST", body: form },
        105_000,
      ).finally(() => {
        window.clearTimeout(primaryReadTimer);
        window.clearTimeout(primaryRecoveryTimer);
      });
      let body = await responseJson(
        response,
        response.status === 413
          ? "This live site needs a smaller receipt upload. For a photo, try a clearer close-up or a file under 2 MB."
          : "The receipt could not be saved for review.",
      );
      let ingestion = body.ingestion as {
        id?: unknown;
        status?: unknown;
        attemptCount?: unknown;
        extractionPass?: unknown;
        error?: unknown;
        draft?: unknown;
      } | undefined;
      if (!ingestion || typeof ingestion.id !== "string") {
        throw new Error("The receipt saved without a usable review ID.");
      }
      setReceiptIngestionId(ingestion.id);
      if (recoveryAssets.length) {
        setOcrStatus("Receipt saved privately — preparing a clearer second look");
        setOcrProgress(0.28);
        for (let index = 0; index < recoveryAssets.length; index += 1) {
          setOcrStatus(
            index === 0
              ? "Improving shadows and contrast"
              : `Checking long-receipt section ${index} of ${recoveryAssets.length - 1}`,
          );
          setOcrProgress(0.3 + (index / recoveryAssets.length) * 0.24);
          const recoveryForm = new FormData();
          recoveryForm.append("action", "add_recovery_asset");
          recoveryForm.append("ingestionId", ingestion.id);
          recoveryForm.append("assetIndex", String(index));
          recoveryForm.append("file", recoveryAssets[index]);
          const finalRecoveryAsset = index === recoveryAssets.length - 1;
          if (finalRecoveryAsset) {
            recoveryForm.append("final", "1");
            setOcrStatus("Reading the original receipt — pass 1 of 2");
            setOcrProgress(0.58);
          }
          if (sandboxMode) recoveryForm.append("sandbox", "1");
          const recoveryStatusTimer = finalRecoveryAsset
            ? window.setTimeout(() => {
                setOcrStatus("Improving contrast and checking sections — recovery pass 2 of 2");
                setOcrProgress(0.78);
              }, 7_000)
            : null;
          const recoveryResponse = await fetchWithTimeout(
            "/api/receipt-ingestion",
            { method: "PATCH", body: recoveryForm },
            finalRecoveryAsset ? 105_000 : 20_000,
          ).finally(() => {
            if (recoveryStatusTimer !== null) window.clearTimeout(recoveryStatusTimer);
          });
          body = await responseJson(
            recoveryResponse,
            "The original receipt is saved, but the clearer recovery pass could not finish.",
          );
          ingestion = body.ingestion as typeof ingestion;
          if (!ingestion || typeof ingestion.id !== "string") {
            throw new Error("The receipt recovery pass finished without a usable review ID.");
          }
        }
      }
      if (typeof ingestion.attemptCount === "number") {
        setOcrAttemptCount(ingestion.attemptCount);
      }
      setPollReceiptIngestion(body.queued === true);
      const status = typeof ingestion.status === "string" ? ingestion.status : "uploaded";
      if (status === "awaiting_review" && ingestion.draft && typeof ingestion.draft === "object") {
        setPollReceiptIngestion(false);
        setOcrProgress(1);
        if (hasMeaningfulDraftData(draft)) {
          setPendingParsedDraft(ingestion.draft);
          setOcrStatus("Draft ready — your edits are still in place");
        } else {
          setDraft(draftFromParser(
            ingestion.draft,
            standalone ? null : tripScheduledFor,
            standalone ? draft.transactionType : undefined,
          ));
          appliedIngestionDraftId.current = ingestion.id;
          setOcrStatus(
            ingestion.extractionPass === 2
              ? "Recovery pass complete — check the totals and items"
              : "Receipt read — check the totals and items",
          );
        }
      } else if (status === "failed") {
        setPollReceiptIngestion(false);
        setOcrProgress(0);
        setOcrStatus(null);
        setOcrError(
          typeof ingestion.error === "string" && ingestion.error
            ? `Receipt reading attempt ${typeof ingestion.attemptCount === "number" ? ingestion.attemptCount : 1} failed: ${ingestion.error}`
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

  async function reprocessSavedReceipt() {
    if (!correction || !receiptId || retryingReceipt) return;
    const requestId = clientId();
    setReceiptUploadRequestId(requestId);
    setReceiptFile(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setReceiptIngestionId(null);
    setPendingParsedDraft(null);
    appliedIngestionDraftId.current = null;
    setRetryingReceipt(true);
    setPollReceiptIngestion(false);
    setOcrError(null);
    setOcrProgress(0.38);
    setOcrStatus("Reading the saved original — full receipt first, recovery pass if needed");
    try {
      const response = await fetchWithTimeout(
        "/api/receipt-ingestion",
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "reprocess_saved_receipt",
            receiptId,
            clientRequestId: requestId,
            sandbox: sandboxMode,
          }),
        },
        105_000,
      );
      const body = await responseJson(
        response,
        "The saved original could not be reopened. Choose a replacement photo or PDF instead.",
      );
      const ingestion = body.ingestion as {
        id?: unknown;
        status?: unknown;
        attemptCount?: unknown;
        error?: unknown;
        draft?: unknown;
      } | undefined;
      if (!ingestion || typeof ingestion.id !== "string") {
        throw new Error("The saved receipt finished without a usable review ID.");
      }
      setReceiptIngestionId(ingestion.id);
      if (typeof ingestion.attemptCount === "number") {
        setOcrAttemptCount(ingestion.attemptCount);
      }
      const status = typeof ingestion.status === "string" ? ingestion.status : "uploaded";
      if (status === "awaiting_review" && ingestion.draft && typeof ingestion.draft === "object") {
        setPendingParsedDraft(ingestion.draft);
        setOcrProgress(1);
        setOcrStatus("Saved original re-read — compare the proposed correction");
      } else if (status === "failed") {
        setOcrProgress(0);
        setOcrStatus(null);
        setOcrError(
          typeof ingestion.error === "string" && ingestion.error
            ? `The saved original could not be read reliably: ${ingestion.error} Choose a replacement photo or PDF instead.`
            : "The saved original could not be read reliably. Choose a replacement photo or PDF instead.",
        );
      } else if (body.configurationMissing === true) {
        setOcrProgress(0);
        setOcrStatus(null);
        setOcrError("The receipt reader is temporarily unavailable. Choose a replacement later; the official receipt has not changed.");
      } else {
        setPollReceiptIngestion(true);
        setOcrProgress(0.52);
        setOcrStatus("The saved original is still being read");
      }
      setStep("check");
    } catch (error) {
      setOcrProgress(0);
      setOcrStatus(null);
      setOcrError(
        error instanceof Error
          ? `${error.message} The current receipt remains official.`
          : "The saved original could not be reopened. The current receipt remains official.",
      );
    } finally {
      setRetryingReceipt(false);
    }
  }

  async function retryReceiptIngestion() {
    if (!receiptIngestionId || retryingReceipt) return;
    setRetryingReceipt(true);
    setPollReceiptIngestion(false);
    setOcrError(null);
    setPendingParsedDraft(null);
    setOcrProgress(0.24);
    setOcrStatus(`Retrying the saved receipt — attempt ${ocrAttemptCount + 1}`);
    try {
      const response = await fetchWithTimeout(
        "/api/receipt-ingestion",
        {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "retry_extraction",
            ingestionId: receiptIngestionId,
            sandbox: sandboxMode,
          }),
        },
        105_000,
      );
      const body = await responseJson(response, "The saved receipt could not be read again.");
      const ingestion = body.ingestion as {
        id?: unknown;
        status?: unknown;
        attemptCount?: unknown;
        error?: unknown;
        draft?: unknown;
      } | undefined;
      if (!ingestion || typeof ingestion.id !== "string") {
        throw new Error("The receipt retry finished without a usable review ID.");
      }
      const attemptCount = typeof ingestion.attemptCount === "number"
        ? ingestion.attemptCount
        : ocrAttemptCount + 1;
      setOcrAttemptCount(attemptCount);
      const status = typeof ingestion.status === "string" ? ingestion.status : "uploaded";
      if (status === "awaiting_review" && ingestion.draft && typeof ingestion.draft === "object") {
        setPollReceiptIngestion(false);
        setOcrProgress(1);
        setOcrError(null);
        if (hasMeaningfulDraftData(draft)) {
          setPendingParsedDraft(ingestion.draft);
          setOcrStatus(`Receipt read on attempt ${attemptCount} — your edits are still in place`);
        } else {
          setDraft(draftFromParser(
            ingestion.draft,
            standalone ? null : tripScheduledFor,
            standalone ? draft.transactionType : undefined,
          ));
          appliedIngestionDraftId.current = receiptIngestionId;
          setOcrStatus(`Receipt read on attempt ${attemptCount} — check the totals and items`);
          setStep("check");
        }
      } else if (status === "failed") {
        setPollReceiptIngestion(false);
        setOcrProgress(0);
        setOcrStatus(null);
        setOcrError(
          `Receipt reading attempt ${attemptCount} failed${
            typeof ingestion.error === "string" && ingestion.error ? `: ${ingestion.error}` : "."
          } The saved private file is ready for another retry, or you can enter the printed totals now.`,
        );
      } else {
        setPollReceiptIngestion(true);
        setOcrProgress(status === "extracting" ? 0.72 : 0.42);
        setOcrStatus(`Receipt reading attempt ${attemptCount} is still running`);
      }
    } catch (error) {
      setOcrProgress(0);
      setOcrStatus(null);
      setOcrError(
        error instanceof Error
          ? `${error.message} The original private upload is still saved; no new photo is needed.`
          : "The saved receipt could not be read again. The original private upload is still safe.",
      );
    } finally {
      setRetryingReceipt(false);
    }
  }

  async function retryReceiptUpload() {
    if (!receiptFile || retryingReceipt) return;
    setRetryingReceipt(true);
    try {
      const targetReceiptId = standalone
        ? await ensureStandaloneReceiptForUpload()
        : receiptId;
      if (standalone && !targetReceiptId) return;
      await startReceiptIngestion(
        receiptFile,
        targetReceiptId,
        receiptUploadRequestId,
      );
    } finally {
      setRetryingReceipt(false);
    }
  }

  async function ensureStandaloneReceiptForUpload() {
    if (!standalone) return receiptId;
    if (receiptId) return receiptId;
    try {
      const response = await fetchWithTimeout("/api/household", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_ad_hoc_receipt",
          clientReceiptId: draftRequestId,
          transactionType: draft.transactionType,
          purchasedAt: draft.purchasedOn || todayInputValue(),
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
          discountCents: 0,
          captureMode: "totals_only",
          items: [],
          sandbox: sandboxMode,
        }),
      });
      const body = await responseJson(
        response,
        "The private Costco receipt draft could not be started.",
      );
      const bodyReceipt = body.receipt as { id?: unknown } | undefined;
      const savedReceiptId =
        (typeof body.receiptId === "string" ? body.receiptId : null) ??
        (typeof bodyReceipt?.id === "string" ? bodyReceipt.id : null);
      if (!savedReceiptId) {
        throw new Error("The private Costco receipt draft started without a usable receipt ID.");
      }
      setReceiptId(savedReceiptId);
      onStandaloneReceiptIdChange?.(savedReceiptId);
      return savedReceiptId;
    } catch (error) {
      setOcrStatus(null);
      setOcrProgress(0);
      setOcrError(
        error instanceof Error
          ? `${error.message} The selected receipt is still on this screen.`
          : "The private Costco receipt draft could not be started. The selected receipt is still on this screen.",
      );
      return null;
    }
  }

  async function chooseReceiptFile(event: ChangeEvent<HTMLInputElement>) {
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
    const nextRequestId = clientId();
    setReceiptUploadRequestId(nextRequestId);
    setOcrAttemptCount(0);
    setRetryingReceipt(false);
    setPollReceiptIngestion(false);
    appliedIngestionDraftId.current = null;
    const targetReceiptId = standalone
      ? await ensureStandaloneReceiptForUpload()
      : receiptId;
    if (standalone && !targetReceiptId) return;
    await startReceiptIngestion(file, targetReceiptId, nextRequestId);
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

  function setStandaloneTransactionType(
    transactionType: ReceiptDraft["transactionType"],
  ) {
    cancelReceiptOcr();
    setDraft((current) => ({
      ...current,
      transactionType,
      discount: transactionType === "return" ? "" : current.discount,
      items: current.items.map((item) => ({
        ...item,
        amount:
          transactionType === "return" && item.amount
            ? centsToInput(Math.abs(inputToCents(item.amount)))
            : item.amount,
        discountCents: transactionType === "return" ? 0 : item.discountCents,
        kind: transactionType === "return" ? "item" : item.kind,
      })),
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
    if (!standalone && !tripId) {
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
      if (correction) {
        if (!finalize) {
          throw new Error("Review the proposed replacement, then apply it when the totals agree.");
        }
        if (!receiptId || !receiptIngestionId) {
          throw new Error("Choose a replacement receipt photo or PDF before applying this correction.");
        }
        const response = await fetchWithTimeout("/api/household", {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "apply_receipt_correction",
            receiptId,
            ingestionId: receiptIngestionId,
            purchasedAt: draft.purchasedOn,
            sandbox: sandboxMode,
            ...values,
          }),
        });
        const body = await responseJson(response, "The replacement receipt could not be applied.");
        if (body.closedLoop && typeof body.closedLoop === "object") {
          setWorkingClosedLoop(body.closedLoop as ClosedLoopSnapshot);
        }
        setSavedMessage("Receipt correction applied. Spending, products, and this trip review now use the confirmed replacement.");
        setStep("bridge");
        await onRefresh();
        return;
      }
      const action = standalone
        ? receiptId
          ? "update_ad_hoc_receipt"
          : "create_ad_hoc_receipt"
        : receiptId
          ? "update_receipt_draft"
          : "ingest_receipt_draft";
      const response = await fetchWithTimeout("/api/household", {
        method: receiptId || standalone ? (receiptId ? "PATCH" : "POST") : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          clientDraftId: draftRequestId,
          clientReceiptId: draftRequestId,
          receiptId,
          ...(standalone ? {} : { tripId }),
          purchasedAt: draft.purchasedOn,
          ...(standalone ? { transactionType: draft.transactionType } : {}),
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
      if (standalone) onStandaloneReceiptIdChange?.(savedReceiptId);
      if (standalone && receiptFile && !receiptIngestionId) {
        await startReceiptIngestion(receiptFile, savedReceiptId);
      }
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
            action: standalone ? "finalize_ad_hoc_receipt" : "finalize_receipt",
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
        if (standalone) onStandaloneReceiptIdChange?.(null);
        setSavedMessage(
          standalone
            ? draft.transactionType === "return"
              ? "Costco return saved. Its refund now reduces household spending."
              : "Costco purchase saved to household spending and product history."
            : "Receipt checked and linked to the saved trip.",
        );
        setStep("bridge");
        void onRefresh().catch(() => undefined);
      } else {
        setSavedMessage(
          standalone
            ? draft.transactionType === "return"
              ? "Costco return draft saved. It does not affect spending until finalized."
              : "Costco purchase draft saved. You can safely finish it later."
            : "Needs-review draft saved. You can safely finish the check later.",
        );
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

  async function discardStandaloneDraft() {
    if (!receiptId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetchWithTimeout("/api/household", {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "discard_ad_hoc_receipt",
          receiptId,
          sandbox: sandboxMode,
        }),
      });
      await responseJson(response, "The purchase draft could not be discarded.");
      setSavedMessage("Costco purchase draft discarded. It did not change household spending.");
      setReceiptFile(null);
      setReceiptId(null);
      onStandaloneReceiptIdChange?.(null);
      setStep("capture");
      void onRefresh().catch(() => undefined);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The purchase draft could not be discarded.");
    } finally {
      setSaving(false);
    }
  }

  const planningWithoutFreeze = tripStatus === "planning";
  const receiptStored = Boolean(receiptId);
  const standaloneReturn = standalone && draft.transactionType === "return";

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
            <p className="section-label">{standalone ? "Costco purchase or return" : "Weekly closed loop"}</p>
            <strong>{standalone ? "Receipt → net spending → product history" : "Receipt → comparison → learning"}</strong>
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
            <span>3</span> {standalone ? "Save" : correction ? "Apply" : "Compare"}
          </li>
        </ol>

        {step === "capture" ? (
          <div className="receipt-flow-body capture-step">
            <div className="receipt-step-heading">
              <p className="section-label">{standalone ? "Separate Costco receipt" : correction ? "Historical correction" : "Add today’s receipt"}</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                {correction ? "Choose the replacement receipt" : "Add a photo or Costco PDF"}
              </h2>
              <p>
                {standalone
                  ? "For Costco.com orders, tires, jewelry, other separate purchases, or returns. Purchases add to Costco spending; returns subtract from it. Neither is matched to the Saturday list."
                  : correction
                    ? "The saved receipt remains official while BasketSense reads this replacement. Nothing changes until you review the draft and apply it."
                  : "BasketSense saves the original privately, then reads it in the background. You can confirm the printed totals while it works."}
              </p>
            </div>

            {standalone ? (
              <fieldset className="receipt-transaction-type">
                <legend>What kind of receipt is this?</legend>
                <div role="radiogroup" aria-label="Costco receipt type">
                  <button
                    type="button"
                    className={draft.transactionType === "warehouse" ? "active" : ""}
                    aria-pressed={draft.transactionType === "warehouse"}
                    onClick={() => setStandaloneTransactionType("warehouse")}
                  >
                    Purchase
                  </button>
                  <button
                    type="button"
                    className={draft.transactionType === "return" ? "active" : ""}
                    aria-pressed={draft.transactionType === "return"}
                    onClick={() => setStandaloneTransactionType("return")}
                  >
                    Return
                  </button>
                </div>
                <small>
                  {standaloneReturn
                    ? "Enter the refunded amounts as printed; BasketSense records them as a reduction in spending."
                    : "This receipt will add its finalized total to Costco spending."}
                </small>
              </fieldset>
            ) : null}

            {planningWithoutFreeze && !standalone ? (
              <div className="receipt-flow-note warning" role="note">
                <strong>No saved pre-trip plan</strong>
                <p>
                  You can continue, but BasketSense can only compare against the current
                  list, so intent evidence will be weaker.
                </p>
              </div>
            ) : null}

            {correction ? (
              <div className="receipt-flow-note correction-source-choice" role="note">
                <div>
                  <strong>Try the original again first</strong>
                  <p>BasketSense can re-read the private file already attached to this trip. If it is the wrong or unclear file, choose a replacement below.</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={retryingReceipt}
                  onClick={() => void reprocessSavedReceipt()}
                >
                  {retryingReceipt ? "Reading saved original…" : "Re-read saved receipt"}
                </button>
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
              <small>PDF, JPG, PNG, WebP, and iPhone HEIC photos can be drafted automatically.</small>
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

            {ocrError ? (
              <div className="receipt-flow-error" role="alert">
                <span>{ocrError}</span>
                {receiptIngestionId ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={retryingReceipt}
                    onClick={() => void retryReceiptIngestion()}
                  >
                    {retryingReceipt ? "Retrying saved receipt…" : "Try reading the saved receipt again"}
                  </button>
                ) : receiptFile ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={retryingReceipt}
                    onClick={() => void retryReceiptUpload()}
                  >
                    {retryingReceipt ? "Retrying receipt upload…" : "Try saving and reading this receipt again"}
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="receipt-flow-actions split">
              <button type="button" className="primary-button" onClick={() => setStep("check")}>
                {receiptFile
                  ? "Continue while it reads"
                  : correction
                    ? "Review current receipt"
                    : standaloneReturn
                      ? "Enter return totals"
                      : "Enter purchase totals"}
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
              <p className="section-label">{standalone ? standaloneReturn ? "Return confirmation" : "Purchase confirmation" : "Receipt confirmation"}</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                {standalone ? standaloneReturn ? "Confirm the Costco return" : "Confirm the Costco purchase" : "Confirm the receipt total"}
              </h2>
              <p>
                {standalone
                  ? standaloneReturn
                    ? "We use the refund total to reduce Costco spending. Product lines keep the return categorized without counting it as another purchase."
                    : "We use the order or receipt totals for Costco spending. Product lines are optional and add to product history when they are readable."
                  : "We use the printed numbers for exact spending. Product lines are optional and only power item-level learning when they are readable."}
              </p>
            </div>

            {standalone ? (
              <fieldset className="receipt-transaction-type">
                <legend>Receipt type</legend>
                <div role="radiogroup" aria-label="Costco receipt type">
                  <button
                    type="button"
                    className={draft.transactionType === "warehouse" ? "active" : ""}
                    aria-pressed={draft.transactionType === "warehouse"}
                    onClick={() => setStandaloneTransactionType("warehouse")}
                  >
                    Purchase
                  </button>
                  <button
                    type="button"
                    className={draft.transactionType === "return" ? "active" : ""}
                    aria-pressed={draft.transactionType === "return"}
                    onClick={() => setStandaloneTransactionType("return")}
                  >
                    Return
                  </button>
                </div>
              </fieldset>
            ) : null}

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

            {ocrError ? (
              <div className="receipt-flow-error" role="alert">
                <span>{ocrError}</span>
                {receiptIngestionId ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={retryingReceipt}
                    onClick={() => void retryReceiptIngestion()}
                  >
                    {retryingReceipt ? "Retrying saved receipt…" : "Try reading the saved receipt again"}
                  </button>
                ) : receiptFile ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={retryingReceipt}
                    onClick={() => void retryReceiptUpload()}
                  >
                    {retryingReceipt ? "Retrying receipt upload…" : "Try saving and reading this receipt again"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {pendingParsedDraft && !correction ? (
              <div className="receipt-flow-note" role="status">
                <strong>We found the product lines.</strong>
                <p>Your totals and edits are unchanged. Use the draft only if you want to replace this screen with the receipt reader’s version.</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setDraft(draftFromParser(
                      pendingParsedDraft,
                      tripScheduledFor,
                      standalone ? draft.transactionType : undefined,
                    ));
                    appliedIngestionDraftId.current = receiptIngestionId;
                    setPendingParsedDraft(null);
                    setOcrStatus("Draft ready to check");
                  }}
                >
                  Use receipt draft
                </button>
              </div>
            ) : null}

            {correction && correctionPreview && receiptIngestionId &&
            (pendingParsedDraft || appliedIngestionDraftId.current === receiptIngestionId || ocrError) ? (
              <div className="receipt-correction-comparison" role="status">
                <div className="receipt-correction-comparison-heading">
                  <div>
                    <span className="section-label">Before you apply</span>
                    <strong>Current official receipt → proposed correction</strong>
                  </div>
                  <span className="receipt-revision-safety">Nothing has changed yet</span>
                </div>
                <div className="receipt-correction-metrics">
                  <div>
                    <span>Receipt total</span>
                    <strong>
                      {money.format(correctionPreview.official.totalCents / 100)} → {money.format(correctionPreview.proposed.totalCents / 100)}
                    </strong>
                  </div>
                  <div>
                    <span>Product lines</span>
                    <strong>
                      {correctionPreview.official.lines.length} → {correctionPreview.proposed.lines.length}
                    </strong>
                  </div>
                  <div>
                    <span>Product changes</span>
                    <strong>
                      +{correctionPreview.changes.added} added · −{correctionPreview.changes.removed} removed · {correctionPreview.changes.changed} changed
                    </strong>
                  </div>
                  {closedLoop?.comparison ? (
                    <div>
                      <span>Compared with final list estimate</span>
                      <strong>
                        {money.format(
                          (correctionPreview.official.totalCents - comparisonExpectedCents(closedLoop.comparison)) / 100,
                        )} → {money.format(
                          (correctionPreview.proposed.totalCents - comparisonExpectedCents(closedLoop.comparison)) / 100,
                        )}
                      </strong>
                    </div>
                  ) : null}
                </div>
                <p>The saved plan and final shopping list stay frozen. BasketSense recalculates the detailed matches only after you confirm this replacement.</p>
                {pendingParsedDraft ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setDraft(draftFromParser(pendingParsedDraft, tripScheduledFor));
                      appliedIngestionDraftId.current = receiptIngestionId;
                      setPendingParsedDraft(null);
                      setOcrStatus("Replacement ready to check");
                    }}
                  >
                    Review proposed replacement
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className={`receipt-total-fields${standaloneReturn ? " return-receipt-fields" : ""}`}>
              <label>
                <span>{standaloneReturn ? "Returned" : "Purchased"}</span>
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
                  ["discount", standalone ? "Order discounts" : "Discounts"],
                  ["tax", "Tax"],
                  ["total", "Total"],
                ] as const
              ).map(([field, label]) => standaloneReturn && field === "discount" ? null : (
                <label key={field}>
                  <span>{standaloneReturn && field === "total" ? "Refund total" : label}</span>
                  <span className="money-input">
                    <span aria-hidden="true">$</span>
                    <input
                      inputMode="decimal"
                      aria-label={`${standaloneReturn && field === "total" ? "Refund total" : label} in dollars`}
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
            {standaloneReturn ? (
              <p className="receipt-discount-help">
                Enter refund amounts as positive numbers. BasketSense stores the finalized
                receipt as a negative transaction so it reduces net Costco spending.
              </p>
            ) : (
              <p className="receipt-discount-help">
                Enter {standalone ? "order discounts" : "discounts"} as a positive total.
                BasketSense subtracts each discount only once, whether it is a receipt total,
                a separate line, or attached to an item.
              </p>
            )}

            <details className="receipt-lines-disclosure">
              <summary>
                {values.items.length
                  ? `Review ${values.items.length} product lines (optional)`
                  : "Add product lines (optional)"}
              </summary>
              <p>
                {standalone
                  ? standaloneReturn
                    ? "Totals are enough to record the refund. Product lines keep the returned amount in the right categories."
                    : "Totals are enough to record this Costco purchase. Product lines add useful household history when you know them."
                  : "Totals are enough to save an accurate trip. Product lines improve the item-level comparison and catalog only after you confirm them."}
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
                  {!standaloneReturn ? <label className="draft-kind">
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
                  </label> : null}
                  <label className="draft-amount">
                    <span>
                      {item.kind === "discount"
                        ? "Savings"
                        : item.discountCents > 0
                          ? `Paid (after ${money.format(item.discountCents / 100)} off)`
                          : standaloneReturn ? "Refunded" : "Amount"}
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
                    ? arithmetic.totalUsesReceiptDiscount
                      ? `${money.format(values.subtotalCents / 100)} − ${money.format(values.discountCents / 100)} discounts + ${money.format(values.taxCents / 100)} tax = ${money.format(values.totalCents / 100)}`
                      : `Subtotal ${money.format(values.subtotalCents / 100)} · tax ${money.format(values.taxCents / 100)} · total ${money.format(values.totalCents / 100)}`
                    : canFinalize && arithmetic.totalUsesReceiptDiscount
                      ? `${money.format(values.subtotalCents / 100)} − ${money.format(values.discountCents / 100)} discounts + ${money.format(values.taxCents / 100)} tax = ${money.format(values.totalCents / 100)}`
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
              {standalone && receiptStored ? (
                <button
                  type="button"
                  className="text-button danger-action"
                  disabled={saving}
                  onClick={() => void discardStandaloneDraft()}
                >
                  Discard draft
                </button>
              ) : null}
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
              {!canFinalize && !correction ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || !hasAnyDraftData}
                  onClick={() => void saveDraft(false)}
                >
                  {saving
                    ? "Saving…"
                    : receiptStored
                      ? standalone ? standaloneReturn ? "Update return draft" : "Update purchase draft" : "Update needs-review draft"
                      : hasRequiredReceiptValues
                        ? standalone ? standaloneReturn ? "Save return draft" : "Save purchase draft" : "Save needs-review draft"
                        : standalone ? standaloneReturn ? "Save return for later" : "Save purchase for later" : "Save receipt for later"}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-button"
                disabled={saving || !canFinalize || !correctionReadyToApply}
                onClick={() => void saveDraft(true)}
              >
                {saving ? "Saving…" : correction ? "Apply correction" : standalone ? standaloneReturn ? "Save Costco return" : "Save Costco purchase" : "Save & compare"}
              </button>
            </div>
            {!canFinalize || !correctionReadyToApply ? (
              <p className="finalize-help">
                {correction && !receiptIngestionId
                  ? "Choose a saved or replacement receipt first. "
                  : correction && pendingParsedDraft
                    ? "Review the proposed replacement first. "
                    : correction && !correctionReadyToApply
                      ? "Wait for the receipt reader to finish. "
                      : ""}
                {!canFinalize
                  ? "Save unlocks when the printed subtotal, tax, and total agree within $0.05."
                  : "Apply unlocks after the replacement is ready to review."}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "bridge" ? (
          <div className="receipt-flow-body bridge-step">
            <div className="receipt-step-heading">
              <p className="section-label">{standalone ? standaloneReturn ? "Costco refund recorded" : "Costco spending recorded" : correction ? "Historical correction applied" : "Expected → actual"}</p>
              <h2 id="receipt-flow-title" ref={stepHeading} tabIndex={-1}>
                {standalone ? standaloneReturn ? "Return saved" : "Purchase saved" : correction ? "Trip review updated" : "What changed at checkout"}
              </h2>
              <p>{standalone ? standaloneReturn ? "This refund now reduces Costco spending and remains categorized in receipt history. It is separate from the Saturday list." : "This purchase now appears in Costco spending and product history. It is separate from the Saturday list." : correction ? "The frozen plan and final list stayed intact; only the confirmed receipt evidence changed." : "This is a factual comparison with the saved list—not a score for the trip."}</p>
            </div>
            {savedMessage ? <div className="receipt-flow-success" role="status">{savedMessage}</div> : null}
            {!standalone && workingClosedLoop?.comparison ? (
              <ExpectedActualBridge
                comparison={workingClosedLoop.comparison}
                receiptItems={workingClosedLoop.items ?? []}
                onReviewReceipt={() => setStep("check")}
              />
            ) : (
              <div className="receipt-flow-note">
                <strong>Receipt saved</strong>
                <p>{standalone ? `No Saturday-list comparison was created for this separate Costco ${standaloneReturn ? "return" : "purchase"}.` : "The comparison is still being prepared. Close and reopen Review after the shared household refreshes."}</p>
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
                {standalone ? standaloneReturn ? "Review return" : "Review purchase" : "Recheck receipt"}
              </button>
              <button type="button" className="primary-button" onClick={standalone ? onClose : onOpenReview}>
                {standalone ? "Done" : "Continue to trip review"}
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
  const initialEstimateCents = comparison.frozenEstimateCents ?? null;
  const expectedCents = comparisonExpectedCents(comparison);
  const actualCents = comparison.actualTotalCents ?? 0;
  const totalDifferenceCents = actualCents - expectedCents;
  const hasSavedEstimate =
    (comparison.finalListEstimateCents !== null && comparison.finalListEstimateCents !== undefined) ||
    initialEstimateCents !== null;
  const shoppingEstimateChanged =
    initialEstimateCents !== null && expectedCents !== initialEstimateCents;
  const finalUnpricedItemCount = comparison.finalUnpricedItemCount ?? 0;
  const differenceDirection = totalDifferenceCents > 5 ? "above" : totalDifferenceCents < -5 ? "below" : "in line with";
  const visibleBuckets: SpotlightBucket[] = buckets.filter(
    (bucket) => bucket.itemCount > 0 || bucket.items.length > 0 || bucket.amountCents !== 0,
  );
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

  return (
    <div className="expected-actual trip-story">
      <header className="trip-story-intro">
        <div>
          <p className="section-label">Receipt evidence</p>
          <h3>
            {hasSavedEstimate
              ? `Checkout was ${differenceDirection} the final shopping-list estimate.`
              : "Receipt total recorded."}
          </h3>
          <p>
            {hasSavedEstimate
              ? `${signedMoney(totalDifferenceCents)} from the final estimate.${shoppingEstimateChanged ? ` Started at ${money.format((initialEstimateCents ?? 0) / 100)}; shopping changes brought the list to ${money.format(expectedCents / 100)}.` : ""}`
              : "Add saved-list estimates to compare a future checkout."}
          </p>
        </div>
        <span className={`comparison-status ${provisional ? "provisional" : "trusted"}`}>
          {provisional ? "Needs one check" : "Receipt matched"}
        </span>
      </header>

      <div className="trip-story-totals" aria-label="Final shopping list compared with receipt total">
        <div className="trip-story-total planned">
          <span>Final list</span>
          <strong>{money.format(expectedCents / 100)}</strong>
          <small>
            {shoppingEstimateChanged ? "Includes shopping changes" : "Saved before checkout"}
            {finalUnpricedItemCount
              ? ` · ${finalUnpricedItemCount} unpriced ${finalUnpricedItemCount === 1 ? "item" : "items"} not included`
              : ""}
          </small>
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
      ) : null}

      {!totalsOnly && visibleBuckets.length ? (
        <section className="comparison-buckets trip-story-buckets" aria-labelledby="item-comparison-title">
          <div className="trip-story-section-heading">
            <div>
              <h4 id="item-comparison-title">What changed</h4>
            </div>
            <p>Open a group to see the receipt lines.</p>
          </div>
          <div className="trip-story-bucket-list">
          {visibleBuckets.map((bucket) => (
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

function ProductMemoryQuestion({
  question,
  connected,
  saving,
  onSave,
  onSkip,
}: {
  question: ClosedLoopQuestion;
  connected: boolean;
  saving: boolean;
  onSave: (value: string, note: string) => void;
  onSkip: () => void;
}) {
  const [preference, setPreference] = useState("");
  const [note, setNote] = useState("");

  return (
    <div className="product-memory-question">
      <p className="product-memory-question-copy">
        Choose only what you want BasketSense to use next time. Receipt history
        alone never decides this.
      </p>
      <div className="product-memory-options" role="radiogroup" aria-label="Product memory">
        {question.options.map((option) => (
          <button
            type="button"
            role="radio"
            aria-checked={preference === option.value}
            className={preference === option.value ? "selected" : ""}
            key={option.value}
            disabled={!connected || saving}
            onClick={() => setPreference(option.value)}
          >
            <strong>{option.label}</strong>
            {option.effect ? <small>{option.effect}</small> : null}
          </button>
        ))}
      </div>
      <label className="product-memory-note">
        <span>Optional household note</span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          placeholder="Smaller package next time"
          disabled={!connected || saving}
        />
      </label>
      <div className="product-memory-actions">
        <button
          type="button"
          className="text-button"
          disabled={!connected || saving}
          onClick={onSkip}
        >
          Skip for now
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!connected || saving || !preference}
          onClick={() => onSave(preference, note.trim())}
        >
          {saving ? "Saving…" : "Save memory"}
        </button>
      </div>
    </div>
  );
}

export function ClosedLoopReview({
  closedLoop,
  connected,
  sandboxMode = false,
  onOpenReceipt,
  onRefresh,
  canEditReceipt = true,
  receiptActionLabel = "Open receipt check",
}: {
  closedLoop?: ClosedLoopSnapshot | null;
  connected: boolean;
  sandboxMode?: boolean;
  onOpenReceipt: (step?: ReceiptStep) => void;
  onRefresh: () => Promise<void>;
  canEditReceipt?: boolean;
  receiptActionLabel?: string;
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
      note?: string;
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
          <div>
            <h2 id="receipt-check-title">Receipt check</h2>
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
            {canEditReceipt ? (
              <button type="button" className="secondary-button" onClick={() => onOpenReceipt("check")}>
                {receiptActionLabel}
              </button>
            ) : null}
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
        <section className="review-section" aria-label="Receipt evidence">
          <article className="card review-bridge-card trip-story-card">
            <ExpectedActualBridge
              comparison={closedLoop.comparison}
              receiptItems={closedLoop.items ?? []}
              onReviewReceipt={canEditReceipt ? () => onOpenReceipt("check") : undefined}
            />
          </article>
        </section>
      ) : null}

      {openQuestions.length ? <section className="review-section" aria-labelledby="trip-review-title">
        <div className="review-section-heading">
          <div>
            <h2 id="trip-review-title">Questions for this trip</h2>
          </div>
        </div>

        <div className="evidence-questions">
            {openQuestions.map((question, index) => (
              <article className="evidence-question card" key={question.id}>
                <div className="question-heading">
                  <span>Question {index + 1} of {openQuestions.length}</span>
                  <span>
                    {question.purpose === "product_experience"
                      ? "Product memory"
                      : question.purpose ?? "Trip context"}
                  </span>
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
                ) : question.purpose === "product_experience" ? (
                  <ProductMemoryQuestion
                    question={question}
                    connected={connected}
                    saving={answeringId === question.id}
                    onSave={(value, note) =>
                      void answer(question, value, { note })
                    }
                    onSkip={() => void answer(question, "skip")}
                  />
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
        {answerError ? <div className="receipt-flow-error" role="alert">{answerError}</div> : null}
      </section> : null}
    </div>
  );
}
