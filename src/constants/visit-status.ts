export const VISIT_STATUS = {
  SCHEDULED: "scheduled",
  EN_ROUTE: "en_route",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;

export type VisitStatus = (typeof VISIT_STATUS)[keyof typeof VISIT_STATUS];
