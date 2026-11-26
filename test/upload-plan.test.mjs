import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createClient, layerDescriptor, TAR } from "../client/index.mjs";
import { BASE, LIMITS, createRunnerCore } from "../src/core.mjs";
import { directSingleBytes, directTransfers } from "../src/r2-transfer.mjs";
import { openData } from "../src/sqlite.mjs";

test("artifact plans use a signed GET and keep runner credentials at the runner", async () => {
  const transfers = directTransfers({
    endpoint: "https://store.test", bucket: "layers", region: "auto",
    accessKeyId: "fixture-id", secretAccessKey: "fixture-secret",
  });
  const bytes = new TextEncoder().encode("private output");
  const { digest, size } = await layerDescriptor(bytes, TAR);
  const expires = Date.now() + 60000;
  const signed = await transfers.download("artifacts/tenant/task/claim/0", expires);
  const url = new URL(signed);
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.ok(Number(url.searchParams.get("X-Amz-Expires")) <= 60);
  assert.equal(await transfers.download("artifacts/expired", Date.now()), undefined);
  const artifact = { url: "/artifact", download_plan_url: "/artifact/download", size, digest };
  let calls = [];
  const options = {
    url: "https://runner.test", headers: { authorization: "Bearer fixture-token" },
    async fetch(target, request) {
      calls.push(target.origin);
      if (target.origin === url.origin) {
        assert.equal(target.href, signed);
        assert.equal(request.headers.get("authorization"), null);
        assert.equal(request.method, "GET");
        return new Response(bytes);
      }
      assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
      return target.pathname === artifact.download_plan_url ? Response.json({
        type: "presigned-get", method: "GET", authenticated: false, size, digest, url: signed,
      }) : new Response(bytes);
    },
  };
  const direct = createClient({ ...options, allowTransferURL: (target) => target.origin === url.origin });
  assert.equal(await (await direct.download(artifact)).text(), "private output");
  assert.deepEqual(calls, ["https://runner.test", "https://store.test"]);
  calls = [];
  assert.equal(await (await createClient(options).download(artifact)).text(), "private output");
  assert.deepEqual(calls, ["https://runner.test", "https://runner.test"]);
});

test("direct upload plans scope signed parts and require proof of content before queueing", async (t) => {
  const database = openData(":memory:");
  t.after(() => database.close());
  const storage = new Map();
  const pending = new Map();
  const read = (key) => {
    const bytes = storage.get(key);
    return bytes && { body: new Blob([bytes]).stream(), size: bytes.length, etag: "same-etag" };
  };
  const etag = (bytes) => createHash("md5").update(bytes).digest("hex");
  let created = 0;
  const driver = {
    head: (key) => Boolean(storage.has(key)),
    get: read,
    delete: (key) => storage.delete(key),
    async publishVerified(key) { storage.set(key + "-verified", storage.get(key)); },
    async createMultipartUpload(key) {
      const uploadId = String(++created);
      pending.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        async abort() { pending.delete(uploadId); },
        async complete(parts) {
          const item = pending.get(uploadId);
          assert.equal(item.key, key);
          const bytes = parts.map(({ partNumber, etag: proof }) => {
            const value = item.parts.get(partNumber);
            assert.equal(etag(value), proof);
            return value;
          });
          storage.set(key, Buffer.concat(bytes));
          pending.delete(uploadId);
        },
      };
    },
  };
  const transfers = directTransfers({
    endpoint: "https://fixture.object-store.test", bucket: "layers",
    accessKeyId: "fixture-access-id", secretAccessKey: "fixture-key-unused-outside-this-test",
    region: "auto", driver,
    async hash(stream) {
      const sha = createHash("sha256");
      for await (const part of stream) sha.update(part);
      return sha.digest("hex");
    },
  });
  const { fetch: runner } = createRunnerCore({
    auth: { profile: "fixture", authenticate: async () => ({ issuer: "fixture", subject: "owner" }) },
    execution: { network: "fixture", cpu: "fixture", memory: "fixture", disk: "fixture" },
    store: database.store, transfers,
    layers: { has: driver.head, open: (key) => driver.get(key)?.body, delete: driver.delete },
  });
  let urls = 0;
  const fetch = async (url, options) => {
    if (url.origin !== "https://fixture.object-store.test") return runner(new Request(url, options));
    urls++;
    assert.equal(options.headers.get("authorization"), null);
    assert.equal(options.method, "PUT");
    assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/u);
    assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-length/u);
    const key = url.pathname.split("/").slice(2).map(decodeURIComponent).join("/");
    const bytes = Buffer.from(await options.body.arrayBuffer());
    const upload = pending.get(url.searchParams.get("uploadId"));
    if (upload) {
      assert.equal(upload.key, key);
      upload.parts.set(Number(url.searchParams.get("partNumber")), bytes);
    } else storage.set(key, bytes);
    return new Response(null, { headers: { etag: '"' + etag(bytes) + '"' } });
  };
  const logIn = { url: "https://runner.test", headers: { authorization: "Bearer fixture-token" }, fetch };
  const client = createClient({ ...logIn, allowTransferURL: (url) => url.origin === "https://fixture.object-store.test" });
  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.upload_transports, ["presigned-put", "presigned-multipart"]);
  assert.equal(capabilities.limits.max_artifact_bytes_total, 512 * 1024);
  for (const size of [4050, directSingleBytes + 1]) {
    const bytes = new Blob([new Uint8Array(size)]);
    const descriptor = await layerDescriptor(new Uint8Array(await bytes.arrayBuffer()), TAR);
    const task = await client.submit({
      protocol_version: "0.1", task_timeout_s: 120, client_request_id: String(size),
      platform: { os: "linux", arch: "amd64" }, environment: { base: BASE, layers: [descriptor] },
      command: { argv: ["true"], cwd: "/workspace" }, network: { mode: "none" },
      resources: { cpu: 1, memory_mib: 256, disk_mib: LIMITS.workspace_mib },
    });
    const plan = task.upload_plans[descriptor.digest];
    assert.equal(plan.max_size, size);
    assert.equal(plan.type, size > directSingleBytes ? "presigned-multipart" : "presigned-put");
    await assert.rejects(createClient(logIn).supply(task.task_id, task.required, { source: () => bytes, plans: task.upload_plans }),
      { code: "UNTRUSTED_URL" });
    await client.supply(task.task_id, task.required, { source: () => bytes, plans: task.upload_plans });
    assert.equal((await client.status(task.task_id)).state, "QUEUED");
  }
  assert.equal(created, 1);
  assert.equal(urls, 3);
});
