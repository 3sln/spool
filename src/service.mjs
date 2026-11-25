import { canonical, digestPattern, Fault, json, LIMITS, readBytes, sha256, terminal, validateManifest } from "./contract.mjs";

const seconds = (value) => value * 1000;
const taskKey = (id) => `task/${id}`;
const activeKey = (id) => `active/${id}`;
const historyKey = (id) => `history/${id}`;
const cacheKey = (tenant, digest) => `${tenant}/${digest}`;
const leaseKey = (key) => `cache/${key}`;
const stagingKey = (key) => `upload-stage/${key}`;
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function event(job, type, data = {}) {
  job.events.push({ job_id: job.id, sequence: job.events.length + 1, type, time: nowISO(), data });
}

function uploadPlan(job, descriptor) {
  const root = `/v1/tasks/${job.id}/layers/${descriptor.digest}`;
  const common = { max_size: descriptor.size, expires_at: new Date(job.deadline).toISOString() };
  const type = job.transferKinds?.[descriptor.digest] ?? "http-put";
  return type === "http-put" ? {
    ...common, type, method: "PUT", authenticated: true, url: `${root}?capability=${job.uploadToken}`,
  } : { ...common, type, prepare_url: `${root}/upload` };
}

function state(job) {
  return {
    task_id: job.id, state: job.state, created_at: job.created_at,
    deadline: new Date(job.deadline).toISOString(),
    task_deadline: new Date(job.taskDeadline ?? job.deadline).toISOString(),
    hard_deadline: new Date(job.hardDeadline ?? job.deadline).toISOString(),
    ...(job.executionLimit ? { execution_deadline_limit: new Date(Math.min(job.hardDeadline ?? job.deadline, job.executionLimit)).toISOString() } : {}),
    cursor: job.events.length,
    required: job.missing, result: job.result,
    upload_plans: Object.fromEntries(job.missing.map((descriptor) => [descriptor.digest, uploadPlan(job, descriptor)])),
    links: { self: `/v1/tasks/${job.id}`, events: `/v1/tasks/${job.id}/events`, artifacts: `/v1/tasks/${job.id}/artifacts` },
  };
}

export class TaskService {
  #tail = Promise.resolve();
  #running = new Map();

