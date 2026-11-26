import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2] ?? "dist";
const name = "@3sln/spool-mcp";
const registry = "https://registry.npmjs.org";
const { version, entries } = JSON.parse(await readFile(join(directory, "artifacts.json"), "utf8"));
const entry = entries.find((entry) => entry.package === name);
assert.equal(entry?.file, `3sln-spool-mcp-${version}.tgz`);
assert.equal(entry.version, version);

const tarball = join(directory, entry.file);
const bytes = await readFile(tarball);
assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");

const view = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--registry", registry, "--json"], { encoding: "utf8" });
if (view.error) throw view.error;
if (view.status === 0 && view.stdout.trim()) {
  assert.equal(JSON.parse(view.stdout), integrity, `npm already contains different bytes for ${name}@${version}`);
  console.log(`${name}@${version} is already published with the expected integrity`);
} else {
  if (view.status !== 0) {
    const response = JSON.parse(view.stdout || "{}");
    if (response.error?.code !== "E404") throw new Error(view.stderr || "npm registry lookup failed");
  }
  const publish = spawnSync("npm", ["publish", tarball, "--access", "public", "--registry", registry, "--tag",
    version.includes("-") ? "next" : "latest"], { stdio: "inherit" });
  if (publish.error) throw publish.error;
  assert.equal(publish.status, 0, "npm publish failed");
}
