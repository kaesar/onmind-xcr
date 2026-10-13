import { nowIso, newUploadUuid } from "./ids.js";
import { digestToParts } from "./validate.js";

// S3 backend: same contract as fsStore. Blobs/manifests are objects,
// xrepos.json is a single object with read-modify-write (single-writer v1).
export function s3Store(env = process.env) {
  const bucket = env.XCR_S3_BUCKET || "";
  if (!bucket) throw new Error('xcr: XCR_S3_BUCKET is required when XCR_STORAGE=s3');
  let prefix = env.XCR_S3_PREFIX || "docker-registry/";
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const endpoint = env.XCR_S3_ENDPOINT || undefined;
  const region = env.XCR_S3_REGION || env.AWS_REGION || "us-east-1";
  const forcePathStyle =
    env.XCR_S3_FORCE_PATH_STYLE != null
      ? String(env.XCR_S3_FORCE_PATH_STYLE).toLowerCase() === "true"
      : !!endpoint;

  const keyRepos = `${prefix}xrepos.json`;
  const keyBlob = (digest) => {
    const { hex, prefix: p } = digestToParts(digest);
    return `${prefix}blobs/sha256/${p}/${hex}`;
  };
  const keyManifest = (digest) => {
    const { hex, prefix: p } = digestToParts(digest);
    return `${prefix}manifests/sha256/${p}/${hex}`;
  };
  const keyUpload = (uuid) => `${prefix}uploads/${uuid}/data`;
  const keyUploadMeta = (uuid) => `${prefix}uploads/${uuid}/meta.json`;

  let clientPromise = null;
  async function client() {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-s3").then(
        ({ S3Client }) => new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle } : {}) })
      );
    }
    return clientPromise;
  }

  async function getObject(key) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const db = await client();
    try {
      const out = await db.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      for await (const c of out.Body) chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
      return { bytes: Buffer.concat(chunks), contentType: out.ContentType };
    } catch (e) {
      if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async function putObject(key, bytes, contentType) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const db = await client();
    await db.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(bytes), ...(contentType ? { ContentType: contentType } : {}) }));
  }

  async function deleteObject(key) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const db = await client();
    await db.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  function emptyRepos() {
    return { format: "xcr/v1", repos: {} };
  }

  function presignedTtl() {
    const raw = parseInt(env.XCR_PRESIGNED_TTL || "900", 10);
    if (!Number.isFinite(raw)) return 900;
    return Math.min(Math.max(raw, 60), 3600);
  }

  // Direct-to-S3 upload: presigned PUT whose signed ChecksumSHA256 header
  // forces S3 itself to reject bytes that don't match the digest. The app
  // never touches the bytes — Lambda payload limits don't apply.
  async function presignedPutUrl(digest) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const db = await client();
    const { hex } = digestToParts(digest);
    const checksumB64 = Buffer.from(hex, "hex").toString("base64");
    const expiresIn = presignedTtl();
    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: keyBlob(digest),
      ContentType: "application/octet-stream",
      ChecksumSHA256: checksumB64,
    });
    const url = await getSignedUrl(db, cmd, { expiresIn });
    return { url, checksumSha256: checksumB64, expiresIn };
  }

  // Pull offload: docker follows 307 to S3, bytes bypass the app entirely.
  async function presignedGetUrl(digest) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const db = await client();
    const expiresIn = presignedTtl();
    const url = await getSignedUrl(db, new GetObjectCommand({ Bucket: bucket, Key: keyBlob(digest) }), { expiresIn });
    return { url, expiresIn };
  }

  async function readRepos() {
    const obj = await getObject(keyRepos);
    if (!obj) return emptyRepos();
    try {
      const doc = JSON.parse(obj.bytes.toString("utf8"));
      if (!doc || typeof doc !== "object" || !doc.repos) return emptyRepos();
      return doc;
    } catch {
      return emptyRepos();
    }
  }

  async function writeRepos(doc) {
    await putObject(keyRepos, Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8"), "application/json");
  }

  function ensureRepoDoc(doc, name) {
    if (!doc.repos[name]) {
      doc.repos[name] = { tags: {}, manifests: {}, blobs: [], createdAt: nowIso(), updatedAt: nowIso() };
    }
    return doc.repos[name];
  }

  let chain = Promise.resolve();
  function atomic(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  return {
    mode: "s3",
    bucket,

    async listRepos(n = 100, last = "") {
      const doc = await readRepos();
      const names = Object.keys(doc.repos).sort();
      let start = 0;
      if (last) {
        const i = names.indexOf(last);
        start = i >= 0 ? i + 1 : 0;
      }
      const slice = names.slice(start, start + n);
      return { names: slice, last: start + slice.length < names.length ? slice[slice.length - 1] : null };
    },

    async repoExists(name) {
      const doc = await readRepos();
      return !!doc.repos[name];
    },

    async createRepo(name) {
      return atomic(async () => {
        const doc = await readRepos();
        if (doc.repos[name]) {
          const e = new Error(`Repository ${name} already exists`);
          e.status = 400;
          throw e;
        }
        ensureRepoDoc(doc, name);
        await writeRepos(doc);
        return { name };
      });
    },

    async ensureRepo(name) {
      return atomic(async () => {
        const doc = await readRepos();
        ensureRepoDoc(doc, name);
        await writeRepos(doc);
      });
    },

    async deleteRepo(name) {
      return atomic(async () => {
        const doc = await readRepos();
        if (!doc.repos[name]) return false;
        delete doc.repos[name];
        await writeRepos(doc);
        return true;
      });
    },

    async listTags(name, n = 100, last = "") {
      const doc = await readRepos();
      const repo = doc.repos[name];
      if (!repo) return null;
      const tags = Object.keys(repo.tags).sort();
      let start = 0;
      if (last) {
        const i = tags.indexOf(last);
        start = i >= 0 ? i + 1 : 0;
      }
      const slice = tags.slice(start, start + n);
      return { tags: slice, last: start + slice.length < tags.length ? slice[slice.length - 1] : null };
    },

    async putManifest(name, tag, contentType, bytes) {
      const { sha256Digest } = await import("./validate.js");
      const digest = await sha256Digest(bytes);
      await putObject(keyManifest(digest), Buffer.from(bytes), contentType);
      return atomic(async () => {
        const doc = await readRepos();
        const repo = ensureRepoDoc(doc, name);
        repo.manifests[digest] = { contentType, size: bytes.byteLength, createdAt: nowIso() };
        repo.tags[tag] = digest;
        repo.updatedAt = nowIso();
        await writeRepos(doc);
        return { digest, size: bytes.byteLength };
      });
    },

    async getManifestByDigest(digest) {
      const obj = await getObject(keyManifest(digest));
      if (!obj) return null;
      const doc = await readRepos();
      let contentType = obj.contentType || "application/vnd.docker.distribution.manifest.v2+json";
      for (const repo of Object.values(doc.repos)) {
        if (repo.manifests?.[digest]?.contentType) {
          contentType = repo.manifests[digest].contentType;
          break;
        }
      }
      return { digest, contentType, bytes: new Uint8Array(obj.bytes), size: obj.bytes.byteLength };
    },

    async resolveTag(name, tag) {
      const doc = await readRepos();
      return doc.repos[name]?.tags[tag] ?? null;
    },

    async deleteManifest(name, ref) {
      return atomic(async () => {
        const doc = await readRepos();
        const repo = doc.repos[name];
        if (!repo) return false;
        if (ref.startsWith("sha256:")) {
          let removed = false;
          for (const [t, d] of Object.entries(repo.tags)) {
            if (d === ref) {
              delete repo.tags[t];
              removed = true;
            }
          }
          if (repo.manifests[ref]) {
            delete repo.manifests[ref];
            removed = true;
          }
          if (!removed) return false;
          await writeRepos(doc);
          return true;
        }
        if (!repo.tags[ref]) return false;
        const digest = repo.tags[ref];
        delete repo.tags[ref];
        if (!Object.values(repo.tags).includes(digest) && repo.manifests[digest]) delete repo.manifests[digest];
        await writeRepos(doc);
        return true;
      });
    },

    async blobStat(digest) {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const db = await client();
      try {
        const out = await db.send(new HeadObjectCommand({ Bucket: bucket, Key: keyBlob(digest) }));
        return { size: out.ContentLength ?? 0, checksumSha256: out.ChecksumSHA256 ?? null };
      } catch (e) {
        if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },

    async blobRead(digest) {
      const obj = await getObject(keyBlob(digest));
      if (!obj) return null;
      return { bytes: new Uint8Array(obj.bytes), size: obj.bytes.byteLength };
    },

    async blobWrite(digest, bytes) {
      await putObject(keyBlob(digest), Buffer.from(bytes), "application/octet-stream");
      return { size: bytes.byteLength };
    },

    async trackBlob(name, digest) {
      return atomic(async () => {
        const doc = await readRepos();
        const repo = ensureRepoDoc(doc, name);
        if (!repo.blobs.includes(digest)) repo.blobs.push(digest);
        repo.updatedAt = nowIso();
        await writeRepos(doc);
      });
    },

    async uploadStart(name) {
      const uuid = newUploadUuid();
      await putObject(keyUpload(uuid), Buffer.alloc(0), "application/octet-stream");
      await putObject(keyUploadMeta(uuid), Buffer.from(JSON.stringify({ name, createdAt: nowIso() }), "utf8"), "application/json");
      return { uuid };
    },

    async uploadAppend(uuid, chunk) {
      const metaObj = await getObject(keyUploadMeta(uuid));
      if (!metaObj) return null;
      const prev = (await getObject(keyUpload(uuid)))?.bytes ?? Buffer.alloc(0);
      const next = Buffer.concat([prev, Buffer.from(chunk)]);
      await putObject(keyUpload(uuid), next, "application/octet-stream");
      return { size: next.byteLength, name: JSON.parse(metaObj.bytes.toString("utf8")).name };
    },

    async uploadStatus(uuid) {
      const metaObj = await getObject(keyUploadMeta(uuid));
      if (!metaObj) return null;
      const data = (await getObject(keyUpload(uuid)))?.bytes ?? Buffer.alloc(0);
      return { size: data.byteLength, name: JSON.parse(metaObj.bytes.toString("utf8")).name };
    },

    async uploadComplete(name, uuid, digest) {
      const data = (await getObject(keyUpload(uuid)))?.bytes ?? null;
      if (!data) return null;
      const { sha256Digest } = await import("./validate.js");
      const actual = await sha256Digest(new Uint8Array(data));
      if (actual !== digest) {
        const e = new Error(`Digest mismatch (expected ${digest}, got ${actual})`);
        e.status = 400;
        e.code = "DIGEST_INVALID";
        throw e;
      }
      await putObject(keyBlob(digest), data, "application/octet-stream");
      await deleteObject(keyUpload(uuid));
      await deleteObject(keyUploadMeta(uuid));
      await this.trackBlob(name, digest);
      return { size: data.byteLength };
    },

    async uploadCancel(uuid) {
      await deleteObject(keyUpload(uuid));
      await deleteObject(keyUploadMeta(uuid));
      return true;
    },

    async presignedPutUrl(digest) {
      return presignedPutUrl(digest);
    },

    async presignedGetUrl(digest) {
      return presignedGetUrl(digest);
    },
  };
}
