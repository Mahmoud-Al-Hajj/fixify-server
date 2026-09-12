import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateBody } from "../middlewares/validate";
import { createRequestSchema } from "./requests.schema";
import { createRequestHandler } from "../controllers/requests";

export const requestsRouter = Router();

requestsRouter.use(authenticate);

requestsRouter.post(
  "/",
  validateBody(createRequestSchema),
  createRequestHandler
);
