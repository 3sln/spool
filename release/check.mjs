import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const { version, entries } = JSON.parse(await readFile(join(dist, "artifacts.json"), "utf8"));
const names = new Set(["@3sln/spool", "@3sln/spool-runner", "@3sln/spool-mcp"]);
const install = [];
for (const entry of entries) {
  assert.equal(createHash("sha256").update(await readFile(join(dist, entry.file))).digest("hex"), entry.sha256);
  if (!entry.package) continue;
  assert.ok(names.delete(entry.package));
  assert.equal(entry.version, version);
  install.push(join(dist, entry.file));
}
assert.equal(names.size, 0);
const scratch = await mkdtemp(join(tmpdir(), "spool-consumer-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: scratch, stdio: "pipe", encoding: "utf8", ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", ...install]);
  run(process.execPath, ["--input-type=module", "-e",
    'import { createClient } from "@3sln/spool"; import { openLayerCache } from "@3sln/spool/node"; import { prepareTaskFile } from "@3sln/spool/taskfile"; import { start } from "@3sln/spool-runner/node"; if (![createClient, openLayerCache, prepareTaskFile, start].every(x => typeof x === "function")) process.exitCode=1;',
  ]);
  const runner = join(scratch, "node_modules", "@3sln", "spool-runner");
  const mcp = join(scratch, "node_modules", "@3sln", "spool-mcp", "bin", "mcp.mjs");
  assert.equal(run(process.execPath, [join(runner, "bin", "runner.mjs"), "--version"]).trim(), version);
  assert.equal(run(process.execPath, [mcp, "--version"]).trim(), version);
  assert.ok((await stat(join(runner, "guest", "Dockerfile"))).isFile());
  assert.ok(!(await readdir(runner)).some((name) => /^wrangler\./u.test(name)));
  const esbuild = process.env.SPOOL_ESBUILD ?? (process.env.SPOOL_TOOL_MODULES
    ? join(process.env.SPOOL_TOOL_MODULES, "esbuild", "bin", "esbuild") : undefined);
  if (esbuild) {
    await writeFile(join(scratch, "worker.mjs"), `
      import { createWorkerRunner } from "@3sln/spool-runner/worker";
      export { TenantRunner, GuestSlot } from "@3sln/spool-runner/worker";
      export default createWorkerRunner();
    `);
    run(esbuild, ["worker.mjs", "--bundle", "--platform=neutral", "--format=esm",
      "--external:cloudflare:*", "--outfile=worker.bundle.mjs"]);
  }
  run(process.execPath, [mcp, "init", "--runner", "https://runner.example", "--state-mode", "isolated"]);
  const config = JSON.parse(await readFile(join(scratch, ".mcp.json"), "utf8"));
  assert.equal(config.mcpServers.spool.command, "spool-mcp");
  assert.ok(config.mcpServers.spool.args.includes("isolated"));
  const handshake = run(process.execPath, [mcp, "serve", "--state-mode", "isolated"], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) + "\n",
  });
  assert.equal(JSON.parse(handshake).result.serverInfo.version, version);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log("Installed SDK, runner and stdio MCP from release tarballs");
