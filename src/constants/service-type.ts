export const SERVICE_TYPE = {
  REPAIR: "repair",
  INSTALLATION: "installation",
  MAINTENANCE: "maintenance",
  INSPECTION: "inspection",
  OTHER: "other",
} as const;

export type ServiceType = (typeof SERVICE_TYPE)[keyof typeof SERVICE_TYPE];
