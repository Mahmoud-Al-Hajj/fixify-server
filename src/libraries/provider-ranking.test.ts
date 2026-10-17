import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_SORT } from "../constants/provider-sort";
import { sortMatches } from "./provider-ranking";

// Search results in SQL (name) order: a mix of rated/unrated, priced/unpriced
// and fully booked providers, plus exact ties.
const M = (
  name: string,
  average: number | null,
  baseRate: string | null,
  earliestSlot: string | null
) => ({ name, rating: { average }, baseRate, earliestSlot });

const ALI = M("Ali", 4.5, "40.00", "2026-10-20T09:00:00.000");
const BEA = M("Bea", null, "25.00", "2026-10-19T08:00:00.000");
const CAM = M("Cam", 4.5, null, "2026-10-19T10:00:00.000");
const DAN = M("Dan", 3.0, "25.00", null);
const EVE = M("Eve", 5.0, "30.00", "2026-10-21T07:00:00.000");
const FAY = M("Fay", 3.0, "25.00", null);
const IN_NAME_ORDER = [ALI, BEA, CAM, DAN, EVE, FAY];

const names = (list: ReadonlyArray<{ name: string }>) =>
  list.map((m) => m.name);

test("rating (default): best rated first, unrated last; ties by earliest slot, then name", () => {
  assert.deepEqual(names(sortMatches(IN_NAME_ORDER, PROVIDER_SORT.RATING)), [
    "Eve", // 5.0
    "Cam", // 4.5, slot 19th
    "Ali", // 4.5, slot 20th
    "Dan", // 3.0, fully booked: tie with Fay, name order kept
    "Fay",
    "Bea", // unrated
  ]);
});

// The order before this change used localeCompare, which sorts "~" before
// digits and so put a fully booked provider ahead of an equally rated one with
// a free slot.
test("rating: an equally rated provider with a free slot goes before a fully booked one", () => {
  const booked = M("Booked", 4.0, null, null);
  const free = M("Free", 4.0, null, "2026-10-19T08:00:00.000");
  assert.deepEqual(names(sortMatches([booked, free], PROVIDER_SORT.RATING)), [
    "Free",
    "Booked",
  ]);
});

test("price: lowest rate first, no rate last; ties by rating, then slot", () => {
  assert.deepEqual(names(sortMatches(IN_NAME_ORDER, PROVIDER_SORT.PRICE)), [
    "Dan", // 25, rated 3.0, fully booked: tie with Fay, name order kept
    "Fay",
    "Bea", // 25, unrated
    "Eve", // 30
    "Ali", // 40
    "Cam", // no rate
  ]);
});

test("price compares amounts as numbers, not strings", () => {
  const cheap = M("Cheap", null, "9.50", null);
  const dear = M("Dear", null, "10.00", null);
  assert.deepEqual(names(sortMatches([dear, cheap], PROVIDER_SORT.PRICE)), [
    "Cheap",
    "Dear",
  ]);
});

test("availability: soonest slot first, fully booked last; ties by rating", () => {
  assert.deepEqual(
    names(sortMatches(IN_NAME_ORDER, PROVIDER_SORT.AVAILABILITY)),
    [
      "Bea", // 19th 08:00
      "Cam", // 19th 10:00
      "Ali", // 20th
      "Eve", // 21st
      "Dan", // fully booked, rated 3.0: tie with Fay, name order kept
      "Fay",
    ]
  );
});

test("availability: an equal slot goes to the better rated", () => {
  const slot = "2026-10-19T08:00:00.000";
  const low = M("Low", 2.0, null, slot);
  const high = M("High", 4.0, null, slot);
  assert.deepEqual(
    names(sortMatches([low, high], PROVIDER_SORT.AVAILABILITY)),
    ["High", "Low"]
  );
});

test("sortMatches does not reorder its input", () => {
  const input = [...IN_NAME_ORDER];
  sortMatches(input, PROVIDER_SORT.PRICE);
  assert.deepEqual(names(input), names(IN_NAME_ORDER));
});
