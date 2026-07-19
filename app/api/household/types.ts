import type { DashboardViewData } from "../../dashboard-types";

export type TripStatus = "planning" | "frozen" | "completed";

export type ListItemSection =
  | "essentials"
  | "suggested"
  | "check_first"
  | "consider";

export type ListItemSource =
  | "manual"
  | "recurring"
  | "predicted"
  | "consider"
  | "in_store";

export type FeedbackKind =
  | "trip_enjoyment"
  | "recommendation_response"
  | "discovery_outcome"
  | "duplicate_signal"
  | "waste_signal"
  | "regret_signal"
  | "receipt_correction"
  | "fulfillment_reason"
  | "product_experience";

export type ReviewQuestionPurpose =
  | "data_quality"
  | "intent"
  | "outcome"
  | "product_experience";

export interface ReceiptItemDraftInput {
  sourceLineNumber: number;
  costcoItemNumber?: string | null;
  rawDescription: string;
  quantityMilli?: number | null;
  unitPriceCents?: number | null;
  lineSubtotalCents: number;
  discountCents?: number | null;
  netAmountCents?: number | null;
  taxStatus?: "taxable" | "non_taxable" | "unknown" | null;
}

export interface ClosedLoopReceiptItem {
  id: string;
  sourceLineNumber: number;
  costcoItemNumber: string | null;
  rawDescription: string;
  productId: string | null;
  canonicalName: string | null;
  category: string | null;
  quantityMilli: number;
  unitPriceCents: number | null;
  lineSubtotalCents: number;
  discountCents: number;
  netAmountCents: number;
  taxStatus: "taxable" | "non_taxable" | "unknown";
  matchConfidenceBps: number | null;
}

export interface TripIntentItemSummary {
  id: string;
  snapshotId: string;
  listItemId: string | null;
  productId: string | null;
  costcoItemNumber: string | null;
  label: string;
  section: ListItemSection;
  source: ListItemSource;
  recommendationReason: string | null;
  confidenceBps: number | null;
  included: boolean;
  quantityMilli: number;
  estimatedPriceCents: number | null;
  sortOrder: number;
}

export interface TripItemMatchSummary {
  id: string;
  intentItemId: string;
  receiptItemId: string;
  matchType:
    | "exact_item_number"
    | "exact_product"
    | "confirmed_alias"
    | "exact_name"
    | "member_confirmed";
  confidenceBps: number;
  resolutionSource: "system" | "member";
}

export interface ReviewQuestionOptionSummary {
  value: string;
  label: string;
  effect: string;
}

export interface ReviewQuestionSummary {
  id: string;
  purpose: ReviewQuestionPurpose;
  prompt: string;
  options: ReviewQuestionOptionSummary[];
  status: "open" | "answered" | "dismissed";
  selectedValue: string | null;
  effectTarget: string | null;
  declaredEffect: string;
  listItemId: string | null;
  intentItemId: string | null;
  receiptItemId: string | null;
  answeredAt: string | null;
}

export interface ClosedLoopComparison {
  isProvisional: boolean;
  arithmetic: {
    isReconciled: boolean;
    itemNetCents: number;
    subtotalDeltaCents: number | null;
    totalDeltaCents: number | null;
  };
  intentEvidence: "pre_trip" | "upload_fallback";
  frozenEstimateCents: number;
  pricedIntentItemCount: number;
  unpricedIntentItemCount: number;
  actualMerchandiseCents: number;
  actualTotalCents: number;
  matchedVarianceCents: number;
  unpricedPlannedActualCents: number;
  additionsCents: number;
  skippedEstimateCents: number;
  discountsCents: number;
  taxCents: number;
  unresolvedCents: number;
  buckets: {
    matched: Array<{ intentItemId: string; receiptItemId: string }>;
    unpricedPlanned: Array<{ intentItemId: string; receiptItemId: string }>;
    skippedPlanned: Array<{ intentItemId: string }>;
    receiptOnly: Array<{ receiptItemId: string }>;
    unresolved: Array<{ receiptItemId: string }>;
    possibleSubstitutions: Array<{
      intentItemId: string;
      receiptItemId: string;
    }>;
  };
}

