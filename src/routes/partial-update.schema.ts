import { z } from "zod";

// A partial-update body is validated in two sequential steps:
//   1. the strict object schema alone — unknown keys, types, lengths;
//   2. only if step 1 produced no issues at all, "at least one field present".
// The `when` guard is what enforces the order. Without it Zod still runs the
// refinement after an unknown-key issue, because that issue doesn't abort
// parsing — a body containing only a misspelled key would then also be told
// that no field was provided.
export function requireAtLeastOneField<T extends z.ZodType<object>>(fields: T) {
  return fields.refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
    when: (payload) => payload.issues.length === 0,
  });
}
