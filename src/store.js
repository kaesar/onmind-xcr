import { fsStore } from "./fsStore.js";
import { s3Store } from "./s3Store.js";

// Mirror of xps/src/store.js: explicit backend, fail loud on typo.
// filesystem = local tests (zero deps). s3 = AWS / RustFS / Floci via endpoint.
export function storageFromEnv(env = process.env) {
  const raw = env.XCR_STORAGE || "filesystem";
  const mode = String(raw).toLowerCase();
  if (mode === "filesystem" || mode === "fs") return fsStore(env.XCR_DATA_DIR || "./xcr-data");
  if (mode === "s3") return s3Store(env);
  throw new Error(`xcr: unknown XCR_STORAGE=${JSON.stringify(raw)} (use "filesystem" or "s3")`);
}
