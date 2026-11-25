import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { buildLayer, DEFAULT_LAYER_LIMIT, layerDescriptor, TAR } from "./layers.mjs";

function keyFor(digest) {
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new TypeError("Invalid layer digest");
  return digest.slice(7);
}

async function boundedFile(path, size) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > size) throw new Error("Expected a regular file within the byte limit");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("File changed while being read");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== bytes.length) throw new Error("File changed while being read");
    return { bytes, mode: info.mode };
  } finally { await file.close(); }
}

export async function openLayerCache(directory, { maxLayerBytes = DEFAULT_LAYER_LIMIT } = {}) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const layerPath = (digest) => join(root, keyFor(digest));
  return {
    async put(bytes, mediaType = TAR) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected Uint8Array layer bytes");
      if (bytes.length > maxLayerBytes) throw new RangeError("Layer exceeds the cache limit");
      const snapshot = Uint8Array.from(bytes);
      const descriptor = await layerDescriptor(snapshot, mediaType);
      const destination = layerPath(descriptor.digest);
      const temporary = join(root, `.${crypto.randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(snapshot);
          await file.sync();
        } finally { await file.close(); }
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      return descriptor;
    },
    async source(descriptor, { signal } = {}) {
      signal?.throwIfAborted();
      const path = layerPath(descriptor.digest);
      if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > maxLayerBytes) {
        throw new RangeError("Layer descriptor exceeds the cache limit");
      }
      const found = await boundedFile(path, descriptor.size).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!found) return undefined;
      const actual = await layerDescriptor(found.bytes, descriptor.media_type);
      if (actual.digest !== descriptor.digest || actual.size !== descriptor.size) {
        throw new Error(`Layer cache integrity check failed for ${descriptor.digest}`);
      }
      return found.bytes;
    },
    async list() {
      return (await readdir(root)).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort().map((name) => `sha256:${name}`);
    },
    async delete(digest) { await rm(layerPath(digest), { force: true }); },
  };
}

async function snapshot(root, { maxBytes, include, signal }) {
  const entries = new Map();
  let remaining = maxBytes;
  if (!(await lstat(root)).isDirectory()) throw new TypeError("Workspace root must be a directory");
  async function visit(parent = "") {
    signal?.throwIfAborted();
    for (const name of (await readdir(join(root, parent))).sort()) {
      const path = parent ? `${parent}/${name}` : name;
      if (!include(path)) continue;
      if (entries.size >= 4096 || path.split("/").length > 32) throw new RangeError("Workspace exceeds the entry or depth limit");
      const full = join(root, path);
      const info = await lstat(full);
      if (info.isDirectory()) {
        entries.set(path, { kind: "directory", path });
        await visit(path);
      } else if (info.isFile()) {
        const { bytes, mode } = await boundedFile(full, remaining);
        remaining -= bytes.length;
        entries.set(path, { kind: "file", path, bytes, executable: Boolean(mode & 0o111) });
      } else {
        throw new TypeError(`Unsupported workspace entry: ${path}`);
      }
    }
  }
  await visit();
  return entries;
}

export async function buildDirectoryLayer(directory, {
  previous, maxBytes = DEFAULT_LAYER_LIMIT, snapshotBytes = 32 * 1024 ** 2,
  include = () => true, signal,
} = {}) {
  const options = { maxBytes: snapshotBytes, include, signal };
  const current = await snapshot(resolve(directory), options);
  if (!previous) return buildLayer(current.values(), { maxBytes });
  const prior = await snapshot(resolve(previous), options);
  const delta = [];
  const removed = new Set();
  for (const [path, entry] of prior) {
    if (current.get(path)?.kind === entry.kind) continue;
    const parts = path.split("/");
    if (parts.slice(0, -1).some((_, index) => removed.has(parts.slice(0, index + 1).join("/")))) continue;
    delta.push({ kind: "delete", path });
    removed.add(path);
  }
  for (const [path, entry] of current) {
    const before = prior.get(path);
    if (entry.kind !== before?.kind || (entry.kind === "file"
      && (entry.executable !== before.executable || !entry.bytes.equals(before.bytes)))) delta.push(entry);
  }
  return buildLayer(delta, { maxBytes });
}
