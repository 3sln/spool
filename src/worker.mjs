import { DurableObject } from "cloudflare:workers";
import { publicEndpoint, taskEndpoint } from "./api.mjs";
import { configuredAuth } from "./auth.mjs";
import { configuredLimits, readJSON } from "./contract.mjs";
import { TaskService } from "./service.mjs";
import { workStream } from "./work-stream.mjs";
import { r2Transfers } from "./r2-transfer.mjs";

const EXECUTION = {
  network: "container-internet-disabled", cpu: "vm-one-vcpu-plus-process-rlimit",
  memory: "per-process-address-space", disk: "per-file-rlimit-and-vm-disk",
};
const internal = "https://spool.internal";
const guestOrigin = "http://spool.internal";
const tenantHeader = "x-spool-internal-tenant";
const guestPollMs = 5000;
const guestIdleMs = 120_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workerLimits = (env, direct) => configuredLimits(env, direct
  ? { uploads: ["presigned-put", "presigned-multipart"] }
  : { layerCeiling: 32, defaultLayer: 32 });

let endpoint;
let endpointEnv;
export default {
  fetch(request, env) {
    if (endpointEnv !== env || !endpoint) {
      const auth = configuredAuth(env);
      const transfer = r2Transfers(env);
      endpoint = publicEndpoint(auth, env.SPOOL_ALLOWED_ORIGINS?.split(",") ?? [], EXECUTION, (next, tenant) => {
        const headers = new Headers(next.headers);
        headers.delete("authorization");
        headers.delete("cf-access-jwt-assertion");
        headers.set(tenantHeader, tenant);
        return env.TENANTS.getByName(tenant).fetch(new Request(next, { headers }));
      }, workerLimits(env, transfer));
      endpointEnv = env;
    }
    return endpoint(request);
  },
};

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
    delete: (key) => bucket.delete(key),
  };
}

export class TenantRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const transfers = r2Transfers(env);
    this.service = new TaskService(stateStorage(ctx.storage), objectStorage(env.LAYERS), {
      wake: () => this.schedule(Date.now() + 50), limits: workerLimits(env, transfers), transfers,
      stop: (id, claim) => this.stop(id, claim),
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
    try {
      const response = await this.slot(id, work.claim).fetch(`${internal}/start`, {
        method: "POST", body: workStream(work, (index) => this.service.executionLayer(id, work.claim, index)),
        headers: { "x-spool-expires": String(work.expires) },
      });
      if (!response.ok) throw new Error(`Guest start returned ${response.status}`);
    } catch (error) {
      // The request can fail after the guest starts. Recover through the next poll.
      console.error(error.message);
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
    if (path === "/status" && request.method === "GET" && container.running) {
      await container.setInactivityTimeout(guestIdleMs);
      return container.getTcpPort(8080).fetch(`${guestOrigin}/status${url.search}`, {
        headers: { "x-spool-claim": request.headers.get("x-spool-claim") ?? "" },
        signal: AbortSignal.timeout(5000),
      });
    }
    if (path !== "/start" || request.method !== "POST") return new Response(null, { status: 404 });
    const used = await this.ctx.storage.get("used");
    if (used) return new Response(null, { status: 409 });
    const expires = Number(request.headers.get("x-spool-expires"));
    if (!Number.isSafeInteger(expires) || expires <= Date.now()) return new Response(null, { status: 408 });

    // Reserve this single-use slot before attempting to start the container.
    const started = await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("used")) return false;
      await this.ctx.storage.put("used", true);
      await this.ctx.storage.setAlarm(expires);
      return true;
    });
    if (!started) return new Response(null, { status: 409 });
    return this.startGuest(container, expires, request.body);
  }

  async startGuest(container, expires, body) {
    const port = container.getTcpPort(8080);
    const deadline = Math.min(expires, Date.now() + 55_000);
    let ready = false;
    let lastHealthFailure;
    while (Date.now() < deadline) {
      if (await this.ctx.storage.get("cancelled")) break;
      try {
        // Provisioning can briefly fail while the preceding VM is being released.
        if (!container.running) container.start({ enableInternet: false });
        const health = await port.fetch(`${guestOrigin}/healthz`, { signal: AbortSignal.timeout(1500) });
        ready = health.status === 204;
        await health.body?.cancel();
        if (ready) break;
        lastHealthFailure = `HTTP ${health.status}`;
      } catch (error) {
        lastHealthFailure = error.message;
      }
      await delay(500);
    }
    if (!ready || await this.ctx.storage.get("cancelled")) {
      throw new Error(lastHealthFailure
        ? `Guest readiness failed: ${lastHealthFailure}` : "Guest was stopped or did not become ready");
    }
    await container.setInactivityTimeout(guestIdleMs);
    return port.fetch(`${guestOrigin}/start`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body,
      signal: AbortSignal.timeout(Math.max(1, Math.min(600_000, expires - Date.now()))),
    });
  }

  async alarm() {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}
