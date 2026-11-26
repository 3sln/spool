import { Fault } from "./contract.mjs";

export function layerPullOrigins(values = []) {
  return new Set(values.map((value) => {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("Layer pull origins must be HTTPS origins");
    }
    return url.origin;
  }));
}

export function configuredLayerPull(env, layers) {
  const origins = layerPullOrigins((env.SPOOL_LAYER_PULL_ORIGINS ?? "").split(",").filter((value) => value.trim()));
  const timeout = Number(env.SPOOL_LAYER_PULL_TIMEOUT_SECONDS ?? 300);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600) {
    throw new TypeError("SPOOL_LAYER_PULL_TIMEOUT_SECONDS must be an integer from 1 to 600");
  }
  if (layers && origins.size && typeof (layers.importVerified ?? layers.putVerified) !== "function") {
    throw new TypeError("Layer pull requires a verified streaming layer store");
  }
  return { origins, timeout };
}

const forbidden = new Set([
  "host", "connection", "proxy-connection", "proxy-authorization", "transfer-encoding", "content-length",
  "content-encoding", "upgrade", "trailer", "te", "expect", "range", "accept-encoding", "forwarded", "referer",
  "x-http-method", "x-http-method-override", "x-method-override",
]);

export function layerDownload(value, origins) {
  if (typeof value === "string") value = { url: value };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["url", "headers", "method", "expires_at"].includes(key))
    || typeof value.url !== "string" || value.url.length > 8192 || (value.method !== undefined && value.method !== "GET")) {
    throw new Fault("INVALID_MANIFEST", "Invalid layer download plan");
  }
  let url;
  try { url = new URL(value.url); }
  catch { throw new Fault("INVALID_MANIFEST", "Invalid layer download URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !origins.has(url.origin)) {
    throw new Fault("LAYER_PULL_ORIGIN", "Layer download origin is outside the runner allowlist", 403);
  }
  const headers = new Headers({ "accept-encoding": "identity" });
  const raw = value.headers === undefined ? {} : value.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 24) {
    throw new Fault("INVALID_MANIFEST", "Invalid layer download headers");
  }
  for (const [name, contents] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (typeof contents !== "string" || contents.length > 4096 || forbidden.has(key)
      || key.startsWith("x-forwarded-") || headers.has(key)) throw new Fault("INVALID_MANIFEST", "Invalid layer download header");
    try { headers.set(key, contents); }
    catch { throw new Fault("INVALID_MANIFEST", "Invalid layer download header"); }
  }
  if (value.expires_at !== undefined && typeof value.expires_at !== "string") {
    throw new Fault("INVALID_MANIFEST", "Invalid layer download expiry");
  }
  const expires = value.expires_at === undefined ? Infinity : Date.parse(value.expires_at);
  if (Number.isNaN(expires) || expires <= Date.now()) throw new Fault("LAYER_PULL_EXPIRED", "Layer download plan has expired", 422);
  return { url, headers, expires };
}

export async function storePulledLayer(response, descriptor, signal, write) {
  const abort = new AbortController();
  const transferSignal = AbortSignal.any([signal, abort.signal]);
  let received = 0;
  const bytes = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > descriptor.size) throw new Error("Layer exceeds its declared size");
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== descriptor.size) throw new Error("Layer is shorter than its declared size");
    },
  });
  const input = response.body.pipeTo(bytes.writable, { signal: transferSignal });
  const output = Promise.resolve().then(() => write({ body: bytes.readable, signal: transferSignal }));
  const results = await Promise.allSettled([input, output].map((job) => job.catch((error) => {
    abort.abort();
    throw error;
  })));
  const failure = results.find(({ status }) => status === "rejected");
  if (failure) throw failure.reason;
}
