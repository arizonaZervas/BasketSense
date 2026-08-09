import assert from "node:assert/strict";
import test from "node:test";

import {
  isHouseholdListMutationAction,
  isHouseholdListSnapshotCurrent,
  mergeHouseholdListMutation,
  parseHouseholdListMutationResponse,
} from "../app/household-list-sync.ts";

const trip = {
  id: "trip-1",
  listRevision: 4,
};

const item = {
  id: "item-1",
  tripId: "trip-1",
  productId: null,
  label: "Milk",
  section: "essentials",
  source: "manual",
  recommendationReason: null,
  confidenceBps: null,
  included: true,
  checked: false,
  includedAtFreeze: null,
  addedAfterFreeze: false,
  estimatedPriceCents: null,
  quantityMilli: 1000,
  sortOrder: 1,
  addedByMemberId: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

test("only List item writes bypass the full household refresh", () => {
  for (const action of [
    "add_list_item",
    "set_item_included",
    "set_item_checked",
  ]) {
    assert.equal(isHouseholdListMutationAction(action), true);
  }
  for (const action of [
    "freeze_trip",
    "finalize_receipt",
    "confirm_product_metadata",
    undefined,
  ]) {
    assert.equal(isHouseholdListMutationAction(action), false);
  }
});

test("list mutation responses are validated before client state is changed", () => {
  assert.equal(parseHouseholdListMutationResponse(null), null);
  assert.equal(
    parseHouseholdListMutationResponse({ item, listRevision: -1 }),
    null,
  );
  assert.equal(
    parseHouseholdListMutationResponse({
      item: { ...item, checked: "yes" },
      listRevision: 5,
    }),
    null,
  );
  assert.deepEqual(
    parseHouseholdListMutationResponse({ item, listRevision: 5 }),
    { item, listRevision: 5 },
  );
});

test("delayed List snapshots cannot replace newer client revisions", () => {
  assert.equal(
    isHouseholdListSnapshotCurrent(trip, { ...trip, listRevision: 3 }),
    false,
  );
  assert.equal(
    isHouseholdListSnapshotCurrent(trip, { ...trip, listRevision: 4 }),
    true,
  );
  assert.equal(
    isHouseholdListSnapshotCurrent(trip, { ...trip, id: "trip-2" }),
    false,
  );
});

test("authoritative mutation items replace optimistic state without a snapshot", () => {
  const optimistic = { ...item, checked: true };
  const authoritative = {
    item: { ...item, checked: true, updatedAt: "2026-08-09T00:00:01.000Z" },
    listRevision: 5,
  };
  const merged = mergeHouseholdListMutation(
    trip,
    [optimistic],
    authoritative,
  );
  assert.ok(merged);
  assert.equal(merged.currentTrip.listRevision, 5);
  assert.deepEqual(merged.listItems, [authoritative.item]);
});

test("new items are inserted in server order and stale responses are ignored", () => {
  const laterItem = {
    ...item,
    id: "item-2",
    label: "Bananas",
    sortOrder: 2,
  };
  const inserted = mergeHouseholdListMutation(trip, [laterItem], {
    item,
    listRevision: 5,
  });
  assert.ok(inserted);
  assert.deepEqual(
    inserted.listItems.map((candidate) => candidate.id),
    ["item-1", "item-2"],
  );
  assert.equal(
    mergeHouseholdListMutation(
      { ...trip, listRevision: 6 },
      inserted.listItems,
      { item: { ...item, checked: true }, listRevision: 5 },
    ),
    null,
  );
});

test("a partner-before-local revision gap remains eligible for recovery polling", () => {
  const partnerItem = {
    ...item,
    id: "item-2",
    label: "Bananas",
    sortOrder: 2,
  };
  const merged = mergeHouseholdListMutation(trip, [item, partnerItem], {
    item: { ...item, checked: true },
    listRevision: 6,
  });
  assert.ok(merged);
  assert.equal(merged.currentTrip.listRevision, 4);
  assert.equal(merged.listItems[0].checked, true);
});
