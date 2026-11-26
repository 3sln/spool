import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliArchiveName, cliPlatforms } from "./platforms.mjs";
import pkg from "../package.json" with { type: "json" };

const destination = resolve(process.argv[2] ?? "dist");
const platform = process.platform + "-" + process.arch;
if (!cliPlatforms.includes(platform)) throw new Error(`Unsupported CLI platform ${platform}`);
const windows = process.platform === "win32";
const name = windows ? "spool-mcp.exe" : "spool-mcp";

function run(command, args, options = {}) {
  const child = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr || `${command} exited with ${child.status}`);
  return child.stdout;
}

await mkdir(destination, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "spool-mcp-bin-"));
try {
  const executable = join(scratch, name);
  const workspace = join(scratch, "workspace");
  const state = join(scratch, "state");
  await mkdir(workspace);
  await writeFile(join(workspace, "input.txt"), "Spool standalone release smoke\n");
  run("bun", ["build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    "bin/mcp.mjs", "--outfile", executable], { stdio: "inherit" });
  const env = {
    ...process.env,
    SPOOL_STATE_DIR: state, SPOOL_STATE_MODE: "custom", SPOOL_BLOB_DIR: join(state, "layers"),
    SPOOL_AUTH_DIR: join(scratch, "auth"), SPOOL_PROFILE: "", SPOOL_URL: "", SPOOL_WORKSPACE_ROOT: workspace,
  };
  const options = { cwd: workspace, env };
  assert.equal(run(executable, ["--version"], options).trim(), pkg.version);
  const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "build_layer", arguments: { directory: "." } } };
  const reply = JSON.parse(run(executable, [], { ...options, input: JSON.stringify(message) + "\n" }));
  assert.match(reply.result?.structuredContent?.digest ?? "", /^sha256:[a-f0-9]{64}$/u, JSON.stringify(reply));
  assert.deepEqual(JSON.parse(run(executable, ["cache-gc"], options)), { removedLayers: [], removedLeases: 0 });

  await cp("LICENSE", join(scratch, "LICENSE"));
  const archive = join(destination, cliArchiveName(pkg.version, platform));
  if (windows) {
    run("tar", ["-a", "-cf", archive, name, "LICENSE"], { cwd: scratch });
  } else {
    run("tar", ["-czf", archive, name, "LICENSE"], { cwd: scratch });
  }
  console.log(archive);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
