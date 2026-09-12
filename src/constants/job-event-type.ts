export const JOB_EVENT_TYPE = {
  REQUEST_CREATED: "request_created",
} as const;

export type JobEventType = (typeof JOB_EVENT_TYPE)[keyof typeof JOB_EVENT_TYPE];
