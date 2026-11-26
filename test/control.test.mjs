import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { nodeHandler } from "../src/node.mjs";
import { buildLayer, createClient } from "../client/index.mjs";
import { buildDirectoryLayer, openLayerCache } from "../client/node.mjs";
import { prepareTaskFile, runTaskFile } from "../client/taskfile.mjs";
import { configuredAuth, jwtVerifier, staticToken, tenantFor } from "../src/auth.mjs";
import { BASE, configuredLimits, Fault, MEDIA, sha256 } from "../src/contract.mjs";
import { TaskService } from "../src/service.mjs";
import { openData } from "../src/sqlite.mjs";

const auth = {
  profile: "fixture",
  async authenticate(request) {
    const subject = request.headers.get("x-fixture-user");
    if (!subject) throw new Fault("UNAUTHORIZED", "Authentication required", 401);
    return { issuer: "test", subject };
  },
};

// The host test guest shares the CI account's process limit. The OCI tests
// exercise commands that spawn subprocesses inside a dedicated sandbox.
const readValue = 'IFS= read -r value < value.txt || test -n "$value"';
const writeResult = 'printf %s "$value" > result.txt';

async function assertSucceeded(result, events) {
  if (result.state === "SUCCEEDED") return;
  assert.equal(result.state, "SUCCEEDED", JSON.stringify({ result: result.result, events: await events() }));
}

