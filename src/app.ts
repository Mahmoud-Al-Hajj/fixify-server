import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env";
import { requestId } from "./middlewares/request-id";
import { notFoundHandler } from "./middlewares/not-found";
import { errorHandler } from "./middlewares/error-handler";
import { categoriesRouter } from "./routes/categories";
import { districtsRouter } from "./routes/districts";
import { authRouter } from "./routes/auth";
import { requestsRouter } from "./routes/requests";
import { providersRouter } from "./routes/providers";
import { usersRouter } from "./routes/users";
import { intakeRouter } from "./routes/intake";
import { notificationsRouter } from "./routes/notifications";
import { docsRouter } from "./routes/docs";

export const app = express();

// Caddy on the same host proxies to 127.0.0.1:3000; trust only that hop so
// req.ip is the client's address from X-Forwarded-For, not 127.0.0.1.
app.set("trust proxy", "loopback");

app.use(helmet());

// CORS — explicit allowlist, never a wildcard
app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true,
  })
);

app.use(requestId);

app.use(express.json({ limit: "100kb" }));

// Liveness probe — no DB, no auth
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Feature routes
app.use("/categories", categoriesRouter);
app.use("/districts", districtsRouter);
app.use("/auth", authRouter);
app.use("/requests", requestsRouter);
app.use("/providers", providersRouter);
app.use("/users", usersRouter);
app.use("/intake-sessions", intakeRouter);
app.use("/notifications", notificationsRouter);

// OpenAPI spec and Swagger UI
app.use("/docs", docsRouter);

// Unmatched route → 404 in the standard error shape
app.use(notFoundHandler);

// Central error handler — MUST be last, and MUST take four arguments
app.use(errorHandler);
