import type { Request, Response } from "express";
import * as authService from "../libraries/auth";
import type {
  RegisterBody,
  LoginBody,
  ForgotPasswordBody,
  ResetPasswordBody,
} from "../routes/auth.schema";

export async function registerHandler(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body as RegisterBody;
  const { user, token } = await authService.register(body);
  res.status(201).json({ user, token });
}

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginBody;
  const { user, token } = await authService.login(email, password);
  res.status(200).json({ user, token });
}

export async function forgotPasswordHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { email } = req.body as ForgotPasswordBody;
  const resetToken = await authService.requestPasswordReset(email);
  res.status(200).json({
    message: "If that email is registered, a reset token has been issued.",
    resetToken,
  });
}

export async function resetPasswordHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { token, newPassword } = req.body as ResetPasswordBody;
  await authService.resetPassword(token, newPassword);
  res.status(200).json({ message: "Password has been reset." });
}
