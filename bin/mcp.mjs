#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import manifestSchema from "../protocol/manifest.schema.json" with { type: "json" };
import { createClient } from "../client/index.mjs";
import { openLayerCache } from "../client/node.mjs";
import { prepareTaskFile } from "../client/taskfile.mjs";
import pkg from "../package.json" with { type: "json" };
import { cliState, initializeCli, parseCli } from "./mcp-config.mjs";
import { authCommand, runnerConnection } from "./mcp-auth.mjs";
import { taskfileHelp, taskfileResources, taskfileTopics } from "./taskfile-help.mjs";

async function serve(options, env) {
  const state = await cliState(options, env);
  const lifecycle = new AbortController();
  const pending = new Map();
  const stop = () => lifecycle.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  const input = process.stdin;
  const closeInput = () => input.destroy();
  lifecycle.signal.addEventListener("abort", closeInput, { once: true });
  let cache;
  try {
    const workspacePathOption = options.workspace ?? env.SPOOL_WORKSPACE_ROOT;
    const workspace = workspacePathOption && await realpath(workspacePathOption);
    const leaseTtlMs = env.SPOOL_CACHE_LEASE_SECONDS === undefined ? undefined : Number(env.SPOOL_CACHE_LEASE_SECONDS) * 1000;
    cache = await openLayerCache(state.blobs, { workspace: workspace || undefined, leaseTtlMs });
    const client = createClient({
      ...await runnerConnection(options, env),
      allowTransferURL: (url) => (env.SPOOL_TRANSFER_ORIGINS ?? "").split(",").map((item) => item.trim()).includes(url.origin),
      layerSource: cache.open,
    });

    async function workspacePath(path) {
      if (!workspace || typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
        throw new TypeError("Use a relative path below SPOOL_WORKSPACE_ROOT");
      }
      const target = await realpath(resolve(workspace, path));
      const fromRoot = relative(workspace, target);
      if (fromRoot === ".." || fromRoot.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) || isAbsolute(fromRoot)) throw new TypeError("Path is outside SPOOL_WORKSPACE_ROOT");
      return target;
    }

    const id = { type: "string" };
    const deadline = { type: "integer", minimum: 1, maximum: 3600 };
    const fields = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
    const idArgs = fields({ task_id: id });
    const tools = {
      capabilities: ["Check the runner's platforms, bases, limits, and resource profile before writing or submitting a Taskfile",
        fields({}), () => client.capabilities()],
      taskfile_help: ["Learn Taskfile syntax and semantics. Choose guide for the workflow, schema for both JSON schemas, or example for runnable project files.",
        fields({ topic: { type: "string", enum: taskfileTopics, default: "guide" } }, []),
        ({ topic = "guide" }) => taskfileHelp(topic)],
      gc_layer_cache: ["Remove layers without an active workspace lease", fields({}), (_args, signal) => cache.gc({ signal })],
      renew_cache_lease: ["Renew the workspace's unexpired layer leases", fields({}), async () => ({ renewed: await cache.renew() })],
      release_cache_lease: ["Return the workspace's layer leases", fields({}), async () => ({ released: await cache.release() })],
      build_layer: ["Build and cache a workspace snapshot or directory delta", fields(
        { directory: id, previous: id }, ["directory"],
      ), async ({ directory, previous }, signal) => cache.buildDirectory(
        await workspacePath(directory), { previous: previous === undefined ? undefined : await workspacePath(previous), signal },
      )],
      submit_template: ["Build and submit a JSON Taskfile. See taskfile_help for syntax. Call wait_task with the returned task ID to upload missing layers.",
        fields({ path: { type: "string", description: "Taskfile path relative to the configured project workspace" },
          client_request_id: { type: "string", description: "Reuse this ID to retry the same manifest" } }, ["path"],
      ), async ({ path, client_request_id }, signal) => {
        const file = await workspacePath(path);
        const { manifest } = await prepareTaskFile(file, { contextRoot: workspace, client, cache, requestId: client_request_id, signal });
        return client.submit(manifest, { signal });
      }],
      submit_task: ["Submit a manifest. Use build_layer to obtain layer descriptors.", manifestSchema,
        (args, signal) => client.submit(args, { signal })],
      task_status: ["Get task status and requested layers", idArgs, ({ task_id }, signal) => client.status(task_id, { signal })],
      wait_task: ["Upload requested layers from the local cache and wait up to wait_s seconds (default 20). Call again if the returned state is nonterminal.", fields(
        { task_id: id, wait_s: { ...deadline, description: "Seconds to wait. Use at most 120 seconds per MCP request." } }, ["task_id"],
      ), async ({ task_id, wait_s = 20 }, signal) => {
        if (!Number.isInteger(wait_s) || wait_s < deadline.minimum || wait_s > deadline.maximum) throw new TypeError("Invalid wait_s");
        const timeout = AbortSignal.timeout(wait_s * 1000);
        try { return await client.wait(task_id, { signal: AbortSignal.any([signal, timeout]) }); }
        catch (error) {
          if (!timeout.aborted || signal.aborted) throw error;
          return client.status(task_id, { signal });
        }
      }],
      extend_task: ["Extend a running task using total seconds since submission", fields({
        task_id: id, task_timeout_s: { type: "integer", minimum: 1 },
      }), ({ task_id, task_timeout_s }, signal) => client.extend(task_id, task_timeout_s, { signal })],
      task_events: ["Page through live task events and stdout and stderr using a cursor", fields({
        task_id: id, cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      }, ["task_id"]), ({ task_id, cursor, limit }, signal) => client.eventPage(task_id, { cursor, limit, signal })],
      cancel_task: ["Cancel a durable task explicitly", idArgs, ({ task_id }, signal) => client.cancel(task_id, { signal })],
      task_artifacts: ["List a task's output artifacts", idArgs, ({ task_id }, signal) => client.artifacts(task_id, { signal })],
      read_artifact: ["Read an artifact from a task as base64", fields({ task_id: id, path: id }),
        async ({ task_id, path }, signal) => {
          const { artifacts } = await client.artifacts(task_id, { signal });
          const artifact = artifacts.find((item) => item.path === path);
          if (!artifact) throw new Error("Task has no artifact at this path");
          const response = await client.download(artifact, { signal });
          const reader = response.body.getReader();
          let size = 0;
          const buffers = [];
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 512 * 1024 || size > artifact.size) throw new Error("Artifact exceeds the advertised size or MCP limit");
              buffers.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          if (size !== artifact.size) throw new Error("Artifact size does not match");
          const bytes = Buffer.concat(buffers, size);
          if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== artifact.digest) {
            throw new Error("Artifact digest does not match");
          }
          return { ...artifact, encoding: "base64", data: bytes.toString("base64") };
        }],
    };
    if (!workspace) {
      delete tools.build_layer;
      delete tools.submit_template;
      delete tools.renew_cache_lease;
      delete tools.release_cache_lease;
    }

    const info = { name: "spool-mcp", version: pkg.version };
    const advertised = { tools: {}, resources: {} };
    const instructions = "Call taskfile_help for Taskfile syntax, schemas, or a runnable example. "
      + (workspace ? "Then call capabilities, submit_template, and wait_task with the returned task ID."
        : "Set --workspace or SPOOL_WORKSPACE_ROOT to enable Taskfile submission and layer building.");
    const modern = "2026-07-28";
    const legacy = ["2025-11-25", "2025-06-18", "2025-03-26"];
    const versionField = "io.modelcontextprotocol/protocolVersion";
    const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    async function dispatch(message, signal) {
      const version = message.params?._meta?.[versionField];
      const result = (value) => write({ id: message.id, result: version === modern
        ? { ...value, _meta: { "io.modelcontextprotocol/serverInfo": info } } : value });
      const fail = (code, text, data) => write({ id: message.id ?? null, error: { code, message: text, data } });
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid request");
      if (version !== undefined && version !== modern) {
        return fail(-32022, "Unsupported protocol version", { supported: [modern, ...legacy], requested: version });
      }
      if (message.method === "initialize" && version === undefined) return result({
        protocolVersion: legacy.includes(message.params?.protocolVersion) ? message.params.protocolVersion : legacy[0],
        serverInfo: info, capabilities: advertised, instructions,
      });
      if (message.method === "server/discover" && version === modern) {
        return result({ supportedVersions: [modern, ...legacy], capabilities: advertised, instructions });
      }
      if (message.method === "ping" && version === undefined) return result({});
      if (message.method === "resources/list") return result({
        resources: taskfileResources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
      });
      if (message.method === "resources/templates/list") return result({ resourceTemplates: [] });
      if (message.method === "resources/read") {
        const found = taskfileResources.find(({ uri }) => uri === message.params?.uri);
        if (!found) return fail(-32002, "Resource not found");
        const { uri, text, mimeType } = found;
        return result({ contents: [{ uri, text, mimeType }] });
      }
      if (message.method === "tools/list") return result({ tools: Object.keys(tools).sort()
        .map((name) => ({ name, description: tools[name][0], inputSchema: tools[name][1] })) });
      if (message.method !== "tools/call") return fail(-32601, "Method not found");
      const name = message.params?.name;
      if (!Object.hasOwn(tools, name)) return fail(-32602, "Unknown tool");
      try {
        const value = await tools[name][2](message.params.arguments ?? {}, signal);
        const text = name === "taskfile_help" && value.markdown ? value.markdown : JSON.stringify(value);
        return result({ content: [{ type: "text", text }], structuredContent: value });
      } catch (error) {
        return result({ isError: true, content: [{ type: "text", text: error.message }] });
      }
    }

    for await (const line of lines(input, lifecycle.signal)) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: -32700, message: "Expected one bounded JSON-RPC message per line" } });
        continue;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)
        || (message.id === undefined && typeof message.method !== "string")
        || (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id))) {
        write({ id: null, error: { code: -32600, message: "Invalid request" } });
        continue;
      }
      if (message.id === undefined) {
        if (message.method === "notifications/cancelled") pending.get(message.params?.requestId)?.controller.abort();
        continue;
      }
      if (pending.has(message.id)) {
        write({ id: message.id, error: { code: -32600, message: "Duplicate in-flight request ID" } });
        continue;
      }
      if (pending.size >= 32) {
        write({ id: message.id, error: { code: -32000, message: "Too many concurrent MCP requests" } });
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifecycle.signal, AbortSignal.timeout(125_000)]);
      const done = dispatch(message, signal).finally(() => pending.delete(message.id));
      pending.set(message.id, { controller, done });
    }
  } catch (error) {
    if (!lifecycle.signal.aborted) throw error;
  } finally {
    await Promise.allSettled([...pending.values()].map(({ done }) => done));
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop);
    try { if (state.isolated) await cache?.release?.(); }
    finally { await state.close(); }
  }
}

