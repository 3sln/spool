import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = resolve(process.argv[2] ?? "dist");
const packageInfo = {
  version: source.version,
  type: "module", license: "MIT", engines: source.engines,
  repository: { type: "git", url: "git+https://github.com/3sln/spool.git" },
};
const clientFiles = [
  "client/index.mjs", "client/layers.mjs", "client/node.mjs", "client/taskfile.mjs", "client/generated/js",
];
const packages = [
  {
    manifest: { name: "@3sln/spool", description: "Client SDK and layer builders for the Spool task protocol", exports: source.exports },
    files: clientFiles,
  },
  {
    manifest: {
      name: "@3sln/spool-runner", description: "Self-hosted and Cloudflare runners for the Spool task protocol",
      bin: { "spool-runner": "./bin/runner.mjs" },
      exports: { ".": "./src/node.mjs", "./worker": "./src/worker.mjs", "./contract": "./src/contract.mjs" },
      optionalDependencies: source.optionalDependencies,
    },
    files: ["src", "guest/Dockerfile", "guest/runner.py", "guest/.dockerignore", "bin/runner.mjs", "wrangler.jsonc"],
  },
  {
    manifest: { name: "@3sln/spool-mcp", description: "Stdio MCP client for Spool runners", bin: { "spool-mcp": "./bin/mcp.mjs" } },
    files: [...clientFiles, "bin/mcp.mjs", "bin/mcp-config.mjs"],
  },
];

export function command(cmd, args, cwd, stdio = "inherit") {
  const child = spawnSync(cmd, args, { cwd, stdio, encoding: "utf8" });
  if (child.error || child.status !== 0) throw child.error ?? new Error(`${cmd} exited with status ${child.status}: ${child.stderr ?? ""}`);
  return child.stdout;
}

await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "spool-release-"));
try {
  const entries = [];
  for (const { manifest, files } of packages) {
    const path = join(staging, manifest.name.split("/")[1]);
    await mkdir(path, { recursive: true });
    for (const file of [...files, "protocol", "README.md", "LICENSE"]) {
      await mkdir(resolve(path, file, ".."), { recursive: true });
      await cp(join(root, file), join(path, file), { recursive: true });
    }
    await writeFile(join(path, "package.json"), JSON.stringify({ ...packageInfo, ...manifest }, null, 2) + "\n");
    const packed = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], path, "pipe"));
    entries.push({ file: packed[0].filename, package: manifest.name, version: source.version });
    console.log(packed[0].filename);
  }
  const version = source.version;
  const escaped = version.replaceAll(".", "\\.");
  const assetVersion = new RegExp(`(?:-|v)${escaped}(?:[.-]|$)`, "u");
  for (const file of await readdir(output)) {
    if (assetVersion.test(file) && !entries.some((entry) => entry.file === file) && /\.(crate|tar\.gz)$/u.test(file)) entries.push({ file });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file));
  for (const item of entries) item.sha256 = createHash("sha256").update(await readFile(join(output, item.file))).digest("hex");
  await writeFile(join(output, "SHA256SUMS"), entries.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""));
  await writeFile(join(output, "artifacts.json"), JSON.stringify({ version, entries }, null, 2) + "\n");
} finally {
  await rm(staging, { recursive: true, force: true });
}
