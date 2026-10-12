import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { storageFromEnv } from "../src/store.js";
import { sha256Digest } from "../src/validate.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name} ${extra}`);
  }
}

const dir = await mkdtemp(join(tmpdir(), "xcr-smoke-"));
const store = storageFromEnv({ XCR_STORAGE: "filesystem", XCR_DATA_DIR: join(dir, "xcr-data") });
const app = createApp({ XCR_ENV: "dev" }, store);
const req = (path, init) => app.request(path, init);
const J = (r) => r.json();

const BLOB = new TextEncoder().encode("hello-xcr-blob");
const BLOB_DIGEST = await sha256Digest(BLOB);
const MANIFEST = { schemaVersion: 2, mediaType: "application/vnd.docker.distribution.manifest.v2+json", config: { mediaType: "application/vnd.docker.container.image.v1+json", size: 2, digest: BLOB_DIGEST }, layers: [{ mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", size: BLOB.byteLength, digest: BLOB_DIGEST }] };
const MANIFEST_BYTES = new TextEncoder().encode(JSON.stringify(MANIFEST));
const MANIFEST_DIGEST = await sha256Digest(MANIFEST_BYTES);

// 1 health + version check
{
  const r = await req("/health");
  const j = await J(r);
  check("health 200 + storage filesystem", r.status === 200 && j.ok && j.storage === "filesystem", JSON.stringify(j));
  const v = await req("/v2/");
  check("GET /v2/ 200 + registry/2.0", v.status === 200 && v.headers.get("Docker-Distribution-Api-Version") === "registry/2.0");
}

// 2 monolithic blob upload + roundtrip
{
  const start = await req("/v2/demo/hello/blobs/uploads/", { method: "POST" });
  const loc = start.headers.get("Location") || "";
  check("POST uploads 202 + Location", start.status === 202 && loc.includes("/blobs/uploads/"), loc);
  const put = await req(`${loc}?digest=${BLOB_DIGEST}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: BLOB });
  check("PUT complete 201 + digest", put.status === 201 && put.headers.get("Docker-Content-Digest") === BLOB_DIGEST);
  const get = await req(`/v2/demo/hello/blobs/${BLOB_DIGEST}`);
  const got = new Uint8Array(await get.arrayBuffer());
  check("GET blob roundtrip", get.status === 200 && Buffer.from(got).equals(Buffer.from(BLOB)));
  const head = await req(`/v2/demo/hello/blobs/${BLOB_DIGEST}`, { method: "HEAD" });
  check("HEAD blob 200 + length", head.status === 200 && head.headers.get("Docker-Content-Digest") === BLOB_DIGEST);
  const badStart = await req("/v2/demo/hello/blobs/uploads/", { method: "POST" });
  const badLoc = badStart.headers.get("Location");
  const bad = await req(`${badLoc}?digest=sha256:${"0".repeat(64)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: BLOB });
  check("digest mismatch 400 DIGEST_INVALID", bad.status === 400 && (await J(bad)).errors?.[0]?.code === "DIGEST_INVALID");
  const missing = await req(`/v2/demo/hello/blobs/sha256:${"f".repeat(64)}`);
  check("missing blob 404 BLOB_UNKNOWN", missing.status === 404 && (await J(missing)).errors?.[0]?.code === "BLOB_UNKNOWN");
}

// 3 manifest put/get/delete + tags
{
  const put = await req("/v2/demo/hello/manifests/v1", {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.docker.distribution.manifest.v2+json" },
    body: MANIFEST_BYTES,
  });
  check("PUT manifest 201 + digest", put.status === 201 && put.headers.get("Docker-Content-Digest") === MANIFEST_DIGEST);
  const byTag = await req("/v2/demo/hello/manifests/v1");
  check("GET manifest by tag 200", byTag.status === 200 && byTag.headers.get("Docker-Content-Digest") === MANIFEST_DIGEST);
  const byDigest = await req(`/v2/demo/hello/manifests/${MANIFEST_DIGEST}`);
  check("GET manifest by digest 200", byDigest.status === 200);
  const tags = await J(await req("/v2/demo/hello/tags/list"));
  check("tags/list contains v1", tags.tags?.includes("v1"), JSON.stringify(tags));
  const cat = await J(await req("/v2/_catalog"));
  check("_catalog contains demo/hello", cat.repositories?.includes("demo/hello"), JSON.stringify(cat));
  const del = await req("/v2/demo/hello/manifests/v1", { method: "DELETE" });
  check("DELETE manifest 202", del.status === 202);
  check("GET deleted manifest 404", (await req("/v2/demo/hello/manifests/v1")).status === 404);
}

// 4 chunked upload
{
  await req("/v2/demo/chunk/manifests/nope").catch(() => {});
  const start = await req("/v2/demo/chunk/blobs/uploads/", { method: "POST" });
  const loc = start.headers.get("Location");
  await req(loc, { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: BLOB.slice(0, 5) });
  await req(loc, { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: BLOB.slice(5) });
  const status = await req(loc);
  check("upload status 204 + Range", status.status === 204 && (status.headers.get("Range") || "").startsWith("0-"));
  const done = await req(`${loc}?digest=${BLOB_DIGEST}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" } });
  check("chunked complete 201", done.status === 201);
}

// 5 validation
{
  const badName = await req("/v2/UPPER/tags/list");
  check("uppercase name 400", badName.status === 400);
  const badDigest = await req(`/v2/demo/hello/blobs/sha256:zzz`);
  check("malformed digest 400", badDigest.status === 400);
  const badTag = await req("/v2/demo/hello/manifests/a b", {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.docker.distribution.manifest.v2+json" },
    body: MANIFEST_BYTES,
  });
  check("bad tag 400", badTag.status === 400);
}

// 6 ECR subset
{
  const t = (a, b) => req("/", { method: "POST", headers: { "Content-Type": "application/json", "X-Amz-Target": a }, body: JSON.stringify(b) });
  const auth = await J(await t("AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken", {}));
  check("ECR GetAuthorizationToken 200", !!auth.authorizationData?.[0]?.authorizationToken, JSON.stringify(auth).slice(0, 120));
  const cr = await t("CreateRepository", { repositoryName: "demo/ecr" });
  check("ECR CreateRepository 200", cr.status === 200);
  const desc = await J(await t("DescribeRepositories", {}));
  check("ECR DescribeRepositories contains", desc.repositories?.some((r) => r.repositoryName === "demo/ecr"), JSON.stringify(desc).slice(0, 160));
  const li = await J(await t("ListImages", { repositoryName: "demo/hello" }));
  check("ECR ListImages 200", Array.isArray(li.imageIds), JSON.stringify(li).slice(0, 160));
  const di = await J(await t("DescribeImages", { repositoryName: "demo/hello" }));
  check("ECR DescribeImages 200", Array.isArray(di.imageDetails), JSON.stringify(di).slice(0, 160));
  const del = await t("DeleteRepository", { repositoryName: "demo/ecr" });
  check("ECR DeleteRepository 200", del.status === 200);
}

// 7 auth
{
  const guarded = createApp({ XCR_API_KEY: "k123" }, store);
  const denied = await guarded.request("/v2/demo/hello/tags/list");
  const allowed = await guarded.request("/v2/demo/hello/tags/list", { headers: { "x-api-key": "k123" } });
  const basic = await guarded.request("/v2/demo/hello/tags/list", { headers: { Authorization: `Basic ${Buffer.from("u:k123").toString("base64")}` } });
  const open = await guarded.request("/v2/");
  check("auth 401 + x-api-key/basic ok + /v2/ open", denied.status === 401 && allowed.status === 200 && basic.status === 200 && open.status === 200);
}

// 8 storage fail-fast
{
  let threw = "";
  try {
    storageFromEnv({ XCR_STORAGE: "bogus" });
  } catch (e) {
    threw = String(e.message || e);
  }
  check("XCR_STORAGE=bogus throws", /unknown XCR_STORAGE/.test(threw), threw.slice(0, 80));
  let noBucket = "";
  try {
    storageFromEnv({ XCR_STORAGE: "s3" });
  } catch (e) {
    noBucket = String(e.message || e);
  }
  check("s3 without bucket throws", /XCR_S3_BUCKET/.test(noBucket), noBucket.slice(0, 80));
}

await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
