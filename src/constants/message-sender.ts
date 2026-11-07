export const MESSAGE_SENDER = {
  CUSTOMER: "customer",
  AI: "ai",
} as const;

export type MessageSender =
  (typeof MESSAGE_SENDER)[keyof typeof MESSAGE_SENDER];
