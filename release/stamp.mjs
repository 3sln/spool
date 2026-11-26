import { readFile, writeFile } from "node:fs/promises";

const [version, mode] = process.argv.slice(2);
const semver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/u;
if (!semver.test(version ?? "") || (mode !== undefined && mode !== "--check")) throw new Error("Expected a release version and optional --check");

async function update(path, stamp) {
  const original = await readFile(path, "utf8");
  const updated = stamp(original);
  if (updated === original) return;
  if (mode === "--check") throw new Error(`${path} does not match version.edn. Run bb stamp in the release checkout.`);
  await writeFile(path, updated);
}

for (const path of ["package.json", "package-lock.json"]) {
  await update(path, (text) => {
    const data = JSON.parse(text);
    data.version = version;
    if (data.packages) data.packages[""].version = version;
    return JSON.stringify(data, null, 2) + "\n";
  });
}
for (const [directory, name] of [["guest", "spool-guest"], ["sdk/rust", "spool-client"]]) {
  for (const file of ["Cargo.toml", "Cargo.lock"]) {
    const entry = new RegExp(`(?<=^name = "${name}"\\r?\\nversion = ")[^"\\r\\n]+`, "mu");
    await update(`${directory}/${file}`, (text) => {
      if (!entry.test(text)) throw new Error(`Missing ${name} version in ${file}`);
      return text.replace(entry, version);
    });
  }
}
