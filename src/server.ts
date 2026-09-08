import { env } from "./config/env";
import { assertDbReachable } from "./models-db/pool";
import { app } from "./app";

async function start(): Promise<void> {
  await assertDbReachable();
  app.listen(env.port, () => {
    // replace with your logger once it exists
    process.stdout.write(`listening on ${env.port}\n`);
  });
}

start().catch((err) => {
  process.stderr.write(`failed to start: ${String(err)}\n`);
  process.exit(1);
});
