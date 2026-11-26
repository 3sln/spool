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

test("CLI and MCP expose Taskfile semantics, schemas, and the same runnable example", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const { prepareTaskFile } = await import("../client/taskfile.mjs");
  const { capabilities } = await import("../src/contract.mjs");
  const run = (args, input) => {
    const child = spawnSync(process.execPath, ["bin/mcp.mjs", ...args], {
      input, encoding: "utf8",
      env: { ...process.env, SPOOL_WORKSPACE_ROOT: "", SPOOL_BLOB_DIR: "", SPOOL_PROFILE: "", SPOOL_URL: "" },
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };

  for (const [command, expected] of [
    [["serve"], /MCP JSON-RPC on stdin\/stdout/],
    [["run"], /--source-root PATH/],
    [["init"], /\.cursor\/mcp\.json/],
    [["auth"], /Profiles bind credentials/],
    [["auth", "login"], /--token-stdin/],
    [["auth", "list"], /known expiry/],
    [["auth", "logout"], /Remove the local credentials/],
    [["cache-gc"], /unexpired workspace lease/],
    [["taskfile"], /runnable example/],
    [["taskfile", "example"], /map of relative filenames/],
  ]) assert.match(run([...command, "--help"]), expected);
  assert.equal(run(["help", "auth", "login"]), run(["auth", "login", "--help"]));
  assert.match(run(["taskfile"]), /Inheritance and requirements/);
  const example = JSON.parse(run(["taskfile", "example"]));
  const schemas = JSON.parse(run(["taskfile", "schema"]));
  assert.ok(schemas["taskfile.schema.json"].$defs.layer);
  assert.ok(schemas["manifest.schema.json"].$defs.workspacePath);
  assert.equal(schemas["taskfile.schema.json"].properties.outputs.$ref,
    schemas["manifest.schema.json"].$id + "#/properties/outputs");

  const requests = [
    ["initialize", { protocolVersion: "2025-11-25" }],
    ["server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }],
    ["tools/list", {}],
    ["tools/call", { name: "taskfile_help", arguments: { topic: "example" } }],
    ["resources/list", {}],
    ["resources/read", { uri: "spool://taskfile/guide" }],
    ["resources/read", { uri: "spool://taskfile/taskfile.schema.json" }],
    ["resources/read", { uri: "file:///etc/passwd" }],
  ];
  const input = requests.map(([method, params], id) => JSON.stringify({ jsonrpc: "2.0", id, method, params })).join("\n") + "\n";
  const replies = new Map(run(["serve", "--state-mode", "isolated"], input).trim().split("\n").map((line) => {
    const reply = JSON.parse(line);
    return [reply.id, reply];
  }));
  assert.deepEqual(replies.get(0).result.capabilities.resources, {});
  assert.match(replies.get(0).result.instructions, /taskfile_help/);
  assert.deepEqual(replies.get(1).result.capabilities.resources, {});
  assert.ok(replies.get(2).result.tools.some(({ name }) => name === "taskfile_help"));
  assert.deepEqual(replies.get(3).result.structuredContent.files, example);
  assert.equal(replies.get(4).result.resources.length, 4);
  assert.match(replies.get(5).result.contents[0].text, /task_timeout_s/);
  assert.deepEqual(JSON.parse(replies.get(6).result.contents[0].text), schemas["taskfile.schema.json"]);
  assert.equal(replies.get(7).error.code, -32002);

  const project = await mkdtemp(join(tmpdir(), "spool-example-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, "input"));
  for (const [path, contents] of Object.entries(example)) await writeFile(join(project, path), contents);
  const cache = await openLayerCache(join(project, "cache"));
  const info = capabilities("test", {});
  const { manifest, layers } = await prepareTaskFile(join(project, "Taskfile.json"), { cache, runner: info });
  assert.equal(manifest.task_timeout_s, 180);
  assert.equal(layers[0].id, "input");
  assert.deepEqual(manifest.outputs.paths, ["/workspace/result.txt"]);
});
