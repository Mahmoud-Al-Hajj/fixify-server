import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { authRateLimiter } from "../middlewares/rate-limit";
import { validateBody } from "../middlewares/validate";
import { updateCurrentUserSchema, changePasswordSchema } from "./users.schema";
import {
  getCurrentUserHandler,
  updateCurrentUserHandler,
  changePasswordHandler,
} from "../controllers/users";

export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.get("/me", getCurrentUserHandler);
usersRouter.patch(
  "/me",
  validateBody(updateCurrentUserSchema),
  updateCurrentUserHandler
);
// Rate limited like the auth endpoints: it verifies a password, so a stolen
// token could otherwise be used to guess it.
usersRouter.post(
  "/me/password",
  authRateLimiter,
  validateBody(changePasswordSchema),
  changePasswordHandler
);
