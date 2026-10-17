// Orders for provider search (GET /providers?sort=). Query values only; no
// column stores them.
export const PROVIDER_SORT = {
  RATING: "rating",
  PRICE: "price",
  AVAILABILITY: "availability",
} as const;

export type ProviderSort = (typeof PROVIDER_SORT)[keyof typeof PROVIDER_SORT];
