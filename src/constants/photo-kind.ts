export const PHOTO_KIND = {
  BEFORE: "before",
  AFTER: "after",
  EXTRA: "extra",
} as const;

export type PhotoKind = (typeof PHOTO_KIND)[keyof typeof PHOTO_KIND];
