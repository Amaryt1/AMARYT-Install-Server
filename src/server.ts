import { buildApp } from "./app.js";
import { readConfig } from "./config/index.js";
try {
  const config = readConfig(process.env);
  const { app } = await buildApp(config, { logger: true });
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => {
      void app.close();
    });
  await app.listen({ port: config.port, host: config.host });
} catch {
  console.error(
    "Startup failed. Check service configuration, storage permissions and listening port.",
  );
  process.exitCode = 1;
}
