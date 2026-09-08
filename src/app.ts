import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env";
import { requestId } from "./middlewares/request-id";
import { notFoundHandler } from "./middlewares/not-found";
import { errorHandler } from "./middlewares/error-handler";
import { categoriesRouter } from "./routes/categories";

export const app = express();

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

// Unmatched route → 404 in the standard error shape
app.use(notFoundHandler);

// Central error handler — MUST be last, and MUST take four arguments
app.use(errorHandler);
