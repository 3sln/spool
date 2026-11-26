import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { leaseDirectory } from "./cache-leases.mjs";
import { PATCH_MEDIA, TAR, tarMember } from "./layers.mjs";
import { buildKey, directorySelection } from "./node.mjs";
import { writeSourcePatch } from "./source-diff.mjs";

const MiB = 1024 ** 2;
const padding = Buffer.alloc(1024);
const string = (value) => typeof value === "string" && value.length && value.isWellFormed() && !value.includes("\0");
const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function* readSourceFile(path, entry, signal) {
  if (await realpath(path) !== path) throw new Error("file path changed or traverses a symlink");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== entry.size || Boolean(stat.mode & 0o111) !== entry.executable) {
      throw new Error("file changed while reading source");
    }
    let length = 0;
    for await (const data of file.createReadStream({ autoClose: false, signal })) {
      length += data.length;
      if (length > entry.size) throw new Error("file grew while reading source");
      yield data;
    }
    if (length !== entry.size) throw new Error("file changed while reading source");
  } finally {
    await file.close();
  }
}

async function scanSource(root, destination, filters, maxBytes, maxMembers, signal) {
  const entries = [];
  let bytes = 0;
  function add(entry, sourcePath) {
    if (entry.path.startsWith(".spool-stage-") || entry.path.includes("\\")) throw new Error("reserved workspace path");
    const member = tarMember(entry);
    if (member.bytes + 1024 > maxBytes) throw new RangeError(`entry exceeds the layer limit of ${maxBytes} bytes`);
    if (entries.length >= maxMembers) throw new RangeError("source exceeds the runner layer entry budget");
    entries.push({ ...member, entry, sourcePath });
    bytes += member.bytes;
  }
  add({ kind: "opaque", path: destination });
  if (destination) add({ kind: "directory", path: destination });
  async function visit(parent, inherited) {
    signal?.throwIfAborted();
    const directory = parent ? join(root, parent) : root;
    if (await realpath(directory) !== directory) throw new Error(`directory path changed: ${parent}`);
    let found = false;
    for (const name of (await readdir(directory)).sort(compare)) {
      const rel = parent ? parent + "/" + name : name;
      if (name === leaseDirectory || !filters.include(rel)) continue;
      const path = join(root, rel);
      const output = destination ? destination + "/" + rel : rel;
      try {
        const stat = await lstat(path);
        const selected = inherited || filters.select(rel);
        if (stat.isDirectory()) {
          if (output.split("/").length > 32) throw new Error("workspace path exceeds the directory depth limit");
          if (await visit(rel, selected) || selected) {
            add({ kind: "directory", path: output });
            found = true;
          }
        } else if (selected && stat.isFile()) {
          const entry = { kind: "file", path: output, size: stat.size, executable: Boolean(stat.mode & 0o111) };
          if (entry.size > maxBytes - 1536) throw new RangeError(`file exceeds the layer limit of ${maxBytes} bytes`);
          const digest = createHash("sha256");
          for await (const chunk of readSourceFile(path, entry, signal)) digest.update(chunk);
          entry.hash = digest.digest("hex");
          add(entry, path);
          found = true;
        } else if (selected && stat.isSymbolicLink()) {
          const target = await readlink(path);
          tarMember({ kind: "symlink", path: rel, target });
          add({ kind: "symlink", path: output, target });
          found = true;
        } else if (selected) {
          throw new Error("expected a directory, regular file, or relative symlink");
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error.sourcePath) throw error;
        const reason = new Error(`${rel}: ${error.message}`, { cause: error });
        reason.sourcePath = rel;
        throw reason;
      }
    }
    return found;
  }
  await visit("", false);
  const marker = entries.shift();
  return { members: [marker, ...entries.sort((a, b) => compare(a.name, b.name))], bytes };
}

function pack(members, maxBytes) {
  const groups = [];
  let current;
  for (const member of members) {
    if (!current || current.members.length === 4096 || current.size + member.bytes > maxBytes) {
      current = { members: [], size: 1024 };
      groups.push(current);
    }
    current.size += member.bytes;
    current.members.push(member);
  }
  return groups;
}

