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

start().catch((err) => {
  logger.error("failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
