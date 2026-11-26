import { DurableObject } from "cloudflare:workers";
import { taskEndpoint } from "./api.mjs";
import { createRunnerHandler } from "./core.mjs";
import { configuredAuth } from "./auth.mjs";
import { configuredLimits, readJSON } from "./contract.mjs";
import { TaskService } from "./service.mjs";
import { workStream } from "./work-stream.mjs";
import { r2Transfers } from "./r2-transfer.mjs";
import { waitForGuest } from "./cloud-startup.mjs";
import { workerResourcePolicy } from "./worker-resources.mjs";
import { configuredLayerPull } from "./layer-pull.mjs";

const EXECUTION = {
  network: "container-internet-disabled", cpu: "vm-vcpu-plus-process-rlimit",
  memory: "vm-memory", disk: "workspace-input-budget-per-file-rlimit-and-vm-disk",
};
const internal = "https://spool.internal";
const guestOrigin = "http://spool.internal";
const tenantHeader = "x-spool-internal-tenant";
const guestPollMs = 5000;
const guestIdleMs = 120_000;
function workerLimits(env, { layers, artifacts, transfers }, layerPull) {
  const limits = configuredLimits(env, transfers ? { uploads: ["presigned-put", "presigned-multipart"] }
    : layerPull.enabled ? undefined : { layerCeiling: 32, defaultLayer: 32 });
  return { ...limits, ...workerResourcePolicy(env),
    ...(!transfers && layerPull.enabled && { max_gateway_layer_bytes: 32 * 1024 ** 2 }),
    patch_layers: true,
    layer_pull: layerPull.enabled,
    artifact_layer_sources: Boolean(artifacts && (layers.importVerified || layers.putVerified)),
    artifact_presigned_get: typeof artifacts?.presignDownload === "function",
  };
}

export function createWorkerRunner({ auth = configuredAuth, storage = r2Storage, layerPull } = {}) {
  const endpoints = new WeakMap();
  return {
    fetch(request, env) {
      let endpoint = endpoints.get(env);
      if (!endpoint) {
        const blobs = storage(env);
        endpoint = createRunnerHandler({
          auth: auth(env), origins: env.SPOOL_ALLOWED_ORIGINS?.split(","),
          execution: EXECUTION, limits: workerLimits(env, blobs, configuredLayerPull(env, blobs.layers, layerPull)),
          dispatch(next, tenant) {
            const headers = new Headers(next.headers);
            headers.delete("authorization");
            headers.delete("cf-access-jwt-assertion");
            headers.set(tenantHeader, tenant);
            return env.TENANTS.getByName(tenant).fetch(new Request(next, { headers }));
          },
        });
        endpoints.set(env, endpoint);
      }
      return endpoint(request);
    },
  };
}

export default createWorkerRunner();

function stateStorage(storage) {
  return {
    get: (key) => storage.get(key),
    async list(prefix) { return [...await storage.list({ prefix })]; },
    commit(entries, removes = []) {
      return storage.transaction(async (transaction) => {
        if (Object.keys(entries).length) await transaction.put(entries);
        if (removes.length) await transaction.delete(removes);
      });
    },
  };
}

function objectStorage(bucket) {
  return {
    async has(key) { return Boolean(await bucket.head(key)); },
    async open(key) {
      const object = await bucket.get(key);
      return object?.body ?? (object && new Uint8Array(await object.arrayBuffer()));
    },
    put: (key, bytes) => bucket.put(key, bytes),
    async importVerified(key, request, { size, digest }) {
      const stream = new FixedLengthStream(size);
      await Promise.all([
        (request.body ?? new Response(new Uint8Array()).body).pipeTo(stream.writable, { signal: request.signal }),
        bucket.put(key, stream.readable, { sha256: digest.slice(7) }),
      ]);
    },
    delete: (key) => bucket.delete(key),
  };
}

function r2Storage(env) {
  const transfers = r2Transfers(env);
  const layers = objectStorage(env.LAYERS);
  return { transfers, layers, artifacts: {
    open: layers.open, delete: layers.delete, putVerified: layers.importVerified, presignDownload: transfers?.download,
  } };
}

export class TenantRunner extends DurableObject {
  static storage = r2Storage;

  constructor(ctx, env) {
    super(ctx, env);
    const storage = this.constructor.storage(env);
    const layerPull = configuredLayerPull(env, storage.layers, this.constructor.layerPull);
    this.service = new TaskService(stateStorage(ctx.storage), storage.layers, {
      wake: () => this.schedule(Date.now() + 50), limits: workerLimits(env, storage, layerPull), transfers: storage.transfers,
      stop: (id, claim) => this.stop(id, claim), artifactStorage: storage.artifacts, layerPull,
    });
  }

