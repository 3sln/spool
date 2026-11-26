import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, layerDescriptor } from "../client/index.mjs";
import { BASE, Fault, createRunnerCore, sha256 } from "../src/core.mjs";

function fixture() {
  const state = new Map();
  const blobs = new Map();
  const outputs = new Map();
  const stopped = [];
  const execution = { network: "custom-offline", cpu: "custom-quota", memory: "custom-quota", disk: "custom-quota" };
  const runner = createRunnerCore({
    auth: {
      profile: "custom-fixture",
      authenticate(request) {
        if (request.headers.get("authorization") !== "Bearer fixture") throw new Fault("UNAUTHORIZED", "No authentication", 401);
        return { issuer: "fixture", subject: "caller" };
      },
    },
    execution,
    store: {
      get: (key) => structuredClone(state.get(key)),
      list: (prefix) => structuredClone([...state].filter(([key]) => key.startsWith(prefix))),
      commit(entries, removes = []) {
        for (const [key, value] of Object.entries(structuredClone(entries))) state.set(key, value);
        for (const key of removes) state.delete(key);
      },
    },
    layers: {
      has: (key) => blobs.has(key),
      get: (key) => blobs.get(key),
      put: (key, bytes) => blobs.set(key, bytes),
      delete: (key) => blobs.delete(key),
    },
    artifacts: {
      open: (key) => outputs.get(key),
      delete: (key) => outputs.delete(key),
      async putVerified(key, request, descriptor) {
        const bytes = new Uint8Array(await new Response(request.body).arrayBuffer());
        assert.equal(bytes.length, descriptor.size);
        assert.equal(await sha256(bytes), descriptor.digest);
        outputs.set(key, bytes);
      },
    },
    limits: { max_logs_bytes: 4, history_ttl_seconds: 600, max_active_tasks_per_tenant: 1 },
    stop: (id, claim) => stopped.push({ id, claim }),
  });
  const client = createClient({ url: "https://custom.test", headers: { authorization: "Bearer fixture" },
    fetch: (url, options) => runner.fetch(new Request(url, options)) });
  return { ...runner, client, stopped, execution };
}

function manifest(requestId, layers = []) {
  return {
    protocol_version: "0.1", task_timeout_s: 60, client_request_id: requestId,
    platform: { os: "linux", arch: "amd64" }, environment: { base: BASE, layers },
    command: { argv: ["unused"], cwd: "/workspace" }, resources: { cpu: 1, memory_mib: 256, disk_mib: 4096 },
    network: { mode: "none" }, outputs: { paths: ["/workspace/result"] },
  };
}

test("the core uses custom persistence, content, execution and discovery providers", async () => {
  const { client, fetch, service, execution } = fixture();
  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.resource_enforcement, execution);
  assert.equal(capabilities.logs.retention_s, 600);
  assert.equal(capabilities.limits.max_logs_bytes, 4);
  assert.equal((await fetch(new Request("https://custom.test/v1/auth/check"))).status, 401);

  const input = Uint8Array.of(1, 2, 3);
  const layer = await layerDescriptor(input);
  const { task_id, required, upload_plans } = await client.submit(manifest("custom", [layer]));
  await assert.rejects(client.submit(manifest("tenant-limit")), { status: 429 });
  await client.supply(task_id, required, { source: () => input, plans: upload_plans });
  assert.deepEqual((await service.sweep()).map(({ id }) => id), [task_id]);

  const result = new TextEncoder().encode("custom artifact");
  await service.run(task_id, async (work, signal, id, log, read, stage) => {
    assert.equal(signal.aborted, false);
    assert.equal(id, task_id);
    if (work.manifest.environment.layers.length !== 1) throw new Error("Missing manifest layer");
    assert.deepEqual(await read(0), input);
    await log({ channel: "stdout", text: "abcdefgh" });
    await stage({ path: "/workspace/result", digest: await sha256(result), size: result.length }, new Blob([result]).stream());
    return { exit_code: 0 };
  });
  assert.equal((await client.status(task_id)).state, "SUCCEEDED");
  const { events } = await client.eventPage(task_id, { limit: 100 });
  assert.equal(events.find(({ type }) => type === "task.stdout").data.text, "abcd");
  const { artifacts } = await client.artifacts(task_id);
  assert.equal(await (await client.download(artifacts[0])).text(), "custom artifact");
});

test("a custom scheduler has one claim and rejects writes after cancellation", async () => {
  const { client, service, stopped } = fixture();
  const { task_id } = await client.submit(manifest("ownership"));
  const [{ epoch }] = await service.sweep();
  assert.equal(await service.claim(task_id, "stale-epoch"), null);
  const attempts = await Promise.all([service.claim(task_id, epoch), service.claim(task_id, epoch)]);
  const [work] = attempts.filter(Boolean);
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(await service.liveClaim(task_id, work.claim), true);
  assert.equal((await client.cancel(task_id)).state, "CANCELLED");
  assert.deepEqual(stopped, [{ id: task_id, claim: work.claim }]);
  assert.equal(await service.liveClaim(task_id, work.claim), false);
  assert.equal(await service.log(task_id, work.claim, { channel: "stdout", text: "late" }), false);
  assert.equal(await service.finish(task_id, work.claim, { exit_code: 0 }), false);
});
