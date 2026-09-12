import { Router } from "express";
import { validateBody } from "../middlewares/validate";
import { authRateLimiter } from "../middlewares/rate-limit";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.schema";
import {
  registerHandler,
  loginHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
} from "../controllers/auth";

export const authRouter = Router();

authRouter.use(authRateLimiter);

authRouter.post("/register", validateBody(registerSchema), registerHandler);
authRouter.post("/login", validateBody(loginSchema), loginHandler);
authRouter.post(
  "/forgot-password",
  validateBody(forgotPasswordSchema),
  forgotPasswordHandler
);
authRouter.post(
  "/reset-password",
  validateBody(resetPasswordSchema),
  resetPasswordHandler
);
