export const ITEM_SOURCE = {
  AI: "ai",
  PROVIDER: "provider",
} as const;

export type ItemSource = (typeof ITEM_SOURCE)[keyof typeof ITEM_SOURCE];
