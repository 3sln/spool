import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLayer, createClient } from "../client/index.mjs";
import { openLayerCache } from "../client/node.mjs";

const headers = {};
if (process.env.SPOOL_TOKEN) headers.authorization = `Bearer ${process.env.SPOOL_TOKEN}`;
if (process.env.SPOOL_ACCESS_CLIENT_ID && process.env.SPOOL_ACCESS_CLIENT_SECRET) {
  headers["CF-Access-Client-Id"] = process.env.SPOOL_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.SPOOL_ACCESS_CLIENT_SECRET;
}
const directory = await mkdtemp(join(tmpdir(), "spool-smoke-"));
try {
  const cache = await openLayerCache(directory);
  const origins = (process.env.SPOOL_TRANSFER_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const client = createClient({ url: process.env.SPOOL_URL ?? "http://127.0.0.1:8787", headers,
    layerSource: cache.open, ...(origins.length && { allowTransferURL: (url) => origins.includes(url.origin) }) });
  const signal = AbortSignal.timeout(150_000);
  const message = `Spool smoke ${crypto.randomUUID()}\n`;
  const descriptor = await cache.put(buildLayer([{
    kind: "file", path: "message.txt", bytes: new TextEncoder().encode(message),
  }]));
  const info = await client.capabilities({ signal });
  const manifest = {
    protocol_version: "0.1", task_timeout_s: 180, client_request_id: crypto.randomUUID(), platform: { os: "linux", arch: "amd64" },
    environment: { base: info.bases[0], layers: [descriptor] },
    command: { argv: ["sh", "-c", "cat message.txt && cp message.txt result.txt"], cwd: "/workspace" },
    resources: { ...info.resource_profile, timeout_s: 10 },
    network: { mode: "none" }, outputs: { paths: ["/workspace/result.txt"] },
  };
  const job = await client.submit(manifest, { signal });
  assert.equal(job.state, "WAITING_FOR_LAYER");
  const settled = await client.wait(job.task_id, { signal });
  assert.equal(settled.state, "SUCCEEDED", JSON.stringify(settled));
  const replay = [];
  for await (const event of client.events(job.task_id, { cursor: 1, signal })) replay.push(event.type);
  assert.ok(replay.includes("task.stdout"));
  assert.equal(replay.at(-1), "task.completed");
  const { artifacts } = await client.artifacts(job.task_id, { signal });
  assert.equal(await (await client.download(artifacts[0], { signal })).text(), message);
  console.log(`Spool smoke passed for ${job.task_id}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