async function* lines(input, signal) {
  const limit = 64 * 1024;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let buffered = Buffer.alloc(0);
  let oversize = false;
  for await (const chunk of input) {
    signal.throwIfAborted();
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!oversize && buffered.length + end - start > limit) {
        oversize = true;
        buffered = Buffer.alloc(0);
      }
      if (!oversize) buffered = Buffer.concat([buffered, chunk.subarray(start, end)]);
      if (newline < 0) break;
      let line;
      if (!oversize) {
        try { line = utf8.decode(buffered); } catch {}
      }
      buffered = Buffer.alloc(0);
      oversize = false;
      yield line;
      start = end + 1;
    }
  }
  if (buffered.length || oversize) yield undefined;
}

try {
  const options = parseCli(process.argv.slice(2));
  switch (options.command) {
    case "help": console.log(options.text); break;
    case "taskfile": {
      const help = taskfileHelp(options.action);
      console.log(help.markdown ?? JSON.stringify(help.schemas ?? help.files, null, 2));
      break;
    }
    case "version": console.log(pkg.version); break;
    case "init": console.log(JSON.stringify(await initializeCli(options), null, 2)); break;
    case "auth": console.log(JSON.stringify(await authCommand(options, process.env), null, 2)); break;
    case "cache-gc": {
      const state = await cliState(options, process.env);
      try { console.log(JSON.stringify(await (await openLayerCache(state.blobs)).gc())); }
      finally { await state.close(); }
      break;
    }
    default: await serve(options, process.env);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