  async schedule(timestamp) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > timestamp) await this.ctx.storage.setAlarm(timestamp);
  }

  async fetch(request) {
    const tenant = request.headers.get(tenantHeader);
    return taskEndpoint(request, tenant, this.service);
  }

  async alarm() {
    try {
      const [next] = await this.service.sweep();
      const running = await this.service.runningClaim();
      if (running) {
        await this.schedule(Date.now() + guestPollMs);
        await this.poll(running);
      } else if (next) {
        await this.schedule(Date.now() + guestPollMs);
        const work = await this.service.claim(next.id, next.epoch);
        if (work) await this.launch(next.id, work);
      }
    } finally {
      const next = await this.service.nextAlarm();
      if (Number.isFinite(next)) await this.schedule(next);
    }
  }

  slot(id, claim) { return this.env.GUESTS.getByName(`${id}:${claim}`); }

  stop(id, claim) {
    this.ctx.waitUntil(this.slot(id, claim).fetch(`${internal}/stop`, { method: "POST" }).then((response) => {
      if (!response.ok) throw new Error(`Guest stop returned ${response.status}`);
    }).catch((error) => console.error(error.message)));
  }

  async launch(id, work) {
    const stopWatching = this.service.watchDeadline(id);
    try {
      const startupDeadline = Math.min(work.expires, Date.now() + this.service.limits.start_budget_seconds * 1000);
      const response = await this.slot(id, work.claim).fetch(`${internal}/start`, {
        method: "POST", body: workStream({ ...work, container_memory: true },
          (index) => this.service.executionLayer(id, work.claim, index)),
        headers: { "x-spool-expires": String(work.expires), "x-spool-startup-deadline": String(startupDeadline),
          ...(work.resource_profile && work.resource_profile !== "fixed" && { "x-spool-resource-profile": work.resource_profile }) },
      });
      if (response.status === 422) {
        await this.service.finish(id, work.claim, { error: "RESOURCE_LIMIT" });
        return;
      }
      if (!response.ok) throw new Error(`Guest start returned ${response.status}`);
    } catch (error) {
      // The request can fail after the guest starts. Recover through the next poll.
      console.error(error.message);
    } finally {
      stopWatching();
    }
  }

  async poll({ id, claim, cursor, started_at }) {
    try {
      const response = await this.slot(id, claim).fetch(`${internal}/status?cursor=${cursor}`, {
        headers: { "x-spool-claim": claim },
      });
      if (response.status === 404) {
        if (Date.now() >= started_at + this.service.limits.start_budget_seconds * 1000) {
          await this.service.finish(id, claim, { error: "SANDBOX_FAILURE" });
          this.stop(id, claim);
        }
        return;
      }
      if (!response.ok) throw new Error(`Guest status returned ${response.status}`);
      const page = await readJSON(response, 2 * 1024 ** 2);
      if (!Number.isSafeInteger(page?.cursor) || page.cursor < cursor || !Array.isArray(page.logs)) {
        throw new Error("Invalid guest status");
      }
      if (!await this.service.guestProgress(id, claim, cursor, page)) return;
      if (page.result) {
        const stopWatching = this.service.watchDeadline(id);
        try {
          for (const [index, artifact] of (page.result.artifacts ?? []).entries()) {
            if (!artifact.digest) continue;
            const stream = await this.slot(id, claim).fetch(`${internal}/artifact/${index}`, {
              headers: { "x-spool-claim": claim },
            });
            if (!stream.ok) throw new Error(`Guest artifact returned ${stream.status}`);
            await this.service.stageArtifact(id, claim, artifact, stream);
          }
        } finally { stopWatching(); }
        await this.service.finish(id, claim, page.result);
        this.stop(id, claim);
      } else if (page.logs.length === 32) {
        await this.schedule(Date.now() + 50);
      }
    } catch (error) {
      console.error(error.message);
    }
  }
}

export class GuestSlot extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const container = this.ctx.container;
    if (!container) return new Response(null, { status: 404 });

    if (path === "/stop" && request.method === "POST") {
      await this.ctx.storage.put({ used: true, cancelled: true });
      if (container.running) await container.destroy();
      await this.ctx.storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    const artifact = /^\/artifact\/[0-7]$/u.test(path);
    if ((path === "/status" || artifact) && request.method === "GET" && container.running) {
      await container.setInactivityTimeout(guestIdleMs);
      return container.getTcpPort(8080).fetch(`${guestOrigin}${path}${url.search}`, {
        headers: { "x-spool-claim": request.headers.get("x-spool-claim") ?? "" },
        signal: AbortSignal.timeout(artifact ? 600_000 : 5000),
      });
    }
    if (path !== "/start" || request.method !== "POST") return new Response(null, { status: 404 });
    const used = await this.ctx.storage.get("used");
    if (used) return new Response(null, { status: 409 });
    const expires = Number(request.headers.get("x-spool-expires"));
    const startupDeadline = Number(request.headers.get("x-spool-startup-deadline"));
    if (!Number.isSafeInteger(expires) || !Number.isSafeInteger(startupDeadline)
      || startupDeadline > expires || startupDeadline <= Date.now()) return new Response(null, { status: 408 });
    const policy = workerResourcePolicy(this.env);
    const instance = request.headers.get("x-spool-resource-profile") ?? policy.default_resource_profile;
    if (instance && !policy.resource_profiles?.some(({ name }) => name === instance)) {
      return new Response(null, { status: 422 });
    }

    // Reserve this single-use slot before attempting to start the container.
    const started = await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("used")) return false;
      await this.ctx.storage.put("used", true);
      await this.ctx.storage.setAlarm(expires);
      return true;
    });
    if (!started) return new Response(null, { status: 409 });
    return this.startGuest(container, startupDeadline, request.body, instance);
  }

  async startGuest(container, deadline, body, instance) {
    const cancelled = () => this.ctx.storage.get("cancelled");
    const alias = this.env.SPOOL_CONTAINER_IMAGE;
    const startOptions = {};
    if (alias) {
      startOptions.image = container.images?.[alias];
      if (!startOptions.image) throw new Error(`Unknown guest container image ${alias}`);
      startOptions.instance = instance;
    }
    let port;
    try { port = await waitForGuest(container, deadline, cancelled, { startOptions }); }
    catch (error) {
      console.error("Cloudflare guest startup", error.message, error.cause?.message);
      throw error;
    }
    await container.setInactivityTimeout(guestIdleMs);
    if (deadline <= Date.now() || await cancelled()) return new Response(null, { status: 408 });
    return port.fetch(`${guestOrigin}/start`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  }

  async alarm() {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}
