import { AI_STATUS, type AiStatus } from "../constants/ai-status";
import type { ServiceType } from "../constants/service-type";
import type { Diagnosis } from "./ai/diagnosis-schema";

// What a booking from an intake session takes from it (docs/ai-plan.md §7,
// §13.2). Pure, so the whole derivation table is unit-tested.

const MAX_DESCRIPTION_CHARS = 2000;

interface DerivedBookingFields {
  usedDiagnosis: boolean;
  serviceType: ServiceType | null;
  estimatedDurationMinutes: number | null;
  parts: Diagnosis["suggestedParts"];
}

// The diagnosis is used only when it is done and the customer kept its trade.
// A diagnosis with a null category never matches a chosen one.
export function deriveBookingFields(
  session: { aiStatus: AiStatus; diagnosis: Diagnosis | null },
  chosenCategoryName: string
): DerivedBookingFields {
  const d = session.aiStatus === AI_STATUS.DONE ? session.diagnosis : null;
  if (d && d.category === chosenCategoryName) {
    return {
      usedDiagnosis: true,
      serviceType: d.serviceType,
      estimatedDurationMinutes: d.durationMinutes,
      parts: d.suggestedParts,
    };
  }
  return {
    usedDiagnosis: false,
    serviceType: null,
    estimatedDurationMinutes: null,
    parts: [],
  };
}

// The customer's own words in order, a blank line between turns. null when
// no turn has text.
export function buildDescription(
  customerBodies: readonly (string | null)[]
): string | null {
  const text = customerBodies
    .map((body) => body?.trim())
    .filter((body): body is string => Boolean(body))
    .join("\n\n");
  return text ? text.slice(0, MAX_DESCRIPTION_CHARS) : null;
}
