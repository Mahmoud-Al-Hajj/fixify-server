import type { Request, Response } from "express";
import * as notificationsService from "../libraries/notifications";
import { requireUser } from "../middlewares/authenticate";
import type { MarkNotificationsReadBody } from "../routes/notifications.schema";

export async function getNotificationsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = requireUser(req);
  res.status(200).json(await notificationsService.getFeed(user.id));
}

export async function markNotificationsReadHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = requireUser(req);
  const { readUpTo } = req.body as MarkNotificationsReadBody;
  const unreadCount = await notificationsService.markRead(user.id, readUpTo);
  res.status(200).json({ unreadCount });
}
