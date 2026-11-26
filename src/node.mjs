import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { taskEndpoint } from "./api.mjs";
import { createRunnerHandler } from "./core.mjs";
import { bearer, configuredAuth, staticToken } from "./auth.mjs";
import { configuredLimits, json, readJSON, taskPattern } from "./contract.mjs";
import { EXECUTION, ociExecutor } from "./oci.mjs";
import { connectQueue } from "./jetstream.mjs";
import { TaskService } from "./service.mjs";
import { openData } from "./sqlite.mjs";
import { fileBlobs } from "./file-blobs.mjs";

export function nodeHandler(service, auth, { origins = [], workerAuth, execution = EXECUTION } = {}) {
  const publicAPI = createRunnerHandler({
    auth, origins, execution, limits: service.limits, dispatch: (request, tenant) => taskEndpoint(request, tenant, service),
  });
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/internal/")) return publicAPI(request);
    if (!workerAuth) return json({ error: "NOT_FOUND" }, 404);
    if (!await workerAuth(bearer(request))) return json({ error: "UNAUTHORIZED" }, 401);
    const [, , id, action, ...rest] = path.split("/");
    if (request.method !== "POST" || rest.length || !taskPattern.test(id ?? "")) return json({ error: "NOT_FOUND" }, 404);
    try {
      if (action === "artifact") {
        const encoded = request.headers.get("x-spool-artifact") ?? "";
        if (!encoded || encoded.length > 8192) return json({ error: "INVALID_MANIFEST" }, 400);
        let metadata;
        try { metadata = JSON.parse(decodeURIComponent(encoded)); }
        catch { return json({ error: "INVALID_MANIFEST" }, 400); }
        await service.stageArtifact(id, request.headers.get("x-spool-claim"), metadata, request);
        return new Response(null, { status: 204 });
      }
      const body = await readJSON(request, action === "finish" ? 2 * 1024 ** 2 : action === "log" ? 32 * 1024 : 1024);
      if (action === "claim" && typeof body?.epoch === "string") {
        const work = await service.claim(id, body.epoch);
        return work ? json(work) : new Response(null, { status: 204 });
      }
      if (action === "live") return json({ live: await service.liveClaim(id, body?.claim) });
      if (action === "layer" && Number.isSafeInteger(body?.index)) {
        const contents = await service.executionLayer(id, body.claim, body.index);
        return contents ? new Response(contents, { headers: { "content-type": "application/octet-stream" } })
          : new Response(null, { status: 404 });
      }
      if (action === "log") return json({ accepted: await service.log(id, body?.claim, body?.chunk) });
      if (action === "finish") return json({ accepted: await service.finish(id, body?.claim, body?.result) });
      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      return json({ error: error.code ?? "INTERNAL" }, error.status ?? 500);
    }
  };
}

export async function start(env = process.env, overrides = {}) {
  const auth = overrides.auth ?? configuredAuth(env);
  const objectStorage = env.SPOOL_S3_BUCKET ? await (await import("./s3-storage.mjs")).s3Storage(env) : undefined;
  const limits = configuredLimits(env, objectStorage ? { uploads: ["presigned-put", "presigned-multipart"] } : undefined);
  limits.artifact_layer_sources = true;
  limits.artifact_presigned_get = Boolean(objectStorage);
  const workers = Number(env.SPOOL_CONCURRENCY ?? 1);
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(workers) || workers < 1 || workers > 64) throw new Error("Invalid SPOOL_CONCURRENCY");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  const file = env.SPOOL_DB ?? ".spool/spool.sqlite";
  if (file !== ":memory:") await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (env.SPOOL_NATS_URL && env.SPOOL_TOKEN && env.SPOOL_WORKER_TOKEN === env.SPOOL_TOKEN) {
    throw new Error("Cluster authentication requires a separate worker token");
  }
  const workerAuth = env.SPOOL_NATS_URL ? staticToken(env.SPOOL_WORKER_TOKEN) : undefined;
  const queue = env.SPOOL_NATS_URL ? await connectQueue(env, true) : undefined;
  const data = openData(file);
  const temporary = file === ":memory:" ? await mkdtemp(`${tmpdir()}/spool-blobs-`) : undefined;
  const localBlobs = fileBlobs(temporary ?? `${file}.layers`, data.blobs);
  const artifacts = objectStorage ? {
    async open(key) { return await localBlobs.open(key) ?? objectStorage.blobs.open(key); },
    async delete(key) { await Promise.all([localBlobs.delete(key), objectStorage.blobs.delete(key)]); },
    putVerified: objectStorage.blobs.putVerified,
    async presignDownload(key, expires) {
      if (await objectStorage.blobs.has(key)) return objectStorage.transfers.download(key, expires);
    },
  } : localBlobs;
  const service = new TaskService(data.store, objectStorage?.blobs ?? localBlobs, {
    concurrency: workers, limits, transfers: objectStorage?.transfers, artifactStorage: artifacts,
  });
  const handler = nodeHandler(service, auth, {
    origins: env.SPOOL_ALLOWED_ORIGINS?.split(",") ?? [], workerAuth, execution: overrides.execution,
  });
  const executor = overrides.executor ?? ociExecutor(env);
  const active = new Map();
  let scheduling = false;
  let closed = false;

  async function tick() {
    if (scheduling || closed) return;
    scheduling = true;
    try {
      for (const job of await service.sweep()) {
        if (closed) break;
        if (queue) await queue.publish(job);
        else if (active.size < workers && !active.has(job.id)) {
          const run = service.run(job.id, executor).catch((error) => console.error("Task scheduler:", error.message))
            .finally(() => active.delete(job.id));
          active.set(job.id, run);
        }
      }
    } catch (error) {
      console.error("Scheduler:", error.message);
    } finally {
      scheduling = false;
    }
  }

  const server = createServer(async (incoming, outgoing) => {
    const disconnect = new AbortController();
    outgoing.once("close", () => disconnect.abort());
    try {
      // Build URLs against a fixed origin. The Host header must not influence routing or links.
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
        outgoing.writeHead(400).end();
        return;
      }
      const method = incoming.method;
      const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
      const request = new Request(`http://spool.internal${incoming.url}`, {
        method, headers: incoming.headers, body, duplex: body ? "half" : undefined, signal: disconnect.signal,
      });
      const result = await handler(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body), outgoing);
      else outgoing.end();
    } catch (error) {
      if (disconnect.signal.aborted) return;
      if (!outgoing.headersSent) outgoing.writeHead(500).end();
      else outgoing.destroy();
      console.error("HTTP bridge:", error.message);
    }
  });
  server.requestTimeout = limits.wait_seconds * 1000;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, env.HOST ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    await queue?.close();
    data.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  const timer = setInterval(() => void tick(), 750);
  void tick();
  return {
    server, service, data,
    async close() {
      closed = true;
      clearInterval(timer);
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await queue?.close();
      while (scheduling) await new Promise((resolve) => setTimeout(resolve, 25));
      await Promise.allSettled(active.values());
      data.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await start();
  console.log(`Spool listening on ${app.server.address().address}:${app.server.address().port}`);
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => void app.close());
}
