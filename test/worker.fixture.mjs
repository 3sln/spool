import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import worker, { TenantRunner } from "../src/worker.mjs";
import { BASE, MEDIA, sha256 } from "../src/contract.mjs";

export class TestedTenantRunner extends TenantRunner {
  constructor(ctx, env) {
    super(ctx, { ...env, LAYERS: {
      head: (key) => env.LAYERS.head(key),
      put: (key, bytes) => env.LAYERS.put(key, bytes),
      delete: (key) => env.LAYERS.delete(key),
      async get(key) {
        const result = await env.LAYERS.get(key);
        return result && { size: result.size, arrayBuffer: () => result.bytes.buffer };
      },
    } });
  }
}

export class BlobData extends DurableObject {
  get(key) { return this.ctx.storage.get(key); }
  put(key, bytes) { return this.ctx.storage.put(key, bytes); }
  async delete(key) { await this.ctx.storage.delete(key); }
}

export class BlobBinding extends WorkerEntrypoint {
  get store() { return this.env.BLOB_DATA.getByName("fixture"); }
  async head(key) { return await this.store.get(key) ? { size: 3 } : null; }
  async get(key) {
    const bytes = await this.store.get(key);
    return bytes ? { size: bytes.length, bytes } : null;
  }
  async put(key, bytes) { await this.store.put(key, bytes); }
  async delete(key) { await this.store.delete(key); }
}

export class GuestFixture extends DurableObject {
  async fetch(request) {
    const payload = await request.json();
    if (atob(payload.layers[0]) !== "tar") throw new Error("Expected bytes forwarded through the R2 adapter");
    return Response.json({ exit_code: 0, stdout: "Cloudflare task completed\n" });
  }
}

export default {
  async test(_controller, env) {
    const bytes = new TextEncoder().encode("tar");
    const digest = await sha256(bytes);
    const manifest = {
      protocol_version: "0.1", client_request_id: "worker", platform: { os: "linux", arch: "amd64" },
      environment: { base: BASE, layers: [{ digest, size: bytes.length, media_type: MEDIA[0] }] },
      command: { argv: ["true"], cwd: "/workspace" }, network: { mode: "none" },
      resources: { cpu: 1, memory_mib: 256, disk_mib: 64, timeout_s: 5 },
    };
    const call = (path, method = "GET", body) => worker.fetch(new Request(`https://spool.example${path}`, {
      method, body, headers: { authorization: `Bearer ${env.SPOOL_TOKEN}` },
    }), env);
    const post = await call("/v1/tasks", "POST", JSON.stringify(manifest));
    if (post.status !== 202) throw new Error(`Submit failed: ${post.status} ${await post.text()}`);
    const initial = await post.json();
    if (initial.state !== "WAITING_FOR_LAYER") throw new Error("Expected a cache miss");
    const offer = await call(`${initial.links.self}/layers/${digest}/upload`, "POST");
    const uploaded = await call((await offer.json()).url, "PUT", bytes);
    if (uploaded.status !== 200) throw new Error(`Upload failed: ${uploaded.status} ${await uploaded.text()}`);
    const events = await call(initial.links.events);
    const replay = await events.text();
    if (!replay.includes("layer.available") || !replay.includes("Cloudflare task completed") || !replay.includes("SUCCEEDED")) {
      throw new Error(`Expected a complete Worker task: ${replay}`);
    }
  },
};
