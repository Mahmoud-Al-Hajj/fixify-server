import type { Request, Response } from "express";
import * as intakeService from "../libraries/intake";
import { requireUser } from "../middlewares/authenticate";
import type { PhotoLocals } from "../middlewares/upload";
import type { CustomerTurnBody } from "../routes/intake.schema";

export async function createIntakeSessionHandler(
  req: Request,
  res: Response<unknown, PhotoLocals>
): Promise<void> {
  const customer = requireUser(req);
  const { body } = req.body as CustomerTurnBody;
  const session = await intakeService.createIntakeSession(customer.id, {
    body: body ?? null,
    photos: res.locals.photos,
  });
  res.status(201).json({ session });
}
