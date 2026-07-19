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
  | "regret_signal";

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
  brand: string | null;
  unitDescription: string | null;
  active: boolean;
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
    };
