export const JOB_EVENT_TYPE = {
  REQUEST_CREATED: "request_created",
  REQUEST_REJECTED: "request_rejected",
  REQUEST_CANCELLED: "request_cancelled",
} as const;

export type JobEventType = (typeof JOB_EVENT_TYPE)[keyof typeof JOB_EVENT_TYPE];