export interface ClosedLoopReview {
  receipt: ReceiptTransactionSummary;
  items: ClosedLoopReceiptItem[];
  intentItems: TripIntentItemSummary[];
  matches: TripItemMatchSummary[];
  comparison: ClosedLoopComparison;
  questions: ReviewQuestionSummary[];
  upload: {
    id: string;
    originalFilename: string;
    contentType: string;
    byteSize: number;
    status: "stored" | "replaced" | "deleted";
    uploadedAt: string;
    imageUrl: string;
  } | null;
}

export interface HouseholdSummary {
  id: string;
  name: string;
  timeZone: string;
}

export interface HouseholdMemberSummary {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "member";
}

export interface TripSummary {
  id: string;
  scheduledFor: string;
  status: TripStatus;
  targetCents: number | null;
  discoveryAllowanceCents: number | null;
  estimatedListTotalAtFreezeCents: number | null;
  estimatedPricedItemCountAtFreeze: number | null;
  estimatedUnpricedItemCountAtFreeze: number | null;
  frozenAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TripListItemSummary {
  id: string;
  tripId: string;
  productId: string | null;
  label: string;
  section: ListItemSection;
  source: ListItemSource;
  recommendationReason: string | null;
  confidenceBps: number | null;
  included: boolean;
  checked: boolean;
  includedAtFreeze: boolean | null;
  addedAfterFreeze: boolean;
  estimatedPriceCents: number | null;
  quantityMilli: number;
  sortOrder: number;
  addedByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSummary {
  id: string;
  costcoItemNumber: string | null;
  canonicalName: string;
  category: string | null;
  categoryStatus: "reviewed" | "rule_based" | "needs_review";
  categoryReviewedAt: string | null;
  categoryReviewedByDisplayName: string | null;
  latestRawDescription: string | null;
  latestPurchasedAt: string | null;
  latestRegularUnitPriceCents: number | null;
  latestPaidUnitPriceCents: number | null;
  latestDiscountUnitCents: number | null;
  brand: string | null;
  unitDescription: string | null;
  active: boolean;
  updatedAt: string;
}

export interface ReceiptTransactionSummary {
  id: string;
  tripId: string | null;
  transactionType: "warehouse" | "fuel" | "optical" | "return";
  sourceType: "digital_receipt" | "fuel_receipt" | "receipt_photo";
  purchasedAt: string;
  itemGrossCents: number;
  itemCount: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  householdFundedCents: number;
  externalFundingCents: number;
  auditFlag: string;
  parseStatus: "needs_review" | "reconciled" | "rejected";
}

export interface FeedbackSummary {
  id: string;
  tripId: string | null;
  receiptTransactionId: string | null;
  listItemId: string | null;
  receiptItemId: string | null;
  kind: FeedbackKind;
  value: string;
  rating: number | null;
  note: string | null;
  createdByMemberId: string | null;
  createdAt: string;
}

export interface HouseholdBootstrapResponse {
  household: HouseholdSummary;
  currentUser: HouseholdMemberSummary;
  members: HouseholdMemberSummary[];
  currentTrip: TripSummary;
  recentTrips: TripSummary[];
  listItems: TripListItemSummary[];
  products: ProductSummary[];
  receiptTransactions: ReceiptTransactionSummary[];
  feedback: FeedbackSummary[];
  closedLoop: ClosedLoopReview | null;
  dashboard: DashboardViewData;
}

export interface HouseholdListResponse {
  currentTrip: TripSummary;
  listItems: TripListItemSummary[];
}

export type DataHealthTableKey =
  | "households"
  | "householdMembers"
  | "products"
  | "trips"
  | "tripListItems"
  | "receiptTransactions"
  | "receiptItems"
  | "feedback"
  | "tripIntentSnapshots"
  | "tripIntentItems"
  | "receiptUploads"
  | "productAliases"
  | "tripItemMatches"
  | "reviewQuestions";

export interface DataHealthTableCount {
  key: DataHealthTableKey;
  label: string;
  count: number;
}

export interface DataHealthReceipt {
  id: string;
  tripId: string | null;
  scheduledFor: string | null;
  purchasedAt: string;
  transactionType: ReceiptTransactionSummary["transactionType"];
  sourceType: ReceiptTransactionSummary["sourceType"];
  totalCents: number;
  itemCount: number;
  parseStatus: ReceiptTransactionSummary["parseStatus"];
  auditFlag: string;
  unmatchedLineCount: number;
}

export interface DataHealthTrip {
  id: string;
  scheduledFor: string;
  status: TripStatus;
  targetCents: number | null;
  estimatedListTotalAtFreezeCents: number | null;
  listItemCount: number;
  receiptCount: number;
  createdAt: string;
}

export interface DataHealthProduct {
  id: string;
  canonicalName: string;
  costcoItemNumber: string | null;
  category: string | null;
  categoryStatus: ProductSummary["categoryStatus"];
  active: boolean;
  receiptLineCount: number;
  updatedAt: string;
}

export interface DataHealthRecommendationEvent {
  id: string;
  tripId: string;
  scheduledFor: string;
  tripStatus: TripStatus;
  label: string;
  source: ListItemSource;
  section: ListItemSection;
  included: boolean;
  checked: boolean;
  confidenceBps: number | null;
  recommendationReason: string | null;
  estimatedPriceCents: number | null;
  createdAt: string;
}

export interface DataHealthUnmatchedLine {
  id: string;
  receiptTransactionId: string;
  purchasedAt: string;
  sourceLineNumber: number;
  rawDescription: string;
  costcoItemNumber: string | null;
  netAmountCents: number;
  matchConfidenceBps: number | null;
}

export interface DataHealthReviewQuestion {
  id: string;
  receiptTransactionId: string;
  purchasedAt: string;
  purpose: ReviewQuestionPurpose;
  prompt: string;
  priority: number;
  status: "open" | "answered" | "dismissed";
  createdAt: string;
}

export interface DataHealthFailedImport {
  id: string;
  purchasedAt: string;
  sourceType: ReceiptTransactionSummary["sourceType"];
  totalCents: number;
  parseStatus: "rejected";
  auditFlag: string;
}

export interface DataHealthResponse {
  generatedAt: string;
  source: "hosted_d1";
  tableCounts: DataHealthTableCount[];
  reconciliation: {
    totalReceipts: number;
    reconciled: number;
    needsReview: number;
    rejected: number;
    unreconciledTotalCents: number;
  };
  importTracking: {
    supportsBatchJobFailures: false;
    message: string;
  };
  unmatchedReceiptLines: DataHealthUnmatchedLine[];
  productsNeedingReview: DataHealthProduct[];
  openReviewQuestions: DataHealthReviewQuestion[];
  failedImports: DataHealthFailedImport[];
  receipts: DataHealthReceipt[];
  trips: DataHealthTrip[];
  products: DataHealthProduct[];
  recommendationEvents: DataHealthRecommendationEvent[];
}

export type HouseholdPostRequest =
  | {
      action: "add_list_item";
      tripId?: string;
      label: string;
      productId?: string | null;
      section?: ListItemSection;
      source?: ListItemSource;
      recommendationReason?: string | null;
      confidenceBps?: number | null;
      included?: boolean;
      estimatedPriceCents?: number | null;
      quantityMilli?: number;
    }
  | {
      action: "add_feedback";
      tripId?: string | null;
      receiptTransactionId?: string | null;
      listItemId?: string | null;
      receiptItemId?: string | null;
      kind: FeedbackKind;
      value: string;
      rating?: number | null;
      note?: string | null;
    }
  | {
      action: "ingest_receipt_draft";
      clientDraftId: string;
      tripId: string;
      purchasedAt: string;
      subtotalCents: number;
      taxCents: number;
      totalCents: number;
      discountCents?: number | null;
      items: ReceiptItemDraftInput[];
    }
  | {
      action: "answer_review_question";
      questionId: string;
      value: string;
      note?: string | null;
      productId?: string | null;
      replacementReceiptItemId?: string | null;
    };

export type HouseholdPatchRequest =
  | {
      action: "set_item_included";
      itemId: string;
      included: boolean;
    }
  | {
      action: "set_item_checked";
      itemId: string;
      checked: boolean;
    }
  | {
      action: "freeze_trip";
      tripId: string;
    }
  | {
      action: "unfreeze_trip";
      tripId: string;
    }
  | {
      action: "update_receipt_draft";
      receiptId: string;
      purchasedAt?: string;
      subtotalCents?: number;
      taxCents?: number;
      totalCents?: number;
      discountCents?: number | null;
      items?: ReceiptItemDraftInput[];
    }
  | {
      action: "finalize_receipt";
      receiptId: string;
    }
  | {
      action: "confirm_product_metadata";
      productId: string;
      canonicalName: string;
      category: string;
      expectedUpdatedAt: string;
    };
