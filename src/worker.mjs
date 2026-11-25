import { DurableObject } from "cloudflare:workers";
import { publicEndpoint, taskEndpoint } from "./api.mjs";
import { configuredAuth } from "./auth.mjs";
import { LIMITS, readJSON } from "./contract.mjs";
import { TaskService } from "./service.mjs";

const EXECUTION = {
  network: "container-internet-disabled", cpu: "vm-one-vcpu-plus-process-rlimit",
  memory: "per-process-address-space", disk: "per-file-rlimit-and-vm-disk",
};
const internal = "https://spool.internal";
const guestOrigin = "http://spool.internal";
const tenantHeader = "x-spool-internal-tenant";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let endpoint;
let endpointEnv;
export default {
  fetch(request, env) {
    if (endpointEnv !== env || !endpoint) {
      const auth = configuredAuth(env);
      endpoint = publicEndpoint(auth, env.SPOOL_ALLOWED_ORIGINS?.split(",") ?? [], EXECUTION, (next, tenant) => {
        const headers = new Headers(next.headers);
        headers.delete("authorization");
        headers.delete("cf-access-jwt-assertion");
        headers.set(tenantHeader, tenant);
        return env.TENANTS.getByName(tenant).fetch(new Request(next, { headers }));
      });
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
    async get(key) {
      const object = await bucket.get(key);
      if (object && object.size <= LIMITS.max_layer_bytes) return new Uint8Array(await object.arrayBuffer());
      await object?.body?.cancel();
      return undefined;
    },
    put: (key, bytes) => bucket.put(key, bytes),
    delete: (key) => bucket.delete(key),
  };
}

export class TenantRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new TaskService(stateStorage(ctx.storage), objectStorage(env.LAYERS), {
      wake: () => this.schedule(Date.now() + 50),
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
      const [job] = await this.service.sweep();
      if (job) await this.service.run(job.id, (work, signal, id) => this.execute(work, signal, id));
    } finally {
      const next = await this.service.nextAlarm();
      if (Number.isFinite(next)) await this.schedule(next);
    }
  }

  async execute(work, signal, id) {
    const slot = this.env.GUESTS.getByName(`${id}:${work.claim}`);
    const stop = () => slot.fetch(`${internal}/stop`, { method: "POST" }).then((response) => {
      if (!response.ok) throw new Error("Guest stop failed");
    });
    const cancel = () => this.ctx.waitUntil(stop().catch((error) => console.error(error.message)));
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) return { error: "CANCELLED" };
      const response = await slot.fetch(`${internal}/execute`, {
        method: "POST", body: JSON.stringify(work),
      });
      if (!response.ok) throw new Error(`Guest execution returned ${response.status}`);
      return await readJSON(response, 2 * 1024 ** 2);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

export class GuestSlot extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const container = this.ctx.container;
    if (request.method !== "POST" || !container) return new Response(null, { status: 404 });

    if (path === "/stop") {
      await this.ctx.storage.put({ used: true, cancelled: true });
      if (container.running) await container.destroy();
      return new Response(null, { status: 204 });
    }
    if (path !== "/execute") return new Response(null, { status: 404 });
    const used = await this.ctx.storage.get("used");
    if (used) return new Response(null, { status: 409 });
    const body = await request.text();
    const work = JSON.parse(body);
    if (work.expires <= Date.now()) return new Response(null, { status: 408 });

    // Reserve this single-use slot before attempting to start the container.
    const started = await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("used")) return false;
      await this.ctx.storage.put("used", true);
      await this.ctx.storage.setAlarm(work.expires);
      return true;
    });
    if (!started) return new Response(null, { status: 409 });
    try {
      const port = container.getTcpPort(8080);
      const deadline = Math.min(work.expires, Date.now() + 55_000);
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
      await container.setInactivityTimeout(work.manifest.resources.timeout_s * 1000 + 65_000);
      const response = await port.fetch(`${guestOrigin}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(Math.max(1, work.expires - Date.now())),
      });
      const result = await readJSON(response, 2 * 1024 ** 2);
      return Response.json(result, { status: response.status });
    } finally {
      if (container.running) await container.destroy();
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm() {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}
