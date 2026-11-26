import { replayDecision } from "./generated/js/spool/client/replay.mjs";

export class SpoolError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "SpoolError";
    this.code = code;
    this.status = status;
  }
}

const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]);
const slept = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  function abort() {
    clearTimeout(timer);
    reject(signal.reason);
  }
  signal?.addEventListener("abort", abort, { once: true });
});

function taskPath(id) {
  if (typeof id !== "string" || id === "." || id === ".." || !/^[A-Za-z0-9._~-]{1,128}$/u.test(id)) throw new TypeError("Invalid task ID");
  return `/v1/tasks/${id}`;
}

function layerPath(id, digest) {
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new TypeError("Invalid layer digest");
  return `${taskPath(id)}/layers/${digest}`;
}

async function* frames(body) {
  const reader = body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
  let pending = "";
  let data = [];
  let id;
  let size = 0;
  let skipLF = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += skipLF && value.startsWith("\n") ? value.slice(1) : value;
      skipLF = false;
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const code = pending.charCodeAt(i);
        if (code !== 10 && code !== 13) continue;
        const line = pending.slice(start, i);
        if (code === 13) {
          if (i === pending.length - 1) skipLF = true;
          else if (pending.charCodeAt(i + 1) === 10) i++;
        }
        start = i + 1;
        if (!line) {
          if (data.length) yield { id, value: JSON.parse(data.join("\n")) };
          data = [];
          id = undefined;
          size = 0;
        } else if (!line.startsWith(":")) {
          size += line.length;
          if (size > 512 * 1024) throw new SpoolError("INVALID_EVENT", "Event frame exceeds the client limit");
          const colon = line.indexOf(":");
          const name = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
          if (name === "id") id = value;
          if (name === "data") data.push(value);
        }
      }
      pending = pending.slice(start);
      if (pending.length > 512 * 1024) throw new SpoolError("INVALID_EVENT", "Event line exceeds the client limit");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createClient({
  url, fetch: transport = globalThis.fetch, headers, layerSource, allowTransferURL = () => false,
} = {}) {
  const base = new URL(url);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new TypeError("Invalid runner URL");

  async function request(path, { method = "GET", body, signal, extra, transfer = false, authenticated = true } = {}) {
    const target = new URL(path, base);
    const ownOrigin = target.origin === base.origin;
    if (target.username || target.password || (!ownOrigin && (
      !transfer || authenticated || target.protocol !== "https:" || !await allowTransferURL(target)
    ))) throw new SpoolError("UNTRUSTED_URL", "Runner returned a URL outside the allowed origins");

    const outbound = new Headers(ownOrigin && authenticated ? (typeof headers === "function" ? await headers() : headers) : undefined);
    for (const [name, value] of Object.entries(extra ?? {})) outbound.set(name, value);
    const response = await transport(target, {
      method, headers: outbound, body, signal, redirect: "error", credentials: "omit",
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new SpoolError(result.error ?? "HTTP_ERROR", result.message ?? `Runner returned HTTP ${response.status}`, response.status);
    }
    return response;
  }

  async function retry(operation, signal) {
    for (let attempt = 0;; attempt++) {
      signal?.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        signal?.throwIfAborted();
        const status = error.status;
        const retryable = error instanceof TypeError || status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt === 3) throw error;
        await slept(100 * 2 ** attempt, signal);
      }
    }
  }

  async function jsonRequest(path, options) { return (await request(path, options)).json(); }
  async function downloadPlan(artifact, { signal } = {}) {
    if (!artifact.download_plan_url) {
      return { type: "http-get", method: "GET", authenticated: artifact.authenticated !== false,
        url: artifact.url, size: artifact.size, digest: artifact.digest, expires_at: artifact.expires_at };
    }
    const plan = await retry(() => jsonRequest(artifact.download_plan_url, { signal }), signal);
    if (plan?.method !== "GET" || !["http-get", "presigned-get"].includes(plan.type)
      || plan.authenticated !== (plan.type === "http-get") || typeof plan.url !== "string"
      || plan.size !== artifact.size || plan.digest !== artifact.digest) {
      throw new SpoolError("UNSUPPORTED_DOWNLOAD", "Runner returned an invalid artifact download plan");
    }
    return plan;
  }
  const status = (id, { signal } = {}) => {
    const path = taskPath(id);
    return retry(() => jsonRequest(path, { signal }), signal);
  };

  async function upload(id, descriptor, bytes, { signal, plan } = {}) {
    const offer = plan?.url ? plan : await jsonRequest(plan?.prepare_url ?? `${layerPath(id, descriptor.digest)}/upload`,
      { method: "POST", signal });
    if (offer.method !== "PUT" || (offer.max_size !== undefined && offer.max_size < descriptor.size)) {
      throw new SpoolError("UNSUPPORTED_UPLOAD", "Runner did not offer a PUT transfer");
    }
    const put = (url, body) => retry(() => request(url, {
      method: "PUT", body, signal, transfer: true, authenticated: offer.authenticated !== false,
      extra: { "content-type": "application/octet-stream", ...(offer.bearer_token
        ? { authorization: `Bearer ${offer.bearer_token}` } : {}) },
    }), signal);
    const parts = [];
    if (offer.type === "presigned-multipart") {
      let offset = 0;
      for (const [index, part] of (offer.parts ?? []).entries()) {
        if (part.number !== index + 1 || part.offset !== offset || !Number.isSafeInteger(part.size)
          || part.size <= 0 || offset + part.size > descriptor.size || typeof part.url !== "string") {
          throw new SpoolError("UNSUPPORTED_UPLOAD", "Runner returned an invalid upload part");
        }
        const body = bytes instanceof Uint8Array ? bytes.subarray(offset, offset + part.size) : bytes.slice(offset, offset + part.size);
        const response = await put(part.url, body);
        const etag = response.headers.get("etag");
        await response.body?.cancel();
        if (!etag) throw new SpoolError("UNSUPPORTED_UPLOAD", "Storage did not return a part ETag");
        parts.push({ number: part.number, etag });
        offset += part.size;
      }
      if (offset !== descriptor.size || !offer.complete_url) {
        throw new SpoolError("UNSUPPORTED_UPLOAD", "Runner returned an incomplete multipart plan");
      }
    } else {
      if (typeof offer.url !== "string") throw new SpoolError("UNSUPPORTED_UPLOAD", "Runner returned no upload URL");
      await (await put(offer.url, bytes)).body?.cancel();
    }
    if (offer.complete_url) await retry(() => jsonRequest(offer.complete_url, {
      method: "POST", body: JSON.stringify({ parts }), signal,
      extra: { "content-type": "application/json" },
    }), signal);
  }

  async function supply(id, required, { source = layerSource, signal, plans } = {}) {
    if (!required.length) return;
    if (typeof source !== "function") throw new SpoolError("LAYER_UNAVAILABLE", "No layer source is configured");
    for (const descriptor of required) {
      signal?.throwIfAborted();
      const bytes = await source(descriptor, { signal });
      if (!bytes) throw new SpoolError("LAYER_UNAVAILABLE", `Layer source has no bytes for ${descriptor.digest}`);
      if ((bytes.size ?? bytes.byteLength) !== descriptor.size) {
        throw new SpoolError("LAYER_INVALID", "Local bytes do not match the descriptor size");
      }
      try { await upload(id, descriptor, bytes, { signal, plan: plans?.[descriptor.digest] }); }
      catch (error) {
        if (![403, 404, 409].includes(error.status)) throw error;
        const current = await status(id, { signal });
        if (current.required.some(({ digest }) => digest === descriptor.digest)) throw error;
      }
    }
  }

  return {
    capabilities: ({ signal } = {}) => jsonRequest("/.well-known/portable-task-runner", { signal }),
    submit(manifest, { signal } = {}) {
      if (!manifest?.client_request_id) throw new TypeError("Supply a stable client_request_id for submission retries");
      if (!Number.isSafeInteger(manifest.task_timeout_s) || manifest.task_timeout_s < 1) throw new TypeError("Supply a positive task_timeout_s");
      const body = JSON.stringify(manifest);
      return retry(() => jsonRequest("/v1/tasks", {
        method: "POST", body, signal, extra: { "content-type": "application/json" },
      }), signal);
    },
    status,
    extend(id, taskTimeoutSeconds, { signal } = {}) {
      if (!Number.isSafeInteger(taskTimeoutSeconds) || taskTimeoutSeconds < 1) throw new TypeError("Supply a positive task_timeout_s");
      const body = JSON.stringify({ task_timeout_s: taskTimeoutSeconds });
      return retry(() => jsonRequest(`${taskPath(id)}/extend`, {
        method: "POST", body, signal, extra: { "content-type": "application/json" },
      }), signal);
    },
    eventPage(id, { cursor = 0, limit = 100, signal } = {}) {
      return jsonRequest(`${taskPath(id)}/events?${new URLSearchParams({ cursor, limit })}`, { signal });
    },
    cancel: (id, { signal } = {}) => jsonRequest(`${taskPath(id)}/cancel`, { method: "POST", signal }),
    artifacts: (id, { signal } = {}) => jsonRequest(`${taskPath(id)}/artifacts`, { signal }),
    downloadPlan,
    async download(artifact, { signal } = {}) {
      const plan = await downloadPlan(artifact, { signal });
      try {
        return await request(plan.url, { transfer: true, authenticated: plan.authenticated, signal });
      } catch (error) {
        if (plan.type !== "presigned-get" || !(error.code === "UNTRUSTED_URL" || [403, 404].includes(error.status))) throw error;
        return request(artifact.url, { signal });
      }
    },
    supply,
    async wait(id, { source, signal, pollMs = 500 } = {}) {
      for (;;) {
        const current = await status(id, { signal });
        if (terminal.has(current.state)) return current;
        if (current.required.length) await supply(id, current.required, { source, signal, plans: current.upload_plans });
        else await slept(pollMs, signal);
      }
    },
    async *events(id, { cursor = 0, signal, reconnectMs = 250 } = {}) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Invalid event cursor");
      let reconnects = 0;
      for (;;) {
        try {
          const response = await request(`${taskPath(id)}/events`, {
            signal, extra: { "last-event-id": String(cursor), accept: "text/event-stream" },
          });
          if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
            throw new SpoolError("INVALID_EVENT", "Runner did not return an SSE stream");
          }
          for await (const { id: eventId, value } of frames(response.body)) {
            const sequence = value?.sequence;
            const valid = Number.isSafeInteger(sequence) && eventId === String(sequence) && value?.job_id === id;
            const decision = replayDecision(cursor, sequence, Number(valid));
            if (decision === -1) throw new SpoolError("INVALID_EVENT", "Event identity or sequence is invalid");
            if (decision === 0) continue;
            if (decision === 2) break;
            cursor = sequence;
            reconnects = 0;
            yield value;
            if (value.type === "task.completed") return;
          }
          const current = await status(id, { signal });
          if (terminal.has(current.state) && current.cursor <= cursor) return;
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof SyntaxError) throw new SpoolError("INVALID_EVENT", "Event data is not valid JSON");
          if (error instanceof SpoolError && (error.code === "INVALID_EVENT" || error.status < 500)) throw error;
        }
        if (++reconnects > 8) throw new SpoolError("EVENT_RECONNECT_LIMIT", "Reconnect limit reached without an event");
        await slept(Math.min(reconnectMs * 2 ** (reconnects - 1), 4_000), signal);
      }
    },
  };
}

export { buildLayer, layerDescriptor, PATCH_MEDIA, TAR, TAR_GZIP } from "./layers.mjs";