function request(handler, path, { user = "alice", method = "GET", body, headers = {} } = {}) {
  return handler(new Request(`https://spool.test${path}`, {
    method, headers: { ...(user ? { "x-fixture-user": user } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body),
  }));
}

function manifest(client_request_id, layers = []) {
  return {
    protocol_version: "0.1", task_timeout_s: 180, client_request_id, platform: { os: "linux", arch: "amd64" },
    environment: { base: BASE, layers },
    command: { argv: ["sh", "-ec", `${readValue}; printf %s "$value"; ${writeResult}`], cwd: "/workspace" },
    resources: { cpu: 1, memory_mib: 256, disk_mib: 4096, timeout_s: 3 }, network: { mode: "none" },
    outputs: { paths: ["/workspace/result.txt"] },
  };
}

async function fixtureLayer(entries, compressed = false) {
  const encoder = new TextEncoder();
  const tar = buildLayer(entries.map(([path, text]) => path.startsWith(".wh.")
    ? { kind: "delete", path: path.slice(4) }
    : { kind: "file", path: path.replace(/^\.\.\//u, "xx/"), bytes: encoder.encode(text) }));
  if (entries[0][0].startsWith("../")) {
    const header = tar.subarray(0, 512);
    header.set(encoder.encode(entries[0][0]));
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
    header.set(encoder.encode(checksum + "\0 "), 148);
  }
  const raw = compressed ? gzipSync(tar) : tar;
  return { raw, descriptor: { digest: await sha256(raw), size: raw.length, media_type: MEDIA[Number(compressed)] } };
}

async function runGuest(work, _signal, _id, _log, readLayer) {
  const directory = await mkdtemp(join(tmpdir(), "spool-guest-"));
  const binary = process.env.SPOOL_GUEST_BIN ?? resolve("guest/target/debug/spool-guest");
  try {
    const layers = [];
    for (const [index] of work.manifest.environment.layers.entries()) {
      layers.push(Buffer.from(await readLayer(index)).toString("base64"));
    }
    return await new Promise((resolve, reject) => {
      const child = execFile(binary, ["stdio", "--workspace", directory],
        { maxBuffer: 2 * 1024 ** 2 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(JSON.parse(stdout));
        });
      child.stdin.end(JSON.stringify({ ...work, layers }));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function submit(handler, value, user) {
  const response = await request(handler, "/v1/tasks", { method: "POST", body: value, user });
  assert.equal(response.status, 202);
  return response.json();
}

async function upload(handler, job, layer, user) {
  const path = `${job.links.self}/layers/${layer.descriptor.digest}/upload`;
  const offer = await request(handler, path, { method: "POST", user });
  assert.equal(offer.status, 200);
  const { url } = await offer.json();
  assert.equal((await request(handler, url, { method: "PUT", user: "other", body: layer.raw })).status, 404);
  assert.equal((await request(handler, url, { method: "PUT", user, body: new Uint8Array(layer.raw.length) })).status, 422);
  const response = await request(handler, url, { method: "PUT", user, body: layer.raw });
  assert.equal(response.status, 200);
  return response.json();
}

test("lazy layers, idempotency, tenant isolation, replay, artifacts and cache eviction over the public binding", async (t) => {
  const data = openData(":memory:");
  t.after(() => data.close());
  const service = new TaskService(data.store, data.blobs);
  const handler = nodeHandler(service, auth);
  const lower = await fixtureLayer([["value.txt", "hello"], ["obsolete.txt", "remove me"]]);
  const upper = await fixtureLayer([[".wh.obsolete.txt", ""], ["value.txt", "hello from Spool"]], true);
  const spec = manifest("initial", [lower.descriptor, upper.descriptor]);
  spec.command.argv[2] = `test ! -e obsolete.txt; ${spec.command.argv[2]}`;
  const initial = await submit(handler, spec);
  const duplicate = await submit(handler, spec);
  assert.equal(initial.task_id, duplicate.task_id);
  assert.equal(initial.state, "WAITING_FOR_LAYER");
  assert.deepEqual(initial.required, [lower.descriptor, upper.descriptor]);

  const conflict = structuredClone(spec);
  conflict.command.argv = ["true"];
  assert.equal((await request(handler, "/v1/tasks", { method: "POST", body: conflict })).status, 409);
  assert.equal((await request(handler, initial.links.self, { user: null })).status, 401);
  assert.equal((await request(handler, "/v1/auth/check", { user: null })).status, 401);
  assert.equal((await request(handler, "/v1/auth/check")).status, 204);
  assert.equal((await request(handler, initial.links.self, { user: "bob" })).status, 404);
  assert.notEqual((await submit(handler, spec, "bob")).task_id, initial.task_id);

  const firstStream = await request(handler, initial.links.events);
  const reader = firstStream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /task.accepted/);
  await reader.cancel();

  assert.equal((await upload(handler, initial, lower)).state, "WAITING_FOR_LAYER");
  assert.equal((await upload(handler, initial, upper)).state, "QUEUED");
  assert.equal((await upload(handler, initial, upper)).state, "QUEUED");
  await service.run(initial.task_id, runGuest);

  const terminal = await (await request(handler, initial.links.self)).json();
  await assertSucceeded(terminal, async () => (await (await request(handler, `${initial.links.events}?limit=100`)).json()).events);
  assert.equal(terminal.result.exit_code, 0);
  const replay = await (await request(handler, initial.links.events, { headers: { "last-event-id": "1" } })).text();
  assert.doesNotMatch(replay, /task.accepted/);
  assert.match(replay, /layer.required/);
  assert.match(replay, /task.stdout[\s\S]*hello from Spool/);
  assert.match(replay, /task.completed/);
  assert.deepEqual([...replay.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    Array.from({ length: terminal.cursor - 1 }, (_, i) => i + 2));

  const { artifacts } = await (await request(handler, initial.links.artifacts)).json();
  assert.equal(artifacts.length, 1);
  const artifact = await request(handler, artifacts[0].url);
  assert.equal(await artifact.text(), "hello from Spool");
  assert.equal(await sha256("hello from Spool"), artifacts[0].digest);

  const warm = await submit(handler, { ...spec, client_request_id: "cached" });
  assert.equal(warm.state, "QUEUED");
  const tenant = await tenantFor(auth, new Request("https://spool.test", { headers: { "x-fixture-user": "alice" } }));
  data.blobs.delete(`${tenant}/${lower.descriptor.digest}`);
  await service.run(warm.task_id, () => assert.fail("must wait for the evicted layer"));
  const waiting = await (await request(handler, warm.links.self)).json();
  assert.deepEqual(waiting.required, [lower.descriptor]);
});

test("rejects invalid archives and finalizes a timed-out command", async (t) => {
  const data = openData(":memory:");
  t.after(() => data.close());
  const service = new TaskService(data.store, data.blobs);
  const handler = nodeHandler(service, auth);
  const invalid = await fixtureLayer([["../invalid.txt", "rejected"]]);
  const badJob = await submit(handler, manifest("invalid", [invalid.descriptor]));
  await upload(handler, badJob, invalid);
  await service.run(badJob.task_id, runGuest);
  assert.equal((await service.status(await tenantFor(auth, new Request("https://spool.test", {
    headers: { "x-fixture-user": "alice" },
  })), badJob.task_id)).result.error, "LAYER_INVALID");
  const slow = manifest("slow");
  slow.command.argv = ["sleep", "5"];
  slow.resources.timeout_s = 1;
  const timed = await submit(handler, slow);
  await service.run(timed.task_id, runGuest);
  assert.equal((await (await request(handler, timed.links.self)).json()).state, "EXPIRED");
});

test("fences competing agents and discards a late result after cancellation", async (t) => {
  const data = openData(":memory:");
  t.after(() => data.close());
  const service = new TaskService(data.store, data.blobs);
  const token = "agent-token-for-fixtures-only";
  const handler = nodeHandler(service, auth, { workerAuth: staticToken(token) });
  const job = await submit(handler, manifest("cluster"));
  const [{ epoch }] = await service.sweep();
  const headers = { authorization: `Bearer ${token}` };
  const base = `/internal/${job.task_id}`;
  const claim = (value) => request(handler, `${base}/claim`, { method: "POST", headers, body: { epoch: value } });
  assert.equal((await claim("stale")).status, 204);
  const attempts = await Promise.all([claim(epoch), claim(epoch)]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 204]);
  const { claim: lease } = await attempts.find(({ status }) => status === 200).json();
  const cancelled = await request(handler, `${job.links.self}/cancel`, { method: "POST" });
  assert.equal((await cancelled.json()).state, "CANCELLED");
  const finish = await request(handler, `${base}/finish`, { method: "POST", headers, body: { claim: lease, result: { exit_code: 0 } } });
  assert.deepEqual(await finish.json(), { accepted: false });
});

test("client builds a workspace delta, caches its bytes, supplies layers and consumes artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spool-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = openData(":memory:");
  t.after(() => data.close());
  const service = new TaskService(data.store, data.blobs);
  const handler = nodeHandler(service, auth);
  const transport = (target, options) => handler(new Request(target, options));
  const before = join(directory, "before");
  const after = join(directory, "after");
  await Promise.all([mkdir(before), mkdir(after)]);
  await Promise.all([
    writeFile(join(before, "obsolete.txt"), "old"),
    writeFile(join(before, "value.txt"), "before"),
    writeFile(join(after, "value.txt"), "after"),
  ]);
  const cache = await openLayerCache(join(directory, "cache"));
  const lower = await cache.put(await buildDirectoryLayer(before));
  const upper = await cache.put(await buildDirectoryLayer(after, { previous: before }));
  assert.deepEqual(await cache.put(await buildDirectoryLayer(after, { previous: before })), upper);
  const reopened = await openLayerCache(join(directory, "cache"));
  assert.deepEqual(await reopened.list(), [lower.digest, upper.digest].sort());
  const requested = [];
  const client = createClient({
    url: "https://spool.test", fetch: transport, headers: { "x-fixture-user": "alice" },
    layerSource: (descriptor, options) => {
      requested.push(descriptor.digest);
      return reopened.source(descriptor, options);
    },
  });
  const spec = manifest("client", [lower, upper]);
  spec.command.argv[2] = `test ! -e obsolete.txt; ${readValue}; ${writeResult}`;
  const task = await client.submit(spec);
  const timer = setInterval(() => { void service.run(task.task_id, runGuest); }, 20);
  t.after(() => clearInterval(timer));
  const finished = await client.wait(task.task_id, { pollMs: 20, signal: AbortSignal.timeout(5000) });
  await assertSucceeded(finished, async () => (await client.eventPage(task.task_id)).events);
  assert.deepEqual(requested, [lower.digest, upper.digest]);
  const { artifacts } = await client.artifacts(task.task_id);
  assert.equal(await (await client.download(artifacts[0])).text(), "after");
  const events = [];
  for await (const event of client.events(task.task_id, { cursor: 1 })) events.push(event.type);
  assert.ok(events.includes("layer.required"));
  assert.equal(events.at(-1), "task.completed");
  assert.equal((await request(handler, "/mcp", { method: "POST", body: {} })).status, 404);
  assert.equal((await request(handler, "/v1/tasks", { method: "POST", body: spec,
    headers: { origin: "https://other.invalid" } })).status, 403);
});

test("client resumes SSE after a dropped connection, suppressing duplicates", async () => {
  const job = "replay-job";
  const seen = [];
  const frame = (sequence, type) => `id: ${sequence}\r\ndata: ${JSON.stringify({ job_id: job, sequence, type })}\r\n\r\n`;
  const transport = (_url, { headers }) => {
    seen.push(headers.get("last-event-id"));
    const content = seen.length === 1 ? frame(1, "task.accepted") : frame(1, "task.accepted") + frame(2, "task.completed");
    const chunks = new TextEncoder().encode(content);
    return headers.has("last-event-id") ? new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < chunks.length; index += 7) controller.enqueue(chunks.slice(index, index + 7));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }) : Response.json({ state: "RUNNING", cursor: 1 });
  };
  const client = createClient({ url: "https://spool.test", fetch: transport });
  const observed = [];
  for await (const event of client.events(job, { reconnectMs: 1 })) observed.push(event.sequence);
  assert.deepEqual(observed, [1, 2]);
  assert.deepEqual(seen, ["0", null, "1"]);
  await assert.rejects(client.download({ url: "https://elsewhere.test/artifact" }), { code: "UNTRUSTED_URL" });
});

test("JWT verifies a signed issuer, audience and time window and OAuth advertises resource metadata", async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const key = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key" };
  const issuer = "https://issuer.example.com";
  const audience = "https://spool.example.com/mcp";
  const verify = jwtVerifier({
    issuer, audience, jwksURL: `${issuer}/keys`, fetcher: async () => Response.json({ keys: [key] }),
  });
  const encode = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const expires = Date.now() / 1000 + 60;
  const signed = async (overrides = {}) => {
    const value = `${encode({ alg: "RS256", kid: key.kid })}.${encode({ iss: issuer, aud: audience, sub: "alice", exp: expires, ...overrides })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, Buffer.from(value));
    return `${value}.${Buffer.from(signature).toString("base64url")}`;
  };
  assert.equal((await verify(await signed())).sub, "alice");
  for (const claims of [{ aud: "other" }, { exp: expires - 120 }, { nbf: expires }, { iss: "https://other.example.com" }]) {
    await assert.rejects(verify(await signed(claims)), { status: 401 });
  }
  const oauth = configuredAuth({
    SPOOL_AUTH: "oauth", SPOOL_ISSUER: issuer, SPOOL_PUBLIC_URL: audience, SPOOL_AUDIENCE: audience,
    SPOOL_JWKS_URL: `${issuer}/keys`,
  });
  assert.equal(oauth.metadata.resource, new URL(audience).origin);
  assert.ok(oauth.challenge.includes("oauth-protected-resource"));
});

test("Taskfiles resolve inherited recipes and runner requirements before uploading only misses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spool-taskfile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "source");
  await mkdir(fixture);
  await writeFile(join(fixture, "value.txt"), "reusable layer");
  const write = (path, contents) => writeFile(join(root, path), JSON.stringify({ version: "0.1", ...contents }));
  await write("base.json", {
    kind: "base", task_timeout_s: 60,
    requires: { platform: "linux/amd64", base: BASE.id, features: ["lazy-layers"], resources: { memory_mib: 256 } },
    layers: [{ id: "source", kind: "directory", path: "source" }],
    command: { cwd: "/workspace" },
  });
  await write("child.json", { kind: "base", extends: ["base.json"], resources: { timeout_s: 3 } });
  const taskfile = join(root, "task.json");
  await write("task.json", {
    kind: "task", extends: ["base.json", "child.json"],
    command: { argv: ["sh", "-ec", `${readValue}; ${writeResult}`] },
    requires: { limits: { max_layers: 1 }, resources: { cpu: 1, memory_mib: 128 } },
    outputs: { paths: ["/workspace/result.txt"] },
  });
  const cache = await openLayerCache(join(root, "cache"));
  const data = openData(":memory:");
  t.after(() => data.close());
  const service = new TaskService(data.store, data.blobs);
  const handler = nodeHandler(service, auth);
  let retries = 0;
  let uploads = 0;
  const client = createClient({
    url: "https://spool.test", headers: { "x-fixture-user": "alice" },
    async fetch(url, options) {
      const res = await handler(new Request(url, options));
      if (url.pathname === "/v1/tasks" && options.method === "POST" && retries++ === 0) {
        await res.body.cancel();
        throw new TypeError("Simulated connection loss after committing the task");
      }
      if (options.method === "PUT") uploads++;
      return res;
    },
  });
  const mismatched = { ...await client.capabilities(), features: [] };
  await assert.rejects(prepareTaskFile(taskfile, { runner: mismatched, cache }), /missing the required feature/);
  const undersized = { ...await client.capabilities(), resource_profiles: [{ cpu: 1, memory_mib: 128, disk_mib: 4096 }] };
  await assert.rejects(prepareTaskFile(taskfile, { runner: undersized, cache }), /satisfies requires.resources/);
  assert.deepEqual(await cache.list(), []);
  let active;
  const interval = setInterval(() => { if (active) void service.run(active.task_id, runGuest); }, 20);
  t.after(() => clearInterval(interval));

  const signal = AbortSignal.timeout(6000);
  const first = await runTaskFile(taskfile, { client, cache, requestId: "template-first", signal, onAccepted: (task) => { active = task; } });
  await assertSucceeded(first.task, async () => (await client.eventPage(first.task.task_id)).events);
  assert.equal(first.layers.length, 1);
  assert.equal(first.layers[0].id, "source");
  assert.equal(first.manifest.resources.timeout_s, 3);
  assert.deepEqual(first.manifest.min_resources, { cpu: 1, memory_mib: 256 });
  assert.equal(first.task.resource_profile.name, "fixed");
  assert.equal(uploads, 1);
  const second = await runTaskFile(taskfile, { client, cache, requestId: "template-second", signal, onAccepted: (task) => { active = task; } });
  assert.equal(second.task.state, "SUCCEEDED");
  assert.equal(second.layers[0].descriptor.digest, first.layers[0].descriptor.digest);
  assert.equal(uploads, 1);
  const { artifacts } = await client.artifacts(second.task.task_id);
  assert.equal(await (await client.download(artifacts[0])).text(), "reusable layer");

  await write("cycle.json", { kind: "base", extends: ["cycle.json"] });
  await write("task.json", { kind: "task", extends: ["cycle.json"] });
  await assert.rejects(prepareTaskFile(taskfile, { client, cache }), /inheritance cycle/);
});

test("browser preflights permit configured origins without bypassing task authentication", async (t) => {
  const data = openData(":memory:");
  t.after(() => data.close());
  const handler = nodeHandler(new TaskService(data.store, data.blobs), auth, {
    origins: ["https://operator.example"],
  });
  const origin = "https://operator.example";
  const preflight = await request(handler, "/v1/tasks", {
    user: null, method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
  const denied = await request(handler, "/v1/tasks", { user: null, method: "POST", headers: { origin } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("access-control-allow-origin"), origin);
  const foreign = await request(handler, "/v1/tasks", {
    method: "OPTIONS", headers: { origin: "https://foreign.example", "access-control-request-method": "POST" },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.has("access-control-allow-origin"), false);
});

test("a task's submitter chooses its timeout and can extend a running lease after observing live progress", async (t) => {
  const data = openData(":memory:");
  t.after(() => data.close());
  const limits = configuredLimits({ SPOOL_MAX_TASK_SECONDS: "259200" });
  const service = new TaskService(data.store, data.blobs, { limits });
  const handler = nodeHandler(service, auth);
  const client = createClient({
    url: "http://spool.test", headers: { "x-fixture-user": "alice" },
    fetch: (url, options) => handler(new Request(url, options)),
  });
  assert.equal((await client.capabilities()).limits.max_task_seconds, 259200);
  const { task_timeout_s: _, ...missing } = manifest("missing-timeout");
  assert.equal((await request(handler, "/v1/tasks", { method: "POST", body: missing })).status, 400);
  const multiDay = manifest("three-days");
  multiDay.task_timeout_s = 259200;
  multiDay.resources.timeout_s = 200000;
  const long = await client.submit(multiDay);
  assert.equal(Date.parse(long.task_deadline) - Date.parse(long.created_at), 259200000);
  await client.cancel(long.task_id);
  multiDay.task_timeout_s++;
  await assert.rejects(client.submit(multiDay), { code: "RESOURCE_LIMIT" });

  const short = manifest("extend");
  short.task_timeout_s = 2;
  short.resources.timeout_s = 20;
  const job = await client.submit(short);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const running = service.run(job.task_id, async (_work, signal, _id, onLog) => {
    await onLog({ channel: "stdout", text: "checkpoint completed\n" });
    started.resolve();
    await finish.promise;
    assert.equal(signal.aborted, false);
    return { exit_code: 0 };
  });
  t.after(() => finish.resolve());
  await started.promise;
  const page = await client.eventPage(job.task_id);
  assert.equal(page.terminal, false);
  assert.ok(page.events.some(({ type, data }) => type === "task.stdout" && data.text.includes("checkpoint")));
  const updated = await client.extend(job.task_id, 10);
  assert.ok(Date.parse(updated.deadline) > Date.parse(job.deadline));
  await assert.rejects(client.extend(job.task_id, 259201), { code: "RESOURCE_LIMIT" });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal((await client.status(job.task_id)).state, "RUNNING");
  finish.resolve();
  await running;
  const tail = await client.eventPage(job.task_id, { cursor: page.next_cursor });
  assert.equal(tail.terminal, true);
  assert.deepEqual(tail.events.map(({ type }) => type), ["task.deadline_extended", "task.completed"]);
  await assert.rejects(client.extend(job.task_id, 11), { code: "TASK_NOT_RUNNING" });
});

test("deadline expiry fences running claims and aborts the executor without a polling client", { timeout: 5_000 }, async (t) => {
  const data = openData(":memory:");
  t.after(() => data.close());
  const service = new TaskService(data.store, data.blobs);
  const handler = nodeHandler(service, auth);
  const short = manifest("unattended-expiry");
  short.task_timeout_s = 1;
  const task = await submit(handler, short);
  await service.run(task.task_id, async (_work, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return { exit_code: 0 };
  });
  const status = await (await request(handler, task.links.self)).json();
  assert.equal(status.state, "EXPIRED");
  assert.equal(status.result.error, "DEADLINE_EXCEEDED");
});
