import { env } from "./config/env";
import { assertDbReachable, assertDbClockIsBeirut } from "./models-db/pool";
import { assertCategoriesMatchConstants } from "./models-db/categories";
import { failPendingAnalyses } from "./models-db/intake";
import { beirutNow } from "./models-db/format-datetime";
import { expirePendingRequests } from "./libraries/requests";
import { EXPIRY_SWEEP_MINUTES } from "./constants/booking";
import { app } from "./app";
import { logger } from "./config/logger";

async function start(): Promise<void> {
  await assertDbReachable();
  await assertDbClockIsBeirut();
  await assertCategoriesMatchConstants();
  // Before listening: with one process, any pending analysis died with the
  // previous run (docs/ai-plan.md §12.5).
  const swept = await failPendingAnalyses();
  if (swept > 0) {
    logger.info("marked interrupted analyses failed", { sessions: swept });
  }
  if (!env.gemini) {
    logger.warn(
      "AI is not configured (GEMINI_API_KEY, GEMINI_MODEL): diagnoses return 503"
    );
  }
  app.listen(env.port, () => {
    logger.info(`listening on ${env.port}`);
  });
  sweepExpiredRequests();
  setInterval(sweepExpiredRequests, EXPIRY_SWEEP_MINUTES * 60_000);
}

// Cancels stale pending requests (request_expired). A failed run is logged
// and the next one tries again.
function sweepExpiredRequests(): void {
  expirePendingRequests(beirutNow()).then(
    (expired) => {
      if (expired > 0) {
        logger.info("expired pending requests", { expired });
      }
    },
    (err: unknown) => {
      logger.error("pending request expiry failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  );
}

// A refused connection to "localhost" is an AggregateError (Node tries ::1 and
// 127.0.0.1) with an empty message; its inner errors carry the cause.
function startupError(err: unknown): { error: string; code?: string } {
  const code =
    err instanceof Error && "code" in err ? String(err.code) : undefined;
  const causes =
    err instanceof AggregateError
      ? err.errors
          .map((inner: unknown) =>
            inner instanceof Error ? inner.message : String(inner)
          )
          .join("; ")
      : err instanceof Error
        ? err.message
        : String(err);
  const hint =
    code === "ECONNREFUSED"
      ? ` (is MySQL running at ${env.db.host}:${env.db.port}?)`
      : "";
  return { error: causes + hint, ...(code ? { code } : {}) };
}

start().catch((err: unknown) => {
  logger.error("failed to start", startupError(err));
  process.exit(1);
});
