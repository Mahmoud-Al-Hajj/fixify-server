export const PRICE_STATUS = {
  NONE: "none",
  PROPOSED: "proposed",
  ACCEPTED: "accepted",
  DECLINED: "declined",
} as const;

export type PriceStatus = (typeof PRICE_STATUS)[keyof typeof PRICE_STATUS];
