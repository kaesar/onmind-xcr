import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowIso, newUploadUuid } from "./ids.js";
import { digestToParts } from "./validate.js";

const FORMAT = "xcr/v1";

function emptyRepos() {
  return { format: FORMAT, repos: {} };
}

function ensureRepoDoc(doc, name) {
  if (!doc.repos[name]) {
    doc.repos[name] = { tags: {}, manifests: {}, blobs: [], createdAt: nowIso(), updatedAt: nowIso() };
  }
  return doc.repos[name];
}

export function fsStore(root) {
  const reposPath = join(root, "repos.json");
  const blobPath = (digest) => {
    const { hex, prefix } = digestToParts(digest);
    return join(root, "blobs", "sha256", prefix, hex);
  };
  const manifestPath = (digest) => {
    const { hex, prefix } = digestToParts(digest);
    return join(root, "manifests", "sha256", prefix, hex);
  };
  const uploadDataPath = (uuid) => join(root, "uploads", uuid, "data");
  const uploadMetaPath = (uuid) => join(root, "uploads", uuid, "meta.json");

  let chain = Promise.resolve();
  function atomic(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function readRepos() {
    try {
      const raw = await readFile(reposPath, "utf8");
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== "object" || !doc.repos || typeof doc.repos !== "object") return emptyRepos();
      return doc;
    } catch (e) {
      if (e.code === "ENOENT") return emptyRepos();
      throw e;
    }
  }

  async function writeRepos(doc) {
    await mkdir(dirname(reposPath), { recursive: true });
    const tmp = `${reposPath}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, reposPath);
  }

  async function writeBytes(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(bytes));
  }

  return {
    mode: "filesystem",
    root,

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
      const size = bytes.byteLength;
      await writeBytes(manifestPath(digest), bytes);
      return atomic(async () => {
        const doc = await readRepos();
        const repo = ensureRepoDoc(doc, name);
        repo.manifests[digest] = { contentType, size, createdAt: nowIso() };
        repo.tags[tag] = digest;
        repo.updatedAt = nowIso();
        await writeRepos(doc);
        return { digest, size };
      });
    },

    async getManifestByDigest(digest) {
      let bytes;
      try {
        bytes = await readFile(manifestPath(digest));
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
      const doc = await readRepos();
      let contentType = "application/vnd.docker.distribution.manifest.v2+json";
      for (const repo of Object.values(doc.repos)) {
        if (repo.manifests?.[digest]) {
          contentType = repo.manifests[digest].contentType || contentType;
          break;
        }
      }
      return { digest, contentType, bytes: new Uint8Array(bytes), size: bytes.byteLength };
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
        const stillUsed = Object.values(repo.tags).includes(digest);
        if (!stillUsed && repo.manifests[digest]) delete repo.manifests[digest];
        await writeRepos(doc);
        return true;
      });
    },

    async blobStat(digest) {
      try {
        const s = await stat(blobPath(digest));
        return { size: s.size };
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },

    async blobRead(digest) {
      try {
        const bytes = await readFile(blobPath(digest));
        return { bytes: new Uint8Array(bytes), size: bytes.byteLength };
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },

    async blobWrite(digest, bytes) {
      await writeBytes(blobPath(digest), bytes);
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
      await mkdir(dirname(uploadDataPath(uuid)), { recursive: true });
      await writeFile(uploadDataPath(uuid), Buffer.alloc(0));
      await writeFile(uploadMetaPath(uuid), JSON.stringify({ name, createdAt: nowIso() }), "utf8");
      return { uuid };
    },

    async uploadAppend(uuid, chunk) {
      const meta = JSON.parse(await readFile(uploadMetaPath(uuid), "utf8"));
      const prev = await readFile(uploadDataPath(uuid));
      await writeFile(uploadDataPath(uuid), Buffer.concat([prev, Buffer.from(chunk)]));
      return { size: prev.byteLength + chunk.byteLength, name: meta.name };
    },

    async uploadStatus(uuid) {
      try {
        const meta = JSON.parse(await readFile(uploadMetaPath(uuid), "utf8"));
        const s = await stat(uploadDataPath(uuid));
        return { size: s.size, name: meta.name };
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },

    async uploadComplete(name, uuid, digest) {
      const data = await readFile(uploadDataPath(uuid)).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (!data) return null;
      const { sha256Digest } = await import("./validate.js");
      const actual = await sha256Digest(new Uint8Array(data));
      if (actual !== digest) {
        const e = new Error(`Digest mismatch (expected ${digest}, got ${actual})`);
        e.status = 400;
        e.code = "DIGEST_INVALID";
        throw e;
      }
      await writeBytes(blobPath(digest), new Uint8Array(data));
      await rm(join(root, "uploads", uuid), { recursive: true, force: true });
      await this.trackBlob(name, digest);
      return { size: data.byteLength };
    },

    async uploadCancel(uuid) {
      try {
        await rm(join(root, "uploads", uuid), { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },

    // Test helper.
    async _repos() {
      return readRepos();
    },
  };
}
