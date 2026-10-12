import { createApp } from "./app.js";

// Worker-style entrypoint (same as xps/src/index.js).
// Local: Bun.serve consumes it via dev.js. Lambda: see src/lambda.js.
const app = createApp(process.env);

export default { fetch: app.fetch };
export { app };
