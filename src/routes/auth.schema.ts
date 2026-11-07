import { z } from "zod";

export const phoneRegex = /^[0-9+\-\s()]{6,30}$/;

export const registerSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(phoneRegex, "Invalid phone number"),
  password: z.string().min(8).max(72),
  becomeProvider: z
    .object({
      bio: z.string().trim().min(1).max(1000).optional(),
      yearsExperience: z.number().int().min(0).max(70).optional(),
      categoryIds: z.array(z.number().int().positive()).min(1),
    })
    .optional(),
});
export type RegisterBody = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(255),
});
export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1),
  newPassword: z.string().min(8).max(72),
});
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
