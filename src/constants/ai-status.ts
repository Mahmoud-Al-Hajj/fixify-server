export const AI_STATUS = {
  NONE: "none",
  PENDING: "pending",
  DONE: "done",
  FAILED: "failed",
} as const;

export type AiStatus = (typeof AI_STATUS)[keyof typeof AI_STATUS];
