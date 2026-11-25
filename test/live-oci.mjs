import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { buildLayer, createClient, layerDescriptor, TAR, TAR_GZIP } from "../client/index.mjs";

const secret = process.env.SPOOL_TOKEN ?? crypto.randomUUID();
let url = process.env.SPOOL_URL;
if (url && !process.env.SPOOL_TOKEN) throw new Error("Set SPOOL_TOKEN for a remote smoke test");
let local;
if (!url) {
  const { start } = await import("../src/node.mjs");
  local = await start({ SPOOL_TOKEN: secret, SPOOL_OCI_IMAGE: process.env.SPOOL_OCI_IMAGE, SPOOL_OCI_ENGINE: process.env.SPOOL_OCI_ENGINE, SPOOL_DB: ":memory:", PORT: "0" });
  url = `http://127.0.0.1:${local.server.address().port}`;
}
const encode = new TextEncoder();
const file = (path, text) => ({ kind: "file", path, bytes: encode.encode(text) });
const nonce = crypto.randomUUID();
const lower = buildLayer([
  file("value.txt", "old\n"), file("obsolete.txt", nonce), file("opaque/old.txt", "hide me"),
  file("unaffected.txt", "preserved\n"),
]);
const upper = gzipSync(buildLayer([
  file("value.txt", `new ${nonce}\n`), { kind: "delete", path: "obsolete.txt" },
  { kind: "opaque", path: "opaque" }, file("opaque/new.txt", "replacement\n"),
]));
const layers = await Promise.all([layerDescriptor(lower, TAR), layerDescriptor(upper, TAR_GZIP)]);
const bytes = new Map([[layers[0].digest, lower], [layers[1].digest, upper]]);
const reads = [];
const client = createClient({
  url, headers: { authorization: `Bearer ${secret}` },
  layerSource: ({ digest }) => { reads.push(digest); return bytes.get(digest); },
});
const signal = AbortSignal.timeout(210000);

try {
  assert.equal((await fetch(new URL("/v1/tasks", url), {method:"POST",body:"{}",signal})).status, 401);
  const capabilities = await client.capabilities({ signal });
  const manifest = {
    protocol_version: "0.1", task_timeout_s: 180, client_request_id: nonce, platform: { os: "linux", arch: "amd64" },
    environment: { base: capabilities.bases[0], layers },
    command: {
      argv: ["sh", "-ec", `test ! -e obsolete.txt
test ! -e opaque/old.txt
${local ? "if grep -q '[[:space:]]00000000[[:space:]]' /proc/net/route; then exit 1; fi; grep -q 'lo:' /proc/net/dev" : ":"}
test ! -e /tmp/spool-probe-reuse-marker
touch /tmp/spool-probe-reuse-marker
cat value.txt unaffected.txt opaque/new.txt > result.txt
cat result.txt
sleep 2
uname -m
id -u`], cwd: "/workspace",
    },
    resources: { ...capabilities.resource_profile, timeout_s: 10 },
    network: { mode: "none" }, outputs: { paths: ["/workspace/result.txt"] },
  };
  for (const iteration of [1, 2]) {
    if (iteration === 2) manifest.client_request_id += "-warm-cache";
    const started = Date.now();
    const submitted = await client.submit(manifest, { signal });
    if (iteration === 1) assert.deepEqual(submitted.required, layers);
    else assert.equal(submitted.required.length, 0);
    console.log(JSON.stringify({ iteration, task_id: submitted.task_id, state: submitted.state, missing: submitted.required.length }));
    const waiting = client.wait(submitted.task_id, { signal });
    const trace = [];
    let sawLiveLog = false;
    for await (const event of client.events(submitted.task_id, { signal })) {
      if (event.type === "task.stdout" && event.data.text.includes("replacement") && !sawLiveLog) {
        sawLiveLog = (await client.status(submitted.task_id, { signal })).state === "RUNNING";
      }
      trace.push(event);
    }
    const task = await waiting;
    assert.equal(task.state, "SUCCEEDED", JSON.stringify({task,trace}));
    assert.equal(sawLiveLog, true, "Command output should be visible during execution");
    const artifacts = (await client.artifacts(task.task_id, { signal })).artifacts;
    assert.equal(artifacts.length, 1);
    const expected = `new ${nonce}\npreserved\nreplacement\n`;
    assert.equal(await (await client.download(artifacts[0], { signal })).text(), expected);
    const stdout = trace.filter((event) => event.type === "task.stdout").map((event) => event.data.text).join("");
    assert.equal(stdout, expected + "x86_64\n65532\n");
    assert.equal(reads.length, 2);
    console.log(JSON.stringify({ iteration, result: task.state, artifact_bytes: artifacts[0].size,
      output_digest: artifacts[0].digest, elapsed_ms: Date.now() - started, stdout,
      events: trace.map((event) => event.type) }));
  }
  if (process.env.SPOOL_TEST_RUST === "1") {
    await new Promise((resolve, reject) => {
      const child = spawn("cargo", ["run", "--locked", "--manifest-path", "sdk/rust/Cargo.toml", "--example", "smoke"], {
        env: { ...process.env, SPOOL_URL: url, SPOOL_TOKEN: secret }, stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", (status) => status === 0 ? resolve() : reject(new Error("Rust SDK smoke failed")));
    });
  }
} finally { await local?.close(); }
