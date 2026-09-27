import type { Request, Response } from "express";
import * as usersService from "../libraries/users";
import { requireUser } from "../middlewares/authenticate";
import type {
  UpdateCurrentUserBody,
  ChangePasswordBody,
} from "../routes/users.schema";

export async function getCurrentUserHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { id } = requireUser(req);
  const user = await usersService.getCurrentUser(id);
  res.status(200).json({ user });
}

export async function updateCurrentUserHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { id } = requireUser(req);
  const changes = req.body as UpdateCurrentUserBody;
  const user = await usersService.updateCurrentUser(id, changes);
  res.status(200).json({ user });
}

export async function changePasswordHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { id } = requireUser(req);
  const { currentPassword, newPassword } = req.body as ChangePasswordBody;
  await usersService.changePassword(id, currentPassword, newPassword);
  res.status(200).json({ message: "Password has been changed." });
}
