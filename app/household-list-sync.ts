import type {
  HouseholdListMutationResponse,
  TripListItemSummary,
} from "./api/household/types";

const LIST_ITEM_SECTIONS = new Set([
  "essentials",
  "suggested",
  "check_first",
  "consider",
]);

const LIST_ITEM_SOURCES = new Set([
  "manual",
  "recurring",
  "predicted",
  "consider",
  "in_store",
]);

function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown) {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isTripListItemSummary(value: unknown): value is TripListItemSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.tripId === "string" &&
    nullableString(item.productId) &&
    typeof item.label === "string" &&
    typeof item.section === "string" &&
    LIST_ITEM_SECTIONS.has(item.section) &&
    typeof item.source === "string" &&
    LIST_ITEM_SOURCES.has(item.source) &&
    nullableString(item.recommendationReason) &&
    nullableInteger(item.confidenceBps) &&
    typeof item.included === "boolean" &&
    typeof item.checked === "boolean" &&
    (item.includedAtFreeze === null ||
      typeof item.includedAtFreeze === "boolean") &&
    typeof item.addedAfterFreeze === "boolean" &&
    nullableInteger(item.estimatedPriceCents) &&
    typeof item.quantityMilli === "number" &&
    Number.isSafeInteger(item.quantityMilli) &&
    typeof item.sortOrder === "number" &&
    Number.isSafeInteger(item.sortOrder) &&
    nullableString(item.addedByMemberId) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

export function isHouseholdListMutationAction(value: unknown) {
  return (
    value === "add_list_item" ||
    value === "set_item_included" ||
    value === "set_item_checked"
  );
}

export function isHouseholdListSnapshotCurrent(
  currentTrip: { id: string; listRevision: number },
  snapshotTrip: { id: string; listRevision: number },
) {
  return (
    snapshotTrip.id === currentTrip.id &&
    snapshotTrip.listRevision >= currentTrip.listRevision
  );
}

export function parseHouseholdListMutationResponse(
  value: unknown,
): HouseholdListMutationResponse | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const revision = response.listRevision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !isTripListItemSummary(response.item)
  ) {
    return null;
  }
  return {
    item: response.item,
    listRevision: revision,
  };
}

export function mergeHouseholdListMutation<
  TTrip extends { id: string; listRevision: number },
>(
  currentTrip: TTrip,
  listItems: readonly TripListItemSummary[],
  mutation: HouseholdListMutationResponse,
) {
  if (
    mutation.item.tripId !== currentTrip.id ||
    mutation.listRevision < currentTrip.listRevision
  ) {
    return null;
  }

  const hasItem = listItems.some((item) => item.id === mutation.item.id);
  const nextItems = (hasItem
    ? listItems.map((item) =>
        item.id === mutation.item.id ? mutation.item : item,
      )
    : [...listItems, mutation.item]
  ).sort(
    (left, right) =>
      left.sortOrder - right.sortOrder ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const hasUnseenRevision =
    mutation.listRevision > currentTrip.listRevision + 1;

  return {
    currentTrip: {
      ...currentTrip,
      // A gap means another writer changed the List before this mutation. Apply
      // the authoritative local item now, but keep the older revision so the
      // recovery poll cannot receive a false 204 and skip the partner change.
      listRevision: hasUnseenRevision
        ? currentTrip.listRevision
        : mutation.listRevision,
    },
    listItems: nextItems,
  };
}
