import { createApp } from "./app.js";
import { storageFromEnv } from "./store.js";

const PORT = parseInt(process.env.PORT || "8790", 10);

const store = storageFromEnv(process.env);
const app = createApp(process.env, store);

// eslint-disable-next-line no-undef
Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[xcr] http :${PORT} (GET /health, GET /v2/)`);
console.log(`[xcr] storage ${store.mode}`);
