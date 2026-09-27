import type { Request, Response } from "express";
import * as intakeService from "../libraries/intake";
import { requireUser } from "../middlewares/authenticate";
import type { PhotoLocals } from "../middlewares/upload";
import type { ParamsLocals } from "../middlewares/validate";
import type { IntakeMessage } from "../models-db/intake";
import type {
  CustomerTurnBody,
  SessionIdParams,
} from "../routes/intake.schema";

export async function createIntakeSessionHandler(
  req: Request,
  res: Response<unknown, PhotoLocals>
): Promise<void> {
  const customer = requireUser(req);
  const { body } = req.body as CustomerTurnBody;
  const { id, aiStatus, createdAt } = await intakeService.createIntakeSession(
    customer.id,
    { body: body ?? null, photos: res.locals.photos }
  );
  res.status(201).json({ session: { id, aiStatus, createdAt } });
}

// Photos are exposed as the authenticated route that serves them, never as
// the storage path.
function toMessageView(sessionId: string, message: IntakeMessage) {
  return {
    ...message,
    photos: message.photos.map((photo) => ({
      id: photo.id,
      url: `/intake-sessions/${sessionId}/photos/${photo.id}`,
    })),
  };
}

export async function addCustomerMessageHandler(
  req: Request,
  res: Response<unknown, PhotoLocals & ParamsLocals<SessionIdParams>>
): Promise<void> {
  const customer = requireUser(req);
  const { body } = req.body as CustomerTurnBody;
  const sessionId = res.locals.params.id;
  const message = await intakeService.addCustomerMessage(
    sessionId,
    customer.id,
    { body: body ?? null, photos: res.locals.photos }
  );
  res.status(201).json({ message: toMessageView(sessionId, message) });
}
