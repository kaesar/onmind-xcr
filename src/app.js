import { Hono } from "hono";
import { cors } from "hono/cors";
import { storageFromEnv } from "./store.js";
import { validateName, validateTag, validateDigest, isDigest, sha256Digest } from "./validate.js";
import { nowIso, newToken, parseN } from "./ids.js";

const MANIFEST_CT_RE = /json|manifest|oci/i;

function ociError(code, message, status = 404) {
  return { status, body: { errors: [{ code, message }] } };
}

function uploadLocation(name, uuid) {
  return `/v2/${name}/blobs/uploads/${uuid}`;
}

export function createApp(env = process.env, storage = null) {
  const app = new Hono();
  const store = storage ?? storageFromEnv(env);
  const API_KEY = env.XCR_API_KEY || "";

  const origins = (env.XCR_CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  app.use("*", cors({ origin: origins.includes("*") ? "*" : origins }));
  app.use("*", apiKeyGuard(API_KEY));

  app.onError((err, c) => {
    console.error("[OnMind-XCR] unhandled:", err);
    if (c.req.path.startsWith("/v2/")) {
      return c.json({ errors: [{ code: "UNKNOWN", message: "Internal error" }] }, 500);
    }
    return c.json({ message: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, env: env.XCR_ENV || "dev", storage: store.mode }));

  // ---- Docker Registry V2 version check (open, like Docker Hub) ----
  app.get("/v2/", (c) => {
    c.header("Docker-Distribution-Api-Version", "registry/2.0");
    return c.json({}, 200);
  });
  app.get("/v2", (c) => c.redirect("/v2/", 301));

  app.get("/v2/_catalog", async (c) => {
    c.header("Docker-Distribution-Api-Version", "registry/2.0");
    try {
      const n = parseN(c.req.query("n"), 100);
      const last = c.req.query("last") || "";
      const { names, last: next } = await store.listRepos(n, last);
      return c.json({ repositories: names, ...(next ? { last: next } : {}) });
    } catch (e) {
      return c.json({ errors: [{ code: "UNKNOWN", message: e.message || "Bad request" }] }, e.status || 400);
    }
  });

  // ---- Dispatcher for repo-scoped routes (names may contain slashes) ----
  app.all("/v2/*", async (c) => {
    c.header("Docker-Distribution-Api-Version", "registry/2.0");
    const presignedReads = String(env.XCR_PRESIGNED_READS ?? "true").toLowerCase() !== "false";
    const method = c.req.method;
    const path = c.req.path; // e.g. /v2/demo/hello/tags/list
    const rest = path.slice("/v2".length); // /demo/hello/tags/list

    try {
      // uploads: /<name>/blobs/uploads[/<uuid>]
      const up = rest.match(/^(.*)\/blobs\/uploads\/?([^/]*)$/);
      if (up) {
        const name = up[1].replace(/^\//, "");
        const uuid = (up[2] || "").split("?")[0];
        validateName(name);
        if (!uuid) {
          if (method !== "POST") return ociJson(c, ociError("METHOD_UNKNOWN", "Method not allowed", 405));
          return await handleUploadStart(c, store, name);
        }
        if (method === "PATCH") return await handleUploadChunk(c, store, name, uuid);
        if (method === "PUT") return await handleUploadComplete(c, store, name, uuid);
        if (method === "GET") return await handleUploadStatus(c, store, uuid);
        if (method === "DELETE") {
          await store.uploadCancel(uuid);
          return c.body(null, 204);
        }
        return ociJson(c, ociError("METHOD_UNKNOWN", "Method not allowed", 405));
      }

      // presigned direct-to-S3 (s3 only, xcr extension — not OCI standard):
      // /<name>/blobs/presigned-put | /<name>/blobs/presigned-complete
      const ps = rest.match(/^(.*)\/blobs\/(presigned-put|presigned-complete)$/);
      if (ps) {
        const name = ps[1].replace(/^\//, "");
        validateName(name);
        if (method !== "POST") return ociJson(c, ociError("METHOD_UNKNOWN", "Method not allowed", 405));
        if (store.mode !== "s3" || typeof store.presignedPutUrl !== "function") {
          return ociJson(c, ociError("DENIED", "Presigned upload requires s3 storage", 400));
        }
        return await handlePresigned(c, store, name, ps[2]);
      }

      // blobs: /<name>/blobs/<digest>
      const bl = rest.match(/^(.*)\/blobs\/(.+)$/);
      if (bl && !bl[1].endsWith("/uploads")) {
        const name = bl[1].replace(/^\//, "");
        const digest = decodeURIComponent(bl[2]);
        validateName(name);
        if (!(await store.repoExists(name))) return ociJson(c, ociError("NAME_UNKNOWN", `Repository not found: ${name}`));
        validateDigest(digest);
        if (method === "GET" || method === "HEAD") return await handleBlobRead(c, store, digest, method === "HEAD", presignedReads);
        return ociJson(c, ociError("METHOD_UNKNOWN", "Method not allowed", 405));
      }

      // manifests: /<name>/manifests/<ref>
      const mf = rest.match(/^(.*)\/manifests\/(.+)$/);
      if (mf) {
        const name = mf[1].replace(/^\//, "");
        const ref = decodeURIComponent(mf[2]);
        validateName(name);
        if (method === "GET" || method === "HEAD") return await handleManifestGet(c, store, name, ref, method === "HEAD");
        if (method === "PUT") return await handleManifestPut(c, store, name, ref);
        if (method === "DELETE") {
          if (isDigest(ref)) validateDigest(ref);
          else validateTag(ref);
          const ok = await store.deleteManifest(name, ref);
          if (!ok) return ociJson(c, ociError("MANIFEST_UNKNOWN", `Manifest not found: ${ref}`));
          return c.body(null, 202);
        }
        return ociJson(c, ociError("METHOD_UNKNOWN", "Method not allowed", 405));
      }

      // tags: /<name>/tags/list
      const tg = rest.match(/^(.*)\/tags\/list$/);
      if (tg) {
        const name = tg[1].replace(/^\//, "");
        validateName(name);
        if (method !== "GET") return ociJson(c, ociError("METHOD_UNKNOWN", "Method not allowed", 405));
        const page = await store.listTags(name, parseN(c.req.query("n"), 100), c.req.query("last") || "");
        if (!page) return ociJson(c, ociError("NAME_UNKNOWN", `Repository not found: ${name}`));
        return c.json({ name, tags: page.tags, ...(page.last ? { last: page.last } : {}) });
      }

      return ociJson(c, ociError("NAME_UNKNOWN", "Not found", 404));
    } catch (e) {
      return ociJson(c, ociError(e.code || "UNKNOWN", e.message || "Bad request", e.status || 400));
    }
  });

  // ---- ECR JSON subset (POST / + X-Amz-Target) ----
  app.post("/", async (c) => {
    try {
      const target = c.req.header("X-Amz-Target") || c.req.header("x-amz-target") || "";
      const action = target.split(/[#.]/).pop() || "";
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const host = c.req.header("host") || "localhost:8790";
      const proto = c.req.header("x-forwarded-proto") || "http";

      switch (action) {
        case "GetAuthorizationToken": {
          const token = Buffer.from(`AWS:${newToken()}`).toString("base64");
          return c.json({
            authorizationData: [{ authorizationToken: token, proxyEndpoint: `${proto}://${host}`, expiresAt: new Date(Date.now() + 12 * 3600e3).toISOString() }],
          });
        }
        case "CreateRepository": {
          const name = body.repositoryName || body.repositoryname || "";
          validateName(name);
          try {
            await store.createRepo(name);
          } catch (e) {
            return c.json({ message: `Repository ${name} already exists` }, 400);
          }
          return c.json({ repository: { repositoryName: name, repositoryUri: `${host}/${name}`, createdAt: nowIso() } });
        }
        case "DescribeRepositories": {
          const names = Array.isArray(body.repositoryNames) ? body.repositoryNames : null;
          const { names: all } = await store.listRepos(1000, "");
          const filtered = names ? all.filter((n) => names.includes(n)) : all;
          return c.json({
            repositories: filtered.map((n) => ({ repositoryName: n, repositoryUri: `${host}/${n}` })),
          });
        }
        case "DeleteRepository": {
          const name = body.repositoryName || "";
          validateName(name);
          const ok = await store.deleteRepo(name);
          if (!ok) return c.json({ message: "Repository not found" }, 404);
          return c.json({ repositoryName: name });
        }
        case "ListImages":
        case "DescribeImages":
        case "BatchDeleteImage": {
          return await handleEcrImages(c, store, action, body);
        }
        case "":
          return c.json({ message: "Missing X-Amz-Target header" }, 400);
        default:
          return c.json({ message: `Unsupported action: ${action}` }, 400);
      }
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/v2/")) return c.json({ errors: [{ code: "NAME_UNKNOWN", message: "Not found" }] }, 404);
    return c.json({ message: "Not found" }, 404);
  });
  return app;
}

function ociJson(c, { status, body }) {
  return c.json(body, status);
}

async function handleUploadStart(c, store, name) {
  const digest = c.req.query("digest") || "";
  const mount = c.req.query("mount") || "";
  const from = c.req.query("from") || "";
  if (digest) {
    // Monolithic single-shot: body carries the blob.
    validateDigest(digest);
    const buf = Buffer.from(await c.req.arrayBuffer());
    const actual = await sha256Digest(new Uint8Array(buf));
    if (actual !== digest) return ociJson(c, ociError("DIGEST_INVALID", `Digest mismatch (expected ${digest}, got ${actual})`, 400));
    await store.ensureRepo(name);
    await store.blobWrite(digest, new Uint8Array(buf));
    await store.trackBlob(name, digest);
    c.header("Location", `/v2/${name}/blobs/${digest}`);
    c.header("Docker-Content-Digest", digest);
    return c.body(null, 201);
  }
  if (mount && from) {
    // Cross-repo mount (best-effort express): link if blob exists globally.
    validateDigest(mount);
    const st = await store.blobStat(mount);
    if (st) {
      await store.ensureRepo(name);
      await store.trackBlob(name, mount);
      c.header("Location", `/v2/${name}/blobs/${mount}`);
      c.header("Docker-Content-Digest", mount);
      return c.body(null, 201);
    }
  }
  await store.ensureRepo(name);
  const { uuid } = await store.uploadStart(name);
  c.header("Location", uploadLocation(name, uuid));
  c.header("Range", "0-0");
  return c.body(null, 202);
}

async function handleUploadChunk(c, store, _name, uuid) {
  const chunk = new Uint8Array(await c.req.arrayBuffer());
  const st = await store.uploadAppend(uuid, chunk);
  if (!st) return ociJson(c, ociError("BLOB_UPLOAD_UNKNOWN", "Upload session not found", 404));
  c.header("Location", uploadLocation(st.name, uuid));
  c.header("Range", `0-${Math.max(st.size - 1, 0)}`);
  return c.body(null, 204);
}

async function handleUploadStatus(c, store, uuid) {
  const st = await store.uploadStatus(uuid);
  if (!st) return ociJson(c, ociError("BLOB_UPLOAD_UNKNOWN", "Upload session not found", 404));
  c.header("Location", uploadLocation(st.name, uuid));
  c.header("Range", `0-${Math.max(st.size - 1, 0)}`);
  return c.body(null, 204);
}

async function handleUploadComplete(c, store, name, uuid) {
  const digest = c.req.query("digest") || "";
  if (!digest) return ociJson(c, ociError("DIGEST_INVALID", "Missing ?digest=", 400));
  validateDigest(digest);
  const tail = new Uint8Array(await c.req.arrayBuffer());
  if (tail.byteLength > 0) {
    const st = await store.uploadAppend(uuid, tail);
    if (!st) return ociJson(c, ociError("BLOB_UPLOAD_UNKNOWN", "Upload session not found", 404));
  } else {
    const st = await store.uploadStatus(uuid);
    if (!st) return ociJson(c, ociError("BLOB_UPLOAD_UNKNOWN", "Upload session not found", 404));
  }
  try {
    await store.uploadComplete(name, uuid, digest);
  } catch (e) {
    return ociJson(c, ociError(e.code || "DIGEST_INVALID", e.message, e.status || 400));
  }
  c.header("Location", `/v2/${name}/blobs/${digest}`);
  c.header("Docker-Content-Digest", digest);
  return c.body(null, 201);
}

async function handlePresigned(c, store, name, op) {
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    return ociJson(c, ociError("MANIFEST_INVALID", "Invalid JSON", 400));
  }
  const digest = body.digest || "";
  try {
    validateDigest(digest);
  } catch (e) {
    return ociJson(c, ociError(e.code || "DIGEST_INVALID", e.message, e.status || 400));
  }
  if (op === "presigned-put") {
    // Pure URL issuance (stateless): repo is created at complete time
    // (trackBlob ensures it), so signing never needs the backend.
    const { url, checksumSha256, expiresIn } = await store.presignedPutUrl(digest);
    return c.json({
      digest,
      method: "PUT",
      url,
      expiresIn,
      headers: { "Content-Type": "application/octet-stream", "x-amz-checksum-sha256": checksumSha256 },
      note: "PUT raw bytes to url with the given headers; S3 itself rejects bytes that don't match the digest; then call presigned-complete",
    });
  }
  // presigned-complete: verify via HeadObject only (no bytes through the app).
  const st = await store.blobStat(digest);
  if (!st) return ociJson(c, ociError("BLOB_UNKNOWN", `Blob not found: ${digest}`));
  const expectedB64 = Buffer.from(digest.slice("sha256:".length), "hex").toString("base64");
  if (st.checksumSha256 && st.checksumSha256 !== expectedB64) {
    return ociJson(c, ociError("DIGEST_INVALID", "S3 checksum does not match digest (re-upload via presigned-put)", 400));
  }
  if (body.size != null && Number(body.size) !== st.size) {
    return ociJson(c, ociError("DIGEST_INVALID", `Size mismatch (expected ${body.size}, got ${st.size})`, 400));
  }
  await store.trackBlob(name, digest);
  c.header("Docker-Content-Digest", digest);
  return c.json({ digest, size: st.size }, 201);
}

async function handleBlobRead(c, store, digest, headOnly, presignedReads = false) {
  // Pull offload in s3 mode: docker follows 307, bytes bypass the app.
  // HEAD stays proxied (cheap metadata, no redirect semantics needed).
  if (!headOnly && presignedReads && store.mode === "s3" && typeof store.presignedGetUrl === "function") {
    const st = await store.blobStat(digest);
    if (!st) return ociJson(c, ociError("BLOB_UNKNOWN", `Blob not found: ${digest}`));
    const { url } = await store.presignedGetUrl(digest);
    c.header("Docker-Content-Digest", digest);
    return c.redirect(url, 307);
  }
  if (headOnly) {
    const st = await store.blobStat(digest);
    if (!st) return ociJson(c, ociError("BLOB_UNKNOWN", `Blob not found: ${digest}`));
    c.header("Content-Length", String(st.size));
    c.header("Docker-Content-Length", String(st.size));
    c.header("Docker-Content-Digest", digest);
    c.header("Accept-Ranges", "bytes");
    return c.body(null, 200);
  }
  const obj = await store.blobRead(digest);
  if (!obj) return ociJson(c, ociError("BLOB_UNKNOWN", `Blob not found: ${digest}`));
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Length", String(obj.size));
  c.header("Docker-Content-Length", String(obj.size));
  c.header("Docker-Content-Digest", digest);
  return c.body(obj.bytes, 200);
}

async function handleManifestGet(c, store, name, ref, headOnly) {
  let digest = ref;
  if (isDigest(ref)) {
    validateDigest(ref);
  } else {
    validateTag(ref);
    const d = await store.resolveTag(name, ref);
    if (!d) {
      if (!(await store.repoExists(name))) return ociJson(c, ociError("NAME_UNKNOWN", `Repository not found: ${name}`));
      return ociJson(c, ociError("MANIFEST_UNKNOWN", `Manifest not found: ${ref}`));
    }
    digest = d;
  }
  const m = await store.getManifestByDigest(digest);
  if (!m) return ociJson(c, ociError("MANIFEST_UNKNOWN", `Manifest not found: ${ref}`));
  c.header("Content-Type", m.contentType);
  c.header("Docker-Content-Digest", m.digest);
  c.header("Content-Length", String(m.size));
  if (headOnly) return c.body(null, 200);
  return c.body(m.bytes, 200);
}

async function handleManifestPut(c, store, name, ref) {
  if (isDigest(ref)) return ociJson(c, ociError("TAG_INVALID", "Manifest tag must not be a digest", 400));
  validateTag(ref);
  const contentType = c.req.header("content-type") || "application/vnd.docker.distribution.manifest.v2+json";
  if (!MANIFEST_CT_RE.test(contentType)) {
    return ociJson(c, ociError("MANIFEST_INVALID", `Unsupported Content-Type: ${contentType}`, 400));
  }
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.byteLength) return ociJson(c, ociError("MANIFEST_INVALID", "Empty manifest", 400));
  try {
    JSON.parse(Buffer.from(buf).toString("utf8"));
  } catch {
    return ociJson(c, ociError("MANIFEST_INVALID", "Manifest must be valid JSON", 400));
  }
  const { digest } = await store.putManifest(name, ref, contentType.split(";")[0].trim(), buf);
  c.header("Location", `/v2/${name}/manifests/${digest}`);
  c.header("Docker-Content-Digest", digest);
  return c.body(null, 201);
}

async function handleEcrImages(c, store, action, body) {
  const name = body.repositoryName || "";
  validateName(name);
  if (!(await store.repoExists(name))) return c.json({ message: "Repository not found" }, 404);
  const page = await store.listTags(name, 1000, "");
  const tags = page?.tags ?? [];
  const withDigest = [];
  for (const t of tags) {
    const d = await store.resolveTag(name, t);
    withDigest.push({ tag: t, digest: d });
  }
  if (action === "ListImages") {
    return c.json({ imageIds: withDigest.map(({ tag, digest }) => ({ imageTag: tag, imageDigest: digest })) });
  }
  if (action === "BatchDeleteImage") {
    const ids = Array.isArray(body.imageIds) ? body.imageIds : [];
    const deleted = [];
    const failures = [];
    for (const id of ids) {
      if (id.imageTag) {
        const ok = await store.deleteManifest(name, id.imageTag);
        if (ok) deleted.push({ imageTag: id.imageTag });
        else failures.push({ imageId: id, failureCode: "ImageNotFound", failureReason: "Tag not found" });
      } else if (id.imageDigest) {
        const ok = await store.deleteManifest(name, id.imageDigest);
        if (ok) deleted.push({ imageDigest: id.imageDigest });
        else failures.push({ imageId: id, failureCode: "ImageNotFound", failureReason: "Digest not found" });
      }
    }
    return c.json({ imageIds: deleted, failures });
  }
  // DescribeImages
  let selected = withDigest;
  if (Array.isArray(body.imageIds) && body.imageIds.length) {
    selected = [];
    for (const id of body.imageIds) {
      if (id.imageTag) {
        const d = await store.resolveTag(name, id.imageTag);
        if (d) selected.push({ tag: id.imageTag, digest: d });
      } else if (id.imageDigest) {
        selected.push({ tag: undefined, digest: id.imageDigest });
      }
    }
  }
  const details = [];
  for (const { tag, digest } of selected) {
    const m = digest ? await store.getManifestByDigest(digest) : null;
    details.push({
      repositoryName: name,
      ...(tag ? { imageTags: [tag] } : {}),
      ...(digest ? { imageDigest: digest } : {}),
      imageSizeInBytes: m?.size ?? 0,
      imagePushedAt: nowIso(),
    });
  }
  return c.json({ imageDetails: details });
}

function apiKeyGuard(apiKey) {
  return async (c, next) => {
    if (!apiKey) return next();
    const p = c.req.path;
    if (p === "/health") return next();
    if ((p === "/v2/" || p === "/v2") && (c.req.method === "GET" || c.req.method === "HEAD")) return next();
    const headerKey = c.req.header("x-api-key") || "";
    if (headerKey === apiKey) return next();
    const auth = c.req.header("authorization") || "";
    if (auth.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
        const password = decoded.slice(decoded.indexOf(":") + 1);
        if (password === apiKey) return next();
      } catch {
        // fall through to deny
      }
    }
    if (p.startsWith("/v2/")) {
      c.header("WWW-Authenticate", 'Basic realm="xcr"');
      return c.json({ errors: [{ code: "UNAUTHORIZED", message: "Authentication required" }] }, 401);
    }
    return c.json({ message: "Forbidden" }, 403);
  };
}
