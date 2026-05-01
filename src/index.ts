import { pathToFileURL } from "node:url";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

async function main() {
  const config = readConfig();
  const app = buildApp(config);

  try {
    await app.listen({
      host: "0.0.0.0",
      port: config.PORT,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const entrypointPath = process.argv[1];
if (entrypointPath && import.meta.url === pathToFileURL(entrypointPath).href) {
  void main();
}

export { createWorkflowOutcome } from "./workflows/lead-workflow.js";
export { buildJobberClientCreateSync } from "./integrations/jobber.js";
