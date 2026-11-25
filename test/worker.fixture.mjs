import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import worker, { TenantRunner } from "../src/worker.mjs";
import { BASE, MEDIA, sha256 } from "../src/contract.mjs";

const artifactBytes = new Uint8Array(700 * 1024).fill(37);

export class TestedTenantRunner extends TenantRunner {
  constructor(ctx, env) {
    super(ctx, { ...env, LAYERS: {
      head: (key) => env.LAYERS.head(key),
      async put(key, body, options) {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
        if (options?.sha256 && await sha256(bytes) !== `sha256:${options.sha256}`) throw new Error("Digest mismatch");
        return env.LAYERS.put(key, bytes);
      },
      delete: (key) => env.LAYERS.delete(key),
      async get(key) {
        const result = await env.LAYERS.get(key);
        return result && { size: result.size, arrayBuffer: () => result.bytes.buffer };
      },
    } });
  }
}

export class BlobData extends DurableObject {
  async get(key) {
    const size = await this.ctx.storage.get(key);
    if (size === undefined) return undefined;
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 65536) {
      bytes.set(await this.ctx.storage.get(`${key}:${offset}`), offset);
    }
    return bytes;
  }
  async put(key, bytes) {
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      await this.ctx.storage.put(`${key}:${offset}`, bytes.slice(offset, offset + 65536));
    }
    await this.ctx.storage.put(key, bytes.length);
  }
  async delete(key) {
    const size = await this.ctx.storage.get(key);
    for (let offset = 0; offset < size; offset += 65536) await this.ctx.storage.delete(`${key}:${offset}`);
    await this.ctx.storage.delete(key);
  }
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
    const url = new URL(request.url);
    if (url.pathname === "/stop") return new Response(null, { status: 204 });
    if (url.pathname === "/artifact/0" && request.headers.get("x-spool-claim")) return new Response(artifactBytes);
    if (url.pathname === "/status") {
      if (!await this.ctx.storage.get("started")) return new Response(null, { status: 404 });
      if (url.searchParams.get("cursor") === "0") return Response.json({
        logs: [{ channel: "stdout", text: "Cloudflare task running\n" }], cursor: 1, result: null,
      });
      const artifact = { path: "/workspace/artifact", size: artifactBytes.length, digest: await sha256(artifactBytes) };
      return Response.json({ logs: [], cursor: 1, result: { exit_code: 0, artifacts: [artifact] } });
    }
    if (url.pathname !== "/start") return new Response(null, { status: 404 });
    const payload = await request.text();
    if (payload.slice(payload.indexOf("\n") + 1) !== "tar") throw new Error("Expected bytes forwarded through the R2 adapter");
    await this.ctx.storage.put("started", true);
    return new Response(null, { status: 202 });
  }
}

export default {
  async test(_controller, env) {
    const bytes = new TextEncoder().encode("tar");
    const digest = await sha256(bytes);
    const manifest = {
      protocol_version: "0.1", task_timeout_s: 172800, client_request_id: "worker", platform: { os: "linux", arch: "amd64" },
      environment: { base: BASE, layers: [{ digest, size: bytes.length, media_type: MEDIA[0] }] },
      command: { argv: ["true"], cwd: "/workspace" }, network: { mode: "none" },
      outputs: { paths: ["/workspace/artifact"] },
      resources: { cpu: 1, memory_mib: 256, disk_mib: 4096 },
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
    let page;
    for (let i = 0; i < 70; i++) {
      page = await (await call(`${initial.links.events}?limit=100`)).json();
      if (page.events.some(({ type }) => type === "task.stdout")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (page.terminal || !page.events.some(({ type }) => type === "task.stdout")) throw new Error("Expected live progress");
    const extended = await call(`${initial.links.self}/extend`, "POST", JSON.stringify({ task_timeout_s: 259200 }));
    if (extended.status !== 200) throw new Error(`Extension failed: ${extended.status} ${await extended.text()}`);
    const events = await call(initial.links.events);
    const replay = await events.text();
    if (!replay.includes("layer.available") || !replay.includes("Cloudflare task running") || !replay.includes("SUCCEEDED")) {
      throw new Error(`Expected a complete Worker task: ${replay}`);
    }
    const downloaded = await call(`${initial.links.artifacts}/0`);
    if (downloaded.status !== 200 || await sha256(await downloaded.arrayBuffer()) !== await sha256(artifactBytes)) {
      throw new Error("Expected a verified streamed Worker artifact");
    }
  },
};
