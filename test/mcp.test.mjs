import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLayerCache } from "../client/node.mjs";

test("stdio MCP initializes and builds OCI layers into the client-owned cache", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "spool-mcp-project-"));
  const outside = await mkdtemp(join(tmpdir(), "spool-mcp-other-"));
  t.after(() => Promise.all([workspace, outside].map((path) => rm(path, { recursive: true, force: true }))));
  await writeFile(join(workspace, "message.txt"), "hello");
  await symlink(outside, join(workspace, "escaped"));
  const cachePath = join(outside, "cache");
  const child = spawn(process.execPath, ["bin/mcp.mjs"], {
    env: { ...process.env, SPOOL_WORKSPACE_ROOT: workspace, SPOOL_BLOB_DIR: cachePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const commands = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "build_layer", arguments: { directory: "escaped" } } },
  ];
  for (const command of commands) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...command }) + "\n");
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`MCP exited with ${code}`)));
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end();
  await completed;
  const replies = Object.fromEntries(output.trim().split("\n").map((line) => {
    const reply = JSON.parse(line);
    return [reply.id, reply.result];
  }));
  assert.equal(replies[1].protocolVersion, "2025-11-25");
  assert.ok(replies[2].tools.some(({ name }) => name === "build_layer"));
  assert.equal(replies[3].isError, true);
  assert.match(replies[3].content[0].text, /outside SPOOL_WORKSPACE_ROOT/);
  await rm(join(workspace, "escaped"));
  const cache = await openLayerCache(cachePath);
  assert.deepEqual(await cache.list(), []);
  const built = await new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["bin/mcp.mjs"], {
      env: { ...process.env, SPOOL_WORKSPACE_ROOT: workspace, SPOOL_BLOB_DIR: cachePath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let result = "";
    processChild.stdout.on("data", (chunk) => { result += chunk; });
    processChild.on("error", reject);
    processChild.on("close", (code) => code === 0 ? resolve(JSON.parse(result)) : reject(new Error(`MCP exited with ${code}`)));
    processChild.stdin.end(JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "build_layer", arguments: { directory: "." } },
    }) + "\n");
  });
  const descriptor = built.result.structuredContent;
  assert.deepEqual(await cache.list(), [descriptor.digest]);
  assert.equal((await cache.source(descriptor)).length, descriptor.size);
});

test("init preserves unrelated servers and supports shared, custom and isolated state", async (t) => {
  const { cliState, initializeCli, parseCli } = await import("../bin/mcp-config.mjs");
  const root = await mkdtemp(join(tmpdir(), "spool-mcp-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, ".cursor", "mcp.json");
  const context = { config, runner: "https://runner.example", client: "cursor" };
  const dry = await initializeCli({ ...context, "dry-run": true });
  assert.equal(dry.entry.command, "spool-mcp");
  assert.equal((await initializeCli(context)).changed, true);
  assert.equal((await initializeCli(context)).changed, false);
  await initializeCli({ ...context, name: "secondary", runner: "https://another.example" });
  await assert.rejects(initializeCli({ ...context, runner: "https://other.example" }), /already exists/);
  await initializeCli({ ...context, force: true, "state-mode": "isolated" });
  const { readFile, stat } = await import("node:fs/promises");
  const installed = JSON.parse(await readFile(config, "utf8"));
  assert.ok(installed.mcpServers.secondary);
  assert.ok(installed.mcpServers.spool.args.includes("isolated"));
  assert.throws(() => parseCli(["init", "--runner", "https://user:secret@example.com"]), /origin/);

  const shared1 = await cliState({}, { XDG_STATE_HOME: root });
  const shared2 = await cliState({}, { XDG_STATE_HOME: root });
  const first = await openLayerCache(shared1.blobs);
  const second = await openLayerCache(shared2.blobs);
  const layer = await first.put(Uint8Array.of(1, 2, 3));
  assert.deepEqual([...await second.source(layer)], [1, 2, 3]);
  const custom = await cliState({ "state-dir": join(root, "custom") }, {});
  assert.notEqual(custom.blobs, shared1.blobs);
  const isolated = await cliState({ "state-mode": "isolated" }, {});
  const isolatedCache = await openLayerCache(isolated.blobs);
  assert.deepEqual(await isolatedCache.list(), []);
  await isolated.close();
  await assert.rejects(stat(isolated.blobs), { code: "ENOENT" });
});
