export const VISIT_STATUS = {
  SCHEDULED: "scheduled",
  EN_ROUTE: "en_route",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;

export type VisitStatus = (typeof VISIT_STATUS)[keyof typeof VISIT_STATUS];

// Visits that still hold their slot and can still move; done and cancelled
// visits are final.
export const OPEN_VISIT_STATUSES: readonly VisitStatus[] = [
  VISIT_STATUS.SCHEDULED,
  VISIT_STATUS.EN_ROUTE,
  VISIT_STATUS.IN_PROGRESS,
];
