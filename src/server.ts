import { env } from "./config/env";
import { assertDbReachable, assertDbClockIsBeirut } from "./models-db/pool";
import { assertCategoriesMatchConstants } from "./models-db/categories";
import { failPendingAnalyses } from "./models-db/intake";
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
