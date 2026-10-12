// OCI name/tag/digest validation (no deps).
const NAME_RE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const TAG_RE = /^[\w][\w.-]{0,127}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function validateName(name) {
  if (!name || typeof name !== "string" || name.length > 255 || !NAME_RE.test(name) || name.includes("//")) {
    const e = new Error("Invalid repository name (must match ^[a-z0-9]+([._/-][a-z0-9]+)*$)");
    e.status = 400;
    e.code = "NAME_UNKNOWN";
    throw e;
  }
}

export function validateTag(tag) {
  if (!tag || !TAG_RE.test(tag)) {
    const e = new Error("Invalid tag (must match ^[\\w][\\w.-]{0,127}$)");
    e.status = 400;
    e.code = "TAG_INVALID";
    throw e;
  }
}

export function validateDigest(digest) {
  if (!digest || !DIGEST_RE.test(digest)) {
    const e = new Error("Invalid digest (expected sha256:<64 hex>)");
    e.status = 400;
    e.code = "DIGEST_INVALID";
    throw e;
  }
}

export function isDigest(ref) {
  return typeof ref === "string" && ref.startsWith("sha256:");
}

export function digestToParts(digest) {
  validateDigest(digest);
  const hex = digest.slice("sha256:".length);
  return { alg: "sha256", hex, prefix: hex.slice(0, 2) };
}

export async function sha256Digest(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Buffer.from(hash).toString("hex");
  return `sha256:${hex}`;
}
