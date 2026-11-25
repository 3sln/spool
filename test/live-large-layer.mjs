import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, TAR } from "../client/index.mjs";
import { openLayerCache } from "../client/node.mjs";
import { engineCommand } from "../src/oci.mjs";
import { start } from "../src/node.mjs";

const directory = await mkdtemp(join(tmpdir(), "spool-large-layer-"));
const token = crypto.randomUUID();
const size = 48 * 1024 ** 2;
const signal = AbortSignal.timeout(180_000);
let runner;
try {
  const payload = join(directory, "training.dat");
  const data = await open(payload, "wx");
  try { await data.truncate(size); } finally { await data.close(); }
  const raw = join(directory, "training.tar");
  await engineCommand("tar", ["--format=ustar", "-cf", raw, "-C", directory, "training.dat"], { timeout: 60_000 });
  const cache = await openLayerCache(join(directory, "cache"));
  const descriptor = await cache.importFile(raw, TAR);
  assert.ok(descriptor.size > size);
  runner = await start({ SPOOL_TOKEN: token, SPOOL_DB: ":memory:", SPOOL_WORKSPACE_MIB: "256", PORT: "0",
    SPOOL_OCI_ENGINE: process.env.SPOOL_OCI_ENGINE, SPOOL_OCI_IMAGE: process.env.SPOOL_OCI_IMAGE });
  const client = createClient({
    url: `http://127.0.0.1:${runner.server.address().port}`,
    headers: { Authorization: `Bearer ${token}` }, layerSource: cache.open,
  });
  const info = await client.capabilities({ signal });
  const manifest = {
    protocol_version: "0.1", client_request_id: crypto.randomUUID(), task_timeout_s: 180,
    platform: { os: "linux", arch: "amd64" },
    environment: { base: info.bases[0], layers: [descriptor] },
    command: { argv: ["sh", "-ec", "stat -c %s training.dat > result"], cwd: "/workspace" },
    resources: info.resource_profile, network: { mode: "none" }, outputs: { paths: ["/workspace/result"] },
  };
  await assert.rejects(client.submit({ ...manifest, environment: { ...manifest.environment,
    layers: [{ ...descriptor, size: info.limits.max_layer_bytes + 1 }] } }, { signal }), { status: 413 });
  const task = await client.submit(manifest, { signal });
  assert.equal(task.upload_plans[descriptor.digest].type, "http-put");
  assert.equal(task.upload_plans[descriptor.digest].max_size, descriptor.size);
  const result = await client.wait(task.task_id, { signal });
  assert.equal(result.state, "SUCCEEDED", JSON.stringify(result));
  const { artifacts } = await client.artifacts(task.task_id, { signal });
  assert.equal((await (await client.download(artifacts[0], { signal })).text()).trim(), String(size));
  console.log(`Streamed ${descriptor.size} bytes from disk cache into the offline OCI guest`);
} finally {
  await runner?.close();
  await rm(directory, { recursive: true, force: true });
}
