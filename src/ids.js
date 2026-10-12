export function nowIso() {
  return new Date().toISOString();
}

export function newUploadUuid() {
  return crypto.randomUUID();
}

export function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function parseN(raw, def = 100) {
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    const e = new Error("Invalid n (must be 1..1000)");
    e.status = 400;
    throw e;
  }
  return Math.min(n, 1000);
}

// OCI-style pagination over a sorted string array using `last` cursor.
export function paginateSorted(sorted, n, last) {
  let start = 0;
  if (last) {
    const idx = sorted.indexOf(last);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = sorted.slice(start, start + n);
  const hasMore = start + slice.length < sorted.length;
  return { items: slice, last: hasMore ? slice[slice.length - 1] : null };
}
