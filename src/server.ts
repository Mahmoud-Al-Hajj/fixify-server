import { env } from "./config/env";
import { assertDbReachable, assertDbClockIsBeirut } from "./models-db/pool";
import { app } from "./app";
import { logger } from "./config/logger";

async function start(): Promise<void> {
  await assertDbReachable();
  await assertDbClockIsBeirut();
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
