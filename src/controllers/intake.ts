import type { Request, Response, NextFunction } from "express";
import * as intakeService from "../libraries/intake";
import { requireUser } from "../middlewares/authenticate";
import { NotFoundError } from "../constants/errors";
import type { PhotoLocals } from "../middlewares/upload";
import type { ParamsLocals } from "../middlewares/validate";
import type { IntakeMessage } from "../models-db/intake";
import type {
  CustomerTurnBody,
  SessionIdParams,
  SessionPhotoParams,
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

// The diagnosis stays null until the intake-diagnosis AI step exists.
export async function getIntakeSessionHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<SessionIdParams>>
): Promise<void> {
  const customer = requireUser(req);
  const { session, messages } = await intakeService.getOwnSession(
    res.locals.params.id,
    customer.id
  );
  res.status(200).json({
    session: {
      id: session.id,
      aiStatus: session.aiStatus,
      diagnosis: null,
      requestId: session.requestId,
      createdAt: session.createdAt,
      messages: messages.map((message) => toMessageView(session.id, message)),
    },
  });
}

export async function getIntakePhotoHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<SessionPhotoParams>>,
  next: NextFunction
): Promise<void> {
  const user = requireUser(req);
  const { id, photoId } = res.locals.params;
  const filePath = await intakeService.getIntakePhotoPath(id, photoId, user.id);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      next(new NotFoundError("Photo not found"));
    }
  });
}