async function* archiveBytes(members, signal) {
  for (const member of members) {
    signal?.throwIfAborted();
    yield member.header;
    if (member.sourcePath) {
      const digest = createHash("sha256");
      try {
        for await (const chunk of readSourceFile(member.sourcePath, member.entry, signal)) {
          digest.update(chunk);
          yield chunk;
        }
        if (member.entry.hash !== digest.digest("hex")) throw new Error("file changed while building layer");
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`${member.entry.path}: ${error.message}`, { cause: error });
      }
    }
    if (member.padding) yield padding.subarray(0, member.padding);
  }
  yield padding;
}

function cachedBuild(cache, key, build, signal) {
  return cache.resolveBuildDescriptor ? cache.resolveBuildDescriptor(key, build, { signal }) : build();
}

async function buildArchive(group, cache, maxBytes, signal) {
  const key = buildKey(["sources-tar", 1, group.members.map(({ entry }) => entry)]);
  return cachedBuild(cache, key, async () => {
    const dir = await mkdtemp(join(tmpdir(), "spool-sources-"));
    const path = join(dir, "archive.tar");
    try {
      await pipeline(Readable.from(archiveBytes(group.members, signal)), createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
      return await cache.importFile(path, TAR, { maxBytes, signal });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, signal);
}

function validateDiff(diff, allowed) {
  if (diff === undefined) return;
  if (!diff || Array.isArray(diff) || typeof diff !== "object"
    || Object.keys(diff).some((key) => !["format", "argv", "strip"].includes(key))
    || !["git", "vcdiff"].includes(diff.format) || !Array.isArray(diff.argv) || diff.argv.length > 128
    || !string(diff.argv[0]) || !diff.argv.every((arg) => string(arg) && arg.length <= 4096)
    || !(diff.format === "vcdiff" ? ["{base}", "{current}", "{patch}"] : ["{base}", "{current}"])
      .every((token) => diff.argv.includes(token))
    || (diff.strip !== undefined && (diff.format !== "git" || !Number.isInteger(diff.strip) || diff.strip < 0 || diff.strip > 16))) {
    throw new TypeError("Invalid sources diff format, argv, or Git strip count");
  }
  if (!allowed) throw new Error("A sources diff command requires --allow-source-diff-command or allowSourceDiffCommand");
}

async function patchLayer(cache, before, after, options) {
  const { diff, directory, maxBytes, signal } = options;
  const limit = Math.min(maxBytes, Math.floor(after.size / 2));
  const key = buildKey(["sources-vcdiff", 1, before.digest, after.digest,
    diff ? [directory, diff.format, diff.argv, diff.strip] : null]);
  const base = await cache.open(before, { signal });
  if (!base) return;
  return cachedBuild(cache, key, async () => {
    const target = await cache.open(after, { signal });
    const temp = await mkdtemp(join(tmpdir(), "spool-source-diff-"));
    const path = join(temp, "patch.layer");
    try {
      if (!await writeSourcePatch(path, temp, base, target, after, { diff, directory, limit, signal })) return;
      return await cache.importFile(path, PATCH_MEDIA, { maxBytes: limit, signal });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, signal);
}

export async function planSourceLayers(recipe, options) {
  const { directory, roots, maxLayers, maxBytes, maxInputBytes, cache, signal, allowSourceDiffCommand } = options;
  if (!Array.isArray(recipe.sources) || recipe.sources.length === 0 || recipe.sources.length > maxLayers) {
    throw new TypeError(`Layer "${recipe.id}" requires one to ${maxLayers} source mappings`);
  }
  if (typeof cache.importFile !== "function" || typeof cache.open !== "function") throw new TypeError("Sources require a cache with importFile and open");
  validateDiff(recipe.diff, allowSourceDiffCommand);
  const dests = [];
  const plans = [];
  let used = 0;
  let totalBytes = 0;
  for (const [index, source] of recipe.sources.entries()) {
    const label = `Layer "${recipe.id}" source ${index + 1}${string(source?.path) ? ` (${source.path})` : ""}`;
    try {
      if (!source || Array.isArray(source) || Object.keys(source).some((key) => !["path", "destination", "include", "exclude"].includes(key))
        || !string(source.path) || isAbsolute(source.path) || !string(source.destination)
        || !(source.destination === "/workspace" || source.destination.startsWith("/workspace/") && source.destination.length > 11)) {
        throw new TypeError("expected a Taskfile-relative path and an absolute /workspace destination");
      }
      const destination = source.destination.slice(11);
      const parts = destination.split("/");
      if (destination && parts.some((part) => !part || ["..", "."].includes(part) || part.startsWith(".wh."))) {
        throw new TypeError("invalid workspace destination");
      }
      if (dests.some((other) => !other || !destination || other === destination || other.startsWith(destination + "/") || destination.startsWith(other + "/"))) {
        throw new Error("source destinations overlap within this layer");
      }
      dests.push(destination);
      const path = resolve(directory, source.path);
      const allowed = roots.filter((root) => within(root, path));
      if (!allowed.length) throw new Error("source is outside the configured source roots");
      const canonical = await realpath(path);
      if (!allowed.some((root) => within(root, canonical))) throw new Error("source resolves outside the configured source roots");
      if (!(await lstat(canonical)).isDirectory()) throw new Error("source path must name a directory");
      const inputs = await scanSource(canonical, destination, directorySelection(source), maxBytes, (maxLayers - used) * 4096, signal);
      const groups = pack(inputs.members, maxBytes);
      used += groups.length;
      totalBytes += inputs.bytes + groups.length * 1024;
      if (used > maxLayers || totalBytes > maxInputBytes) {
        throw new RangeError("split source archives exceed the runner layer count or combined input limit");
      }
      const full = [];
      for (const group of groups) full.push(await buildArchive(group, cache, maxBytes, signal));
      const key = buildKey(["source-baseline", 2, canonical, destination, source.include ?? null, source.exclude ?? [], maxBytes]);
      plans.push({ key, full, label });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`${label}: ${error.message}`, { cause: error });
    }
  }
  return {
    count: used, bytes: totalBytes,
    async select(extra, { patches, workspaceBytes = Infinity }) {
      const results = [];
      let logical = 0;
      for (const { key, full, label } of plans) {
        try {
          const select = async (old) => {
            const baseline = [];
            const layers = [];
            for (const [index, snapshot] of full.entries()) {
              signal?.throwIfAborted();
              const previous = old[index];
              let chosen = { target: snapshot, layers: [snapshot], peakBytes: 0 };
              if (patches && previous && previous.layers.length - 1 <= extra.slots
                && previous.peakBytes <= workspaceBytes - logical) {
                const available = cache.retain ? await Promise.all(previous.layers.map(({ digest }) => cache.retain(digest, { signal })))
                  : await Promise.all(previous.layers.map((layer) => cache.open(layer, { signal })));
                if (available.every(Boolean)) {
                  if (previous.target.digest === snapshot.digest) {
                    chosen = previous;
                  } else if (previous.layers.length <= extra.slots && previous.target.size + snapshot.size < workspaceBytes - logical) {
                    const patch = await patchLayer(cache, previous.target, snapshot, { ...options, diff: recipe.diff });
                    if (patch) {
                      const peakBytes = Math.max(previous.peakBytes, previous.target.size + patch.size + snapshot.size);
                      const patchBytes = previous.layers.slice(1).reduce((sum, layer) => sum + layer.size, patch.size);
                      if (peakBytes <= workspaceBytes - logical && patchBytes <= snapshot.size / 2) {
                        chosen = { target: snapshot, layers: [...previous.layers, patch], peakBytes };
                      }
                    }
                  }
                }
              }
              let overhead = chosen.layers.reduce((sum, layer) => sum + layer.size, -snapshot.size);
              if (overhead > extra.bytes) {
                chosen = { target: snapshot, layers: [snapshot], peakBytes: 0 };
                overhead = 0;
              }
              baseline.push(chosen);
              layers.push(...chosen.layers);
              extra.slots -= chosen.layers.length - 1;
              extra.bytes -= overhead;
              logical += snapshot.size;
            }
            return { baseline, layers };
          };
          results.push(...(cache.updateSourceBaseline ? await cache.updateSourceBaseline(key, select, { signal }) : full));
        } catch (error) {
          signal?.throwIfAborted();
          throw new Error(`${label}: ${error.message}`, { cause: error });
        }
      }
      return results;
    },
  };
}
