import { canonical, Fault, json, LIMITS, readBytes, sha256, terminal, validateManifest } from "./contract.mjs";

const seconds = (value) => value * 1000;
const taskKey = (id) => `task/${id}`;
const activeKey = (id) => `active/${id}`;
const historyKey = (id) => `history/${id}`;
const cacheKey = (tenant, digest) => `${tenant}/${digest}`;
const leaseKey = (key) => `cache/${key}`;
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function event(job, type, data = {}) {
  job.events.push({ job_id: job.id, sequence: job.events.length + 1, type, time: nowISO(), data });
}

function state(job) {
  return {
    task_id: job.id, state: job.state, created_at: job.created_at,
    deadline: new Date(job.deadline).toISOString(), cursor: job.events.length,
    required: job.missing, result: job.result,
    links: { self: `/v1/tasks/${job.id}`, events: `/v1/tasks/${job.id}/events`, artifacts: `/v1/tasks/${job.id}/artifacts` },
  };
}

export class TaskService {
  #tail = Promise.resolve();
  #running = new Map();

  constructor(store, blobs, { wake = async () => {}, concurrency = 1 } = {}) {
    this.store = store;
    this.blobs = blobs;
    this.wake = wake;
    this.concurrency = concurrency;
  }

  // Persist each transition and its indexes atomically. Executors run outside this queue.
  async locked(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async save(job) {
    const entries = { [taskKey(job.id)]: job };
    if (terminal.has(job.state)) {
      entries[historyKey(job.id)] = Date.now() + seconds(LIMITS.history_ttl_seconds);
      await this.store.commit(entries, [activeKey(job.id)]);
    } else {
      entries[activeKey(job.id)] = job.tenant;
      await this.store.commit(entries);
    }
  }

  async find(id, tenant) {
    const job = await this.store.get(taskKey(id));
    if (!job || (tenant !== undefined && job.tenant !== tenant)) throw new Fault("NOT_FOUND", "Task not found", 404);
    return job;
  }

  async submit(tenant, manifest) {
    validateManifest(manifest);
    const fingerprint = await sha256(canonical(manifest));
    const raw = (await sha256(canonical([tenant, manifest.client_request_id]))).slice(7, 39);
    const id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    const envDigest = await sha256(canonical({ platform: manifest.platform, environment: manifest.environment }));
    return this.locked(async () => {
      const existing = await this.store.get(taskKey(id));
      if (existing) {
        if (existing.tenant !== tenant || existing.fingerprint !== fingerprint) {
          throw new Fault("IDEMPOTENCY_CONFLICT", "client_request_id already names a different manifest", 409);
        }
        return state(existing);
      }
      if ((await this.store.list("active/")).filter(([, owner]) => owner === tenant).length >= LIMITS.max_active_tasks_per_tenant) {
        throw new Fault("QUOTA_EXCEEDED", "Too many active tasks", 429);
      }
      const job = {
        id, tenant, fingerprint, envDigest, manifest, events: [], state: "ACCEPTED",
        created_at: nowISO(), deadline: Date.now() + seconds(LIMITS.wait_seconds),
        missing: [], artifacts: [],
      };
      event(job, "task.accepted", { request_id: manifest.client_request_id });
      await this.resolve(job);
      await this.wake(job);
      await this.save(job);
      return state(job);
    });
  }

  async resolve(job) {
    const missing = new Map();
    for (const layer of job.manifest.environment.layers) {
      const key = cacheKey(job.tenant, layer.digest);
      const cached = await this.store.get(leaseKey(key));
      if (!cached || cached.expires <= Date.now() || cached.size !== layer.size || !(await this.blobs.has(key))) {
        missing.set(layer.digest, layer);
      }
    }
    job.missing = [...missing.values()];
    if (missing.size) {
      job.state = "WAITING_FOR_LAYER";
      job.uploadToken ??= crypto.randomUUID();
      event(job, "layer.required", { digests: job.missing, nonce: job.uploadToken, deadline: new Date(job.deadline).toISOString(), upload: "request-http-put" });
    } else {
      job.state = "QUEUED";
      job.queue_epoch = crypto.randomUUID();
      event(job, "environment.ready", { environment_digest: job.envDigest });
      event(job, "task.queued");
    }
  }

  async status(tenant, id) { return this.locked(async () => state(await this.find(id, tenant))); }

  async uploadOffer(tenant, id, digest) {
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      this.uploadDescriptor(job, digest);
      return {
        method: "PUT", url: `/v1/tasks/${id}/layers/${digest}?capability=${job.uploadToken}`,
        expires_at: new Date(job.deadline).toISOString(), authenticated: true,
      };
    });
  }

  uploadDescriptor(job, digest) {
    const descriptor = job.manifest.environment.layers.find((layer) => layer.digest === digest);
    if (!descriptor || !job.uploadToken) throw new Fault("NOT_FOUND", "Layer upload was not requested", 404);
    if (!job.missing.some((layer) => layer.digest === digest) && !job.uploaded?.includes(digest)) {
      throw new Fault("NOT_FOUND", "Layer upload was not requested", 404);
    }
    return descriptor;
  }

  async upload(tenant, id, digest, capability, request) {
    const size = await this.locked(async () => {
      const job = await this.find(id, tenant);
      if (!capability || job.uploadToken !== capability || job.deadline <= Date.now()) {
        throw new Fault("FORBIDDEN", "Upload capability is invalid or expired", 403);
      }
      return this.uploadDescriptor(job, digest).size;
    });
    const bytes = await readBytes(request, size);
    if (bytes.length !== size || await sha256(bytes) !== digest) {
      throw new Fault("LAYER_INVALID", "Layer length or digest does not match the descriptor", 422);
    }
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      if (job.uploaded?.includes(digest) && !job.missing.some((layer) => layer.digest === digest)) return state(job);
      if (job.deadline <= Date.now() || job.state !== "WAITING_FOR_LAYER") {
        throw new Fault("FORBIDDEN", "Task can no longer accept layers", 403);
      }
      const key = cacheKey(tenant, digest);
      await this.wake(job);
      await this.blobs.put(key, bytes);
      await this.store.commit({ [leaseKey(key)]: { size, expires: Date.now() + seconds(LIMITS.cache_ttl_seconds) } });
      job.uploaded ??= [];
      job.uploaded.push(digest);
      event(job, "layer.available", { digest, size });
      await this.resolve(job);
      await this.save(job);
      return state(job);
    });
  }

  async retain(tenant, id, digest, ttl) {
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > LIMITS.cache_ttl_seconds) {
      throw new Fault("RESOURCE_LIMIT", "Invalid cache lease duration");
    }
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      if (!job.manifest.environment.layers.some((layer) => layer.digest === digest)) {
        throw new Fault("NOT_FOUND", "Layer not referenced by this task", 404);
      }
      const key = cacheKey(tenant, digest);
      const lease = await this.store.get(leaseKey(key));
      if (!lease || !(await this.blobs.has(key))) throw new Fault("NOT_FOUND", "Layer absent from cache", 404);
      lease.expires = Math.max(lease.expires, Date.now() + seconds(ttl));
      await this.wake(job);
      await this.store.commit({ [leaseKey(key)]: lease });
      return { digest, expires_at: new Date(lease.expires).toISOString(), guaranteed: false };
    });
  }

  async cancel(tenant, id) {
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      if (!terminal.has(job.state)) {
        await this.wake(job);
        await this.complete(job, "CANCELLED", { error: "CANCELLED" });
        this.#running.get(id)?.abort();
      }
      return state(job);
    });
  }

  async complete(job, next, result) {
    job.state = next;
    job.missing = [];
    job.result = result;
    event(job, "task.completed", { state: next, ...result });
    await this.save(job);
  }

  async events(tenant, id, cursor, signal) {
    const initial = await this.locked(() => this.find(id, tenant));
    const service = this;
    const encoder = new TextEncoder();
    let job = initial;
    let ended = false;
    const until = Date.now() + 20_000;
    const stream = new ReadableStream({
      async pull(controller) {
        while (!ended && !signal?.aborted) {
          const entries = job.events.slice(cursor);
          if (entries.length) {
            const entry = entries[0];
            cursor = entry.sequence;
            controller.enqueue(encoder.encode(`id: ${entry.sequence}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`));
            return;
          }
          if (terminal.has(job.state) || Date.now() >= until) break;
          await sleep(500);
          if (!ended && !signal?.aborted) job = await service.locked(() => service.find(id, tenant));
        }
        if (!ended) controller.close();
      },
      cancel() { ended = true; },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  async artifact(tenant, id, index) {
    const job = await this.locked(() => this.find(id, tenant));
    const artifacts = job.artifacts.map(({ body, ...metadata }) => metadata);
    if (index === undefined) return json({ artifacts });
    const artifact = job.artifacts[index];
    if (!artifact) throw new Fault("NOT_FOUND", "Artifact not found", 404);
    return new Response(Uint8Array.from(atob(artifact.body), (character) => character.charCodeAt(0)), {
      headers: { "content-type": "application/octet-stream", "content-disposition": "attachment", "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  }

  async sweep() {
    return this.locked(async () => {
      const queued = [];
      const current = Date.now();
      for (const [key] of await this.store.list("active/")) {
        const job = await this.find(key.slice(7));
        if (job.deadline <= current) {
          const expired = job.state !== "RUNNING";
          await this.complete(job, expired ? "EXPIRED" : "FAILED", {
            error: job.state === "WAITING_FOR_LAYER" ? "LAYER_UNAVAILABLE" : expired ? "DEADLINE_EXCEEDED" : "SANDBOX_FAILURE",
            retryable: false,
          });
          this.#running.get(job.id)?.abort();
        } else if (job.state === "QUEUED") queued.push(job);
      }
      for (const [key, lease] of await this.store.list("cache/")) {
        if (lease.expires > current) continue;
        await this.blobs.delete(key.slice(6));
        await this.store.commit({}, [key]);
      }
      for (const [key, expires] of await this.store.list("history/")) {
        if (expires <= current) await this.store.commit({}, [key, taskKey(key.slice(8))]);
      }
      return queued.sort((first, second) => first.created_at.localeCompare(second.created_at)).map(({ id, queue_epoch }) => ({ id, epoch: queue_epoch }));
    });
  }

  async nextAlarm() {
    return this.locked(async () => {
      let next = Infinity;
      if ((await this.store.list("active/")).length) next = Date.now() + 5000;
      for (const [, lease] of await this.store.list("cache/")) next = Math.min(next, lease.expires);
      for (const [, expires] of await this.store.list("history/")) next = Math.min(next, expires);
      return next;
    });
  }

  async claim(id, epoch) {
    return this.locked(async () => {
      const job = await this.find(id).catch((error) => {
        if (error instanceof Fault && error.status === 404) return null;
        throw error;
      });
      if (job?.state !== "QUEUED" || (epoch !== undefined && job.queue_epoch !== epoch) || job.deadline <= Date.now()) return null;
      const layers = [];
      for (const layer of job.manifest.environment.layers) {
        const key = cacheKey(job.tenant, layer.digest);
        const bytes = await this.blobs.get(key);
        if (!bytes || bytes.length !== layer.size || await sha256(bytes) !== layer.digest) {
          await this.blobs.delete(key);
          await this.store.commit({}, [leaseKey(key)]);
          await this.resolve(job);
          await this.save(job);
          return null;
        }
        let data = "";
        for (let i = 0; i < bytes.length; i += 0x8000) data += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        layers.push(btoa(data));
      }
      job.state = "RUNNING";
      job.claim = crypto.randomUUID();
      job.deadline = Date.now() + seconds(job.manifest.resources.timeout_s + LIMITS.start_budget_seconds);
      event(job, "task.started", { attempt: 1 });
      await this.save(job);
      return { claim: job.claim, expires: job.deadline, manifest: job.manifest, layers };
    });
  }

  async liveClaim(id, claim) {
    return this.locked(async () => {
      const job = await this.store.get(taskKey(id));
      return job?.state === "RUNNING" && job.claim === claim && job.deadline > Date.now();
    });
  }

  async finish(id, claim, result) {
    return this.locked(async () => {
      const job = await this.store.get(taskKey(id));
      if (job?.state !== "RUNNING" || job.claim !== claim || job.deadline <= Date.now()) return false;
      const errors = ["LAYER_INVALID", "DEADLINE_EXCEEDED", "RESOURCE_LIMIT", "EXECUTION_FAILED", "SANDBOX_FAILURE"];
      if (!result || typeof result !== "object" || (result.error ? !errors.includes(result.error)
        : !Number.isSafeInteger(result.exit_code) || result.exit_code < -255 || result.exit_code > 255)) {
        result = { error: "SANDBOX_FAILURE" };
      }
      const paths = job.manifest.outputs?.paths ?? [];
      let remaining = LIMITS.max_artifact_bytes_total;
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts.slice(0, paths.length) : [];
      for (const raw of artifacts) {
        if (!paths.includes(raw?.path) || job.artifacts.some(({ path }) => path === raw.path)
          || typeof raw.body !== "string" || raw.body.length > Math.ceil(remaining / 3) * 4) continue;
        let bytes;
        try { bytes = Uint8Array.from(atob(raw.body), (character) => character.charCodeAt(0)); }
        catch { continue; }
        if (bytes.length > remaining) continue;
        remaining -= bytes.length;
        const index = job.artifacts.length;
        const artifact = {
          path: raw.path, digest: await sha256(bytes), size: bytes.length, media_type: "application/octet-stream",
          url: `/v1/tasks/${job.id}/artifacts/${index}`,
        };
        event(job, "artifact.ready", artifact);
        job.artifacts.push({ ...artifact, body: raw.body });
      }
      let budget = LIMITS.max_logs_bytes;
      for (const channel of ["stdout", "stderr"]) {
        if (typeof result[channel] !== "string") continue;
        const bytes = new TextEncoder().encode(result[channel]).subarray(0, budget);
        budget -= bytes.length;
        for (let offset = 0; offset < bytes.length;) {
          let end = Math.min(offset + 8192, bytes.length);
          while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
          const text = new TextDecoder().decode(bytes.subarray(offset, end));
          event(job, `task.${channel}`, { offset, text });
          offset = end;
        }
      }
      const error = result.error ?? (result.exit_code === 0 ? undefined : "EXECUTION_FAILED");
      await this.complete(job, error === "DEADLINE_EXCEEDED" ? "EXPIRED" : error ? "FAILED" : "SUCCEEDED",
        { exit_code: result.exit_code, error, retryable: false, output_truncated: Boolean(result.output_truncated) });
      return true;
    });
  }

  async run(id, executor) {
    if (this.#running.has(id) || this.#running.size >= this.concurrency) return;
    const controller = new AbortController();
    this.#running.set(id, controller);
    try {
      const work = await this.claim(id);
      if (!work) return;
      if (controller.signal.aborted) return;
      let result;
      try { result = await executor(work, controller.signal, id); }
      catch (error) {
        console.error("Executor failed", id, error.message);
        result = { error: "SANDBOX_FAILURE" };
      }
      await this.finish(id, work.claim, result);
    } finally {
      this.#running.delete(id);
    }
  }
}
