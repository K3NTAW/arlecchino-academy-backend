import { createApp } from "./app";
import { createAIProvider } from "./ai/provider";
import { env } from "./config";
import { DatabaseService } from "./db";
import { logInfo } from "./logger";

const db = new DatabaseService(env.DATABASE_URL);

void (async () => {
  await db.init();
  const app = createApp(createAIProvider(), db);
  app.listen(env.PORT, () => {
    logInfo("server.started", { port: env.PORT });
  });
})();
