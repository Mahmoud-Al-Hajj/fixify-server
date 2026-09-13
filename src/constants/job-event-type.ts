export const JOB_EVENT_TYPE = {
  REQUEST_CREATED: "request_created",
  REQUEST_REJECTED: "request_rejected",
  REQUEST_CANCELLED: "request_cancelled",
  REQUEST_STARTED: "request_started",
  REQUEST_COMPLETED: "request_completed",
  REQUEST_PAID: "request_paid",
  QUOTE_PROPOSED: "quote_proposed",
  QUOTE_ACCEPTED: "quote_accepted",
  QUOTE_DECLINED: "quote_declined",
  REVIEW_CREATED: "review_created",
} as const;

export type JobEventType = (typeof JOB_EVENT_TYPE)[keyof typeof JOB_EVENT_TYPE];
