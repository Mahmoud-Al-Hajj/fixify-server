import { z } from "zod";
import { phoneRegex } from "./auth.schema";
import { requireAtLeastOneField } from "./partial-update.schema";

// Strict so a misspelled or unsupported field (e.g. "email", which is not
// editable here) is a 400 rather than a silent 200 that changed nothing.
export const updateCurrentUserSchema = requireAtLeastOneField(
  z.strictObject({
    fullName: z.string().trim().min(1).max(120).optional(),
    phone: z
      .string()
      .trim()
      .regex(phoneRegex, "Invalid phone number")
      .optional(),
  })
);
export type UpdateCurrentUserBody = z.infer<typeof updateCurrentUserSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(72),
});
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
