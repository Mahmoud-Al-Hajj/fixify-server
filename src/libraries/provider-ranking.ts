import { PROVIDER_SORT, type ProviderSort } from "../constants/provider-sort";

// The fields a search result is ordered by.
export interface RankableMatch {
  rating: { average: number | null };
  // DECIMAL string for the searched trade; null when the provider set none.
  baseRate: string | null;
  // The first suggested slot; null when fully booked over the horizon.
  earliestSlot: string | null;
}

type Comparator = (a: RankableMatch, b: RankableMatch) => number;

// Best rated first; unrated last.
const byRating: Comparator = (a, b) =>
  (b.rating.average ?? -1) - (a.rating.average ?? -1);

// Soonest slot first; fully booked last. Wall-clock ISO strings compare
// correctly by code unit; localeCompare would not (it sorts "~" before digits,
// which put fully booked providers first).
const bySlot: Comparator = (a, b) => {
  if (a.earliestSlot === null || b.earliestSlot === null) {
    return (
      (a.earliestSlot === null ? 1 : 0) - (b.earliestSlot === null ? 1 : 0)
    );
  }
  return a.earliestSlot < b.earliestSlot
    ? -1
    : a.earliestSlot > b.earliestSlot
      ? 1
      : 0;
};

// Lowest rate first; no rate last. Compared as numbers, returned as strings.
const byPrice: Comparator = (a, b) => {
  if (a.baseRate === null || b.baseRate === null) {
    return (a.baseRate === null ? 1 : 0) - (b.baseRate === null ? 1 : 0);
  }
  return Number(a.baseRate) - Number(b.baseRate);
};

const ORDER: Record<ProviderSort, readonly Comparator[]> = {
  [PROVIDER_SORT.RATING]: [byRating, bySlot],
  [PROVIDER_SORT.PRICE]: [byPrice, byRating, bySlot],
  [PROVIDER_SORT.AVAILABILITY]: [bySlot, byRating],
};

// Deterministic search order (no AI). Full ties keep the input order, which
// is name order from SQL: Array.prototype.sort is stable.
export function sortMatches<T extends RankableMatch>(
  matches: readonly T[],
  sort: ProviderSort
): T[] {
  const comparators = ORDER[sort];
  return [...matches].sort((a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}