  constructor(store, blobs, { wake = async () => {}, stop = async () => {}, concurrency = 1, limits = LIMITS, transfers, artifactStorage } = {}) {
    this.store = store;
    this.blobs = blobs;
    this.wake = wake;
    this.stop = stop;
    this.limits = limits;
    this.concurrency = concurrency;
    this.transfers = transfers;
    this.artifactStorage = artifactStorage;
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
    validateManifest(manifest, this.limits);
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
        await this.expire(existing);
        return state(existing);
      }
      if ((await this.store.list("active/")).filter(([, owner]) => owner === tenant).length >= LIMITS.max_active_tasks_per_tenant) {
        throw new Fault("QUOTA_EXCEEDED", "Too many active tasks", 429);
      }
      const accepted = Date.now();
      const taskDeadline = accepted + seconds(manifest.task_timeout_s);
      const hardDeadline = accepted + seconds(this.limits.max_task_seconds);
      const admissionLimit = accepted + seconds(this.limits.wait_seconds);
      const job = {
        id, tenant, fingerprint, envDigest, manifest, events: [], state: "ACCEPTED",
        created_at: new Date(accepted).toISOString(), taskDeadline, hardDeadline, admissionLimit,
        deadline: Math.min(taskDeadline, admissionLimit), missing: [], artifacts: [],
        commandTimeout: manifest.resources.timeout_s ?? this.limits.max_job_seconds,
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
      if (!cached || cached.expires <= Date.now() || cached.size !== layer.size || !(await this.blobs.has(cached.storage ?? key))) {
        missing.set(layer.digest, layer);
      }
    }
    job.missing = [...missing.values()];
    if (missing.size) {
      job.state = "WAITING_FOR_LAYER";
      job.uploadToken ??= crypto.randomUUID();
      job.transferKinds ??= {};
      if (this.transfers) for (const descriptor of job.missing) job.transferKinds[descriptor.digest] = this.transfers.kind(descriptor.size);
      event(job, "layer.required", { digests: job.missing, deadline: new Date(job.deadline).toISOString(),
        upload_plans: Object.fromEntries(job.missing.map((descriptor) => [descriptor.digest, uploadPlan(job, descriptor)])) });
    } else {
      job.state = "QUEUED";
      job.queue_epoch = crypto.randomUUID();
      event(job, "environment.ready", { environment_digest: job.envDigest });
      event(job, "task.queued");
    }
  }

  async status(tenant, id) {
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      await this.expire(job);
      return state(job);
    });
  }

  async extend(tenant, id, timeout) {
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Fault("INVALID_MANIFEST", "task_timeout_s must be a positive integer");
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      await this.expire(job);
      if (job.state !== "RUNNING") throw new Fault("TASK_NOT_RUNNING", "Only a running task can be extended", 409);
      const requested = Date.parse(job.created_at) + seconds(timeout);
      const maximum = Math.min(job.hardDeadline ?? job.deadline, job.executionLimit ?? job.deadline);
      if (requested <= (job.taskDeadline ?? job.deadline)) return state(job);
      if (requested > maximum) throw new Fault("RESOURCE_LIMIT", "Extension exceeds the hard task or execution limit");
      job.taskDeadline = requested;
      job.deadline = requested;
      event(job, "task.deadline_extended", { deadline: new Date(requested).toISOString() });
      await this.wake(job);
      await this.save(job);
      return state(job);
    });
  }

  async expire(job, now = Date.now()) {
    if (terminal.has(job.state) || job.deadline > now) return false;
    const running = job.state === "RUNNING";
    await this.complete(job, "EXPIRED", {
      error: job.state === "WAITING_FOR_LAYER" ? "LAYER_UNAVAILABLE" : "DEADLINE_EXCEEDED", retryable: false,
    });
    if (running) await this.stopExecution(job);
    return true;
  }

  async stopExecution(job) {
    this.#running.get(job.id)?.abort();
    try { await this.stop(job.id, job.claim); }
    catch (error) { console.error("Failed to stop guest", job.id, error.message); }
  }


  async uploadOffer(tenant, id, digest) {
    const offer = await this.locked(async () => {
      const job = await this.find(id, tenant);
      const descriptor = this.uploadDescriptor(job, digest);
      const plan = uploadPlan(job, descriptor);
      if (plan.type === "http-put") return { plan };
      if (job.state !== "WAITING_FOR_LAYER" || job.deadline <= Date.now()) throw new Fault("FORBIDDEN", "Upload plan expired", 403);
      if (!this.transfers) throw new Fault("LAYER_UNAVAILABLE", "Direct uploads are unavailable", 503);
      job.uploadStages ??= {};
      let stage = job.uploadStages[digest];
      if (!stage) {
        const storage = `staging/${tenant}/${id}/${crypto.randomUUID()}`;
        stage = { storage, expires: job.deadline, ...await this.transfers.create({ storage, size: descriptor.size }) };
        job.uploadStages[digest] = stage;
        await this.store.commit({ [stagingKey(storage)]: stage });
        await this.wake(job);
        await this.save(job);
      }
      return { plan, stage, descriptor };
    });
    if (!offer.stage) return offer.plan;
    const { max_size, expires_at } = offer.plan;
    return { max_size, expires_at, ...await this.transfers.plan(offer.stage, offer.descriptor),
      complete_url: `/v1/tasks/${id}/layers/${digest}/complete` };
  }

  async completeUpload(tenant, id, digest, parts) {
    const pending = await this.locked(async () => {
      const job = await this.find(id, tenant);
      const descriptor = this.uploadDescriptor(job, digest);
      if (job.uploaded?.includes(digest) && !job.missing.some((layer) => layer.digest === digest)) return { done: state(job) };
      const stage = job.uploadStages?.[digest];
      if (!this.transfers || !stage || job.state !== "WAITING_FOR_LAYER" || job.deadline <= Date.now()) {
        throw new Fault("FORBIDDEN", "Upload plan is invalid or expired", 403);
      }
      return { descriptor, stage };
    });
    if (pending.done) return pending.done;
    const { descriptor, stage } = pending;
    let storage;
    try { storage = await this.transfers.confirm(stage, descriptor, parts); }
    catch (error) {
      if (error.replaceUpload) await this.locked(async () => {
        const job = await this.find(id, tenant);
        if (job.uploadStages?.[digest]?.storage !== stage.storage) return;
        delete job.uploadStages[digest];
        await this.save(job);
      });
      throw error;
    }
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      if (job.uploaded?.includes(digest) && !job.missing.some((layer) => layer.digest === digest)) return state(job);
      if (job.state !== "WAITING_FOR_LAYER" || job.deadline <= Date.now()) throw new Fault("FORBIDDEN", "Upload plan expired", 403);
      const key = cacheKey(tenant, digest);
      const previous = await this.store.get(leaseKey(key));
      if (previous && previous.expires > Date.now() && previous.size === descriptor.size
        && await this.blobs.has(previous.storage ?? key)) {
        return this.recordLayer(job, descriptor, key, previous.storage);
      }
      await this.store.commit({ [stagingKey(stage.storage)]: { ...stage, keep: storage } });
      return this.recordLayer(job, descriptor, key, storage);
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
    const descriptor = await this.locked(async () => {
      const job = await this.find(id, tenant);
      if (!capability || job.uploadToken !== capability || job.deadline <= Date.now()) {
        throw new Fault("FORBIDDEN", "Upload capability is invalid or expired", 403);
      }
      if (job.transferKinds?.[digest]) throw new Fault("FORBIDDEN", "Use the direct upload plan", 403);
      return this.uploadDescriptor(job, digest);
    });
    const key = cacheKey(tenant, digest);
    let bytes;
    if (this.blobs.putVerified) {
      await this.blobs.putVerified(key, request, descriptor);
      await this.locked(async () => {
        const previous = await this.store.get(leaseKey(key));
        if (!previous || previous.expires <= Date.now()) {
          await this.store.commit({ [leaseKey(key)]: { size: descriptor.size, expires: Date.now() + seconds(LIMITS.cache_ttl_seconds) } });
        }
      });
    } else {
      bytes = await readBytes(request, descriptor.size);
      if (bytes.length !== descriptor.size || await sha256(bytes) !== digest) {
        throw new Fault("LAYER_INVALID", "Layer length or digest does not match the descriptor", 422);
      }
    }
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      if (job.uploaded?.includes(digest) && !job.missing.some((layer) => layer.digest === digest)) return state(job);
      if (job.deadline <= Date.now() || job.state !== "WAITING_FOR_LAYER") {
        throw new Fault("FORBIDDEN", "Task can no longer accept layers", 403);
      }
      await this.wake(job);
      if (bytes) await this.blobs.put(key, bytes);
      return this.recordLayer(job, descriptor, key);
    });
  }

  async recordLayer(job, { digest, size }, key, storage) {
    await this.store.commit({ [leaseKey(key)]: { size, storage, expires: Date.now() + seconds(LIMITS.cache_ttl_seconds) } });
    job.uploaded ??= [];
    if (!job.uploaded.includes(digest)) job.uploaded.push(digest);
    event(job, "layer.available", { digest, size });
    await this.resolve(job);
    await this.save(job);
    return state(job);
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
      if (!lease || !(await this.blobs.has(lease.storage ?? key))) throw new Fault("NOT_FOUND", "Layer absent from cache", 404);
      lease.expires = Math.max(lease.expires, Date.now() + seconds(ttl));
      await this.wake(job);
      await this.store.commit({ [leaseKey(key)]: lease });
      return { digest, expires_at: new Date(lease.expires).toISOString(), guaranteed: false };
    });
  }

  async cancel(tenant, id) {
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      await this.expire(job);
      if (!terminal.has(job.state)) {
        const running = job.state === "RUNNING";
        await this.wake(job);
        await this.complete(job, "CANCELLED", { error: "CANCELLED" });
        if (running) await this.stopExecution(job);
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

  appendLog(job, channel, text) {
    if (!["stdout", "stderr"].includes(channel) || typeof text !== "string" || !text.length) return false;
    job.logOffsets ??= { stdout: 0, stderr: 0 };
    const remaining = LIMITS.max_logs_bytes - job.logOffsets.stdout - job.logOffsets.stderr;
    const input = new TextEncoder().encode(text);
    job.logEvents ??= 0;
    let size = Math.min(input.length, remaining);
    while (size > 0 && size < input.length && (input[size] & 0xc0) === 0x80) size--;
    let offset = 0;
    for (; offset < size && job.logEvents < LIMITS.max_log_events;) {
      let end = Math.min(offset + 8192, size);
      while (end < size && (input[end] & 0xc0) === 0x80) end--;
      event(job, `task.${channel}`, {
        offset: job.logOffsets[channel], text: new TextDecoder().decode(input.subarray(offset, end)),
      });
      job.logOffsets[channel] += end - offset;
      job.logEvents++;
      offset = end;
    }
    const truncatedNow = input.length > offset && !job.logsTruncated;
    if (truncatedNow) job.logsTruncated = true;
    return offset > 0 || truncatedNow;
  }

  async log(id, claim, chunk) {
    if (!chunk || typeof chunk.text !== "string" || chunk.text.length > 8192) return false;
    return this.locked(async () => {
      const job = await this.store.get(taskKey(id));
      if (job?.state !== "RUNNING" || job.claim !== claim || await this.expire(job)) return false;
      if (this.appendLog(job, chunk.channel, chunk.text)) await this.save(job);
      return true;
    });
  }

  async runningClaim() {
    return this.locked(async () => {
      for (const [key] of await this.store.list("active/")) {
        const job = await this.find(key.slice(7));
        if (job.state === "RUNNING" && !await this.expire(job)) {
          return { id: job.id, claim: job.claim, cursor: job.guestCursor ?? 0,
            started_at: job.startedAt ?? Date.parse(job.created_at) };
        }
      }
      return null;
    });
  }

  async guestProgress(id, claim, after, page) {
    return this.locked(async () => {
      const job = await this.store.get(taskKey(id));
      if (job?.state !== "RUNNING" || job.claim !== claim || await this.expire(job)) return false;
      if ((job.guestCursor ?? 0) !== after) return false;
      for (const chunk of page.logs) this.appendLog(job, chunk.channel, chunk.text);
      if (page.cursor !== after) {
        job.guestCursor = page.cursor;
        await this.save(job);
      }
      return true;
    });
  }

  async eventPage(tenant, id, cursor, limit) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Fault("INVALID_MANIFEST", "Expected a nonnegative cursor and a page limit from 1 to 100");
    }
    return this.locked(async () => {
      const job = await this.find(id, tenant);
      await this.expire(job);
      const events = job.events.slice(cursor, cursor + limit);
      const next_cursor = events.at(-1)?.sequence ?? cursor;
      return { events, next_cursor, terminal: terminal.has(job.state), has_more: next_cursor < job.events.length };
    });
  }

  async events(tenant, id, cursor, signal) {
    const read = () => this.locked(async () => {
      const job = await this.find(id, tenant);
      await this.expire(job);
      return job;
    });
    const encoder = new TextEncoder();
    let job = await read();
    let ended = false;
    const until = Date.now() + 20_000;
    const stream = new ReadableStream({
      async pull(controller) {
        while (!ended && !signal?.aborted) {
          const entry = job.events[cursor];
          if (entry) {
            cursor = entry.sequence;
            controller.enqueue(encoder.encode(`id: ${entry.sequence}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`));
            return;
          }
          if (terminal.has(job.state) || Date.now() >= until) break;
          await sleep(500);
          if (!ended && !signal?.aborted) job = await read();
        }
        if (!ended) controller.close();
      },
      cancel() { ended = true; },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  async artifact(tenant, id, index) {
    const job = await this.locked(() => this.find(id, tenant));
    const artifacts = job.artifacts.map(({ body, storage, ...metadata }) => metadata);
    if (index === undefined) return json({ artifacts });
    const artifact = job.artifacts[index];
    if (!artifact) throw new Fault("NOT_FOUND", "Artifact not found", 404);
    const body = artifact.storage ? await this.artifactStorage?.open(artifact.storage)
      : Uint8Array.from(atob(artifact.body), (character) => character.charCodeAt(0));
    if (!body) throw new Fault("NOT_FOUND", "Artifact bytes not found", 404);
    return new Response(body, {
      headers: { "content-type": "application/octet-stream", "content-length": String(artifact.size),
        "content-disposition": "attachment", "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  }

  async stageArtifact(id, claim, metadata, request) {
    const { path, size, digest } = metadata ?? {};
    const staged = await this.locked(async () => {
      const job = await this.store.get(taskKey(id));
      if (!this.artifactStorage || job?.state !== "RUNNING" || job.claim !== claim || job.deadline <= Date.now()) {
        throw new Fault("NOT_FOUND", "Active execution claim not found", 404);
      }
      const index = job.manifest.outputs?.paths.indexOf(path) ?? -1;
      if (index < 0 || !Number.isSafeInteger(size) || size < 0 || typeof digest !== "string" || !digestPattern.test(digest)) {
        throw new Fault("RESOURCE_LIMIT", "Invalid artifact descriptor", 422);
      }
      job.stagedArtifacts ??= {};
      const existing = job.stagedArtifacts[index];
      if (existing) {
        if (existing.size !== size || existing.digest !== digest) throw new Fault("RESOURCE_LIMIT", "Conflicting artifact descriptor", 409);
        return existing;
      }
      const total = Object.values(job.stagedArtifacts).reduce((sum, artifact) => sum + artifact.size, size);
      if (total > this.limits.max_artifact_bytes_total) throw new Fault("RESOURCE_LIMIT", "Artifact budget exceeded", 413);
      const stage = { path, size, digest, storage: `artifacts/${job.tenant}/${id}/${claim}/${index}` };
      job.stagedArtifacts[index] = stage;
      await this.save(job);
      return stage;
    });
    if (staged.ready) {
      await request.body?.cancel();
      return;
    }
    await this.artifactStorage.putVerified(staged.storage, request, staged);
    await this.locked(async () => {
      const job = await this.store.get(taskKey(id));
      if (job?.state !== "RUNNING" || job.claim !== claim || job.deadline <= Date.now()) {
        if (!job?.artifacts.some(({ storage }) => storage === staged.storage)) await this.artifactStorage.delete(staged.storage);
        throw new Fault("NOT_FOUND", "Active execution claim not found", 404);
      }
      const descriptor = Object.values(job.stagedArtifacts).find(({ storage }) => storage === staged.storage);
      descriptor.ready = true;
      await this.save(job);
    });
  }

  async sweep() {
    return this.locked(async () => {
      const queued = [];
      const current = Date.now();
      for (const [key] of await this.store.list("active/")) {
        const job = await this.find(key.slice(7));
        if (!await this.expire(job, current) && job.state === "QUEUED") queued.push(job);
      }
      for (const [key, lease] of await this.store.list("cache/")) {
        if (lease.expires > current) continue;
        await this.blobs.delete(lease.storage ?? key.slice(6));
        await this.store.commit({}, [key]);
      }
      for (const [key, stage] of await this.store.list("upload-stage/")) {
        if (stage.expires > current || !this.transfers) continue;
        await this.transfers.discard(stage);
        await this.store.commit({}, [key]);
      }
      for (const [key, expires] of await this.store.list("history/")) {
        if (expires > current) continue;
        const jobKey = taskKey(key.slice(8));
        const job = await this.store.get(jobKey);
        for (const artifact of Object.values(job?.stagedArtifacts ?? {})) await this.artifactStorage?.delete(artifact.storage);
        await this.store.commit({}, [key, jobKey]);
      }
      return queued.sort((first, second) => first.created_at.localeCompare(second.created_at)).map(({ id, queue_epoch }) => ({ id, epoch: queue_epoch }));
    });
  }

  async nextAlarm() {
    return this.locked(async () => {
      let next = Infinity;
      if ((await this.store.list("active/")).length) next = Date.now() + 5000;
      for (const [, lease] of await this.store.list("cache/")) next = Math.min(next, lease.expires);
      for (const [, stage] of await this.store.list("upload-stage/")) next = Math.min(next, stage.expires);
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
      for (const layer of job.manifest.environment.layers) {
        const key = cacheKey(job.tenant, layer.digest);
        const lease = await this.store.get(leaseKey(key));
        if (!lease || lease.expires <= Date.now() || !await this.blobs.has(lease.storage ?? key)) {
          await this.store.commit({}, [leaseKey(key)]);
          await this.resolve(job);
          await this.save(job);
          return null;
        }
        const keepUntil = Date.now() + seconds(this.limits.start_budget_seconds + 60);
        if (lease.expires < keepUntil) {
          await this.store.commit({ [leaseKey(key)]: { ...lease, expires: keepUntil } });
        }
      }
      if (await this.expire(job)) return null;
      job.taskDeadline ??= job.deadline;
      job.hardDeadline ??= job.deadline;
      job.state = "RUNNING";
      job.claim = crypto.randomUUID();
      job.startedAt = Date.now();
      const commandTimeout = job.commandTimeout ?? job.manifest.resources.timeout_s ?? this.limits.max_job_seconds;
      job.executionLimit = job.startedAt + seconds(commandTimeout + this.limits.start_budget_seconds);
      job.deadline = Math.min(job.taskDeadline, job.executionLimit);
      event(job, "task.started", { attempt: 1 });
      await this.save(job);
      const manifest = { ...job.manifest, resources: { ...job.manifest.resources, timeout_s: commandTimeout } };
      return { claim: job.claim, expires: Math.min(job.hardDeadline, job.executionLimit), manifest,
        ...(this.artifactStorage ? { artifact_limit: this.limits.max_artifact_bytes_total } : {}) };
    });
  }

  async executionLayer(id, claim, index) {
    const job = await this.store.get(taskKey(id));
    const layer = job?.manifest.environment.layers[index];
    if (!layer || job.state !== "RUNNING" || job.claim !== claim || job.deadline <= Date.now()) return undefined;
    const key = cacheKey(job.tenant, layer.digest);
    const lease = await this.store.get(leaseKey(key));
    if (!lease) return undefined;
    return this.blobs.open ? this.blobs.open(lease.storage ?? key) : this.blobs.get(lease.storage ?? key);
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
      if (job?.state !== "RUNNING" || job.claim !== claim || await this.expire(job)) return false;
      const errors = ["LAYER_INVALID", "DEADLINE_EXCEEDED", "RESOURCE_LIMIT", "EXECUTION_FAILED", "SANDBOX_FAILURE"];
      if (!result || typeof result !== "object" || (result.error ? !errors.includes(result.error)
        : !Number.isSafeInteger(result.exit_code) || result.exit_code < -255 || result.exit_code > 255)) {
        result = { error: "SANDBOX_FAILURE" };
      }
      const paths = job.manifest.outputs?.paths ?? [];
      let publishedBytes = 0;
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts.slice(0, paths.length) : [];
      if (!result.error || result.error === "EXECUTION_FAILED") {
        for (const { ready, storage, ...metadata } of Object.values(job.stagedArtifacts ?? {})) {
          if (!ready) continue;
          const artifact = { ...metadata, media_type: "application/octet-stream",
            url: `/v1/tasks/${job.id}/artifacts/${job.artifacts.length}` };
          event(job, "artifact.ready", artifact);
          job.artifacts.push({ ...artifact, storage });
          publishedBytes += artifact.size;
        }
      }
      let remaining = Math.min(512 * 1024, this.limits.max_artifact_bytes_total - publishedBytes);
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
      this.appendLog(job, "stdout", result.stdout);
      this.appendLog(job, "stderr", result.stderr);
      if (job.deadline <= Date.now()) {
        await this.expire(await this.find(id));
        return false;
      }
      const error = result.error ?? (result.exit_code === 0 ? undefined : "EXECUTION_FAILED");
      await this.complete(job, error === "DEADLINE_EXCEEDED" ? "EXPIRED" : error ? "FAILED" : "SUCCEEDED",
        { exit_code: result.exit_code, error, retryable: false, output_truncated: Boolean(job.logsTruncated || result.output_truncated) });
      return true;
    });
  }

  watchDeadline(id) {
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { await this.locked(async () => this.expire(await this.find(id))); }
      catch (error) { console.error("Execution deadline check failed", id, error.message); }
      finally { checking = false; }
    }, 750);
    return () => clearInterval(timer);
  }

  async run(id, executor) {
    if (this.#running.has(id) || this.#running.size >= this.concurrency) return;
    const controller = new AbortController();
    this.#running.set(id, controller);
    try {
      const work = await this.claim(id);
      if (!work) return;
      if (controller.signal.aborted) return;
      const stopWatching = this.watchDeadline(id);
      try {
        let result;
        try {
          result = await executor(work, controller.signal, id, (chunk) => this.log(id, work.claim, chunk),
            (index) => this.executionLayer(id, work.claim, index),
            (artifact, body) => this.stageArtifact(id, work.claim, artifact, { body, signal: controller.signal }));
        }
        catch (error) {
          if (!controller.signal.aborted) console.error("Executor failed", id, error.message);
          result = { error: "SANDBOX_FAILURE" };
        }
        await this.finish(id, work.claim, result);
      } finally { stopWatching(); }
    } finally {
      this.#running.delete(id);
    }
  }
}
