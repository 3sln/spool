import { createHash } from "node:crypto";
import { constants, createWriteStream, openAsBlob } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { resolve, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildLayer, DEFAULT_LAYER_LIMIT, layerDescriptor, TAR, TAR_GZIP } from "./layers.mjs";
import { resolveBuild } from "./build-cache.mjs";
import { leaseDirectory, leaseIndex } from "./cache-leases.mjs";

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

export async function openLayerCache(directory, { maxLayerBytes = 2 * 1024 ** 3, workspace, leaseTtlMs } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const leases = leaseIndex(root);
  const layerPath = (digest) => join(root, keyFor(digest));
  async function openRegular(path, maximum) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > maximum) throw new RangeError("Expected a layer file within the byte limit");
      return { file, size: info.size };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  function layerSize(descriptor) {
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > maxLayerBytes) {
      throw new RangeError("Layer descriptor exceeds the cache limit");
    }
    return descriptor.size;
  }
  async function scan(file, size, signal, destination) {
    const hash = createHash("sha256");
    let consumed = 0;
    const input = file.createReadStream({ autoClose: false });
    const verify = (chunk) => {
      consumed += chunk.length;
      if (consumed > size) throw new Error("Layer grew while it was being read");
      hash.update(chunk);
    };
    if (destination) {
      const transform = new Transform({
        transform(chunk, _encoding, done) {
          try { verify(chunk); done(null, chunk); }
          catch (error) { done(error); }
        },
      });
      await pipeline(input, transform, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
    } else {
      for await (const chunk of input) {
        signal?.throwIfAborted();
        verify(chunk);
      }
    }
    if (consumed !== size) throw new Error("Layer changed while it was being read");
    return `sha256:${hash.digest("hex")}`;
  }
  async function publish(temporary, digest, lease, signal) {
    await leases.transact(async (db) => {
      if (lease) await lease.retain(db, digest);
      await rename(temporary, layerPath(digest));
    }, signal);
  }
  function scoped(lease) {
    async function retain(digest, { signal } = {}) {
      if (!lease) throw new Error("A workspace lease is required");
      const path = layerPath(digest);
      return leases.transact(async (db) => {
        const present = await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!present?.isFile()) return false;
        await lease.retain(db, digest);
        return true;
      }, signal);
    }
    const cache = {
      async forWorkspace(directory, { ttlMs = leaseTtlMs } = {}) {
        return scoped(await leases.workspace(directory, ttlMs));
      },
      ...(lease && { leasePath: lease.path, renew: lease.renew, release: lease.release, retain }),
      async put(bytes, mediaType = TAR) {
        if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected Uint8Array layer bytes");
        if (bytes.length > maxLayerBytes) throw new RangeError("Layer exceeds the cache limit");
        const snapshot = Uint8Array.from(bytes);
        const descriptor = await layerDescriptor(snapshot, mediaType);
        const temporary = join(root, `.${crypto.randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(snapshot);
            await file.sync();
          } finally { await file.close(); }
          await publish(temporary, descriptor.digest, lease);
        } finally { await rm(temporary, { force: true }); }
        return descriptor;
      },
      async source(descriptor, { signal } = {}) {
        signal?.throwIfAborted();
        const path = layerPath(descriptor.digest);
        if (lease && !await retain(descriptor.digest, { signal })) return undefined;
        const found = await boundedFile(path, layerSize(descriptor)).catch((error) => {
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
      async open(descriptor, { signal } = {}) {
        const path = layerPath(descriptor.digest);
        if (lease && !await retain(descriptor.digest, { signal })) return undefined;
        const entry = await openRegular(path, layerSize(descriptor)).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!entry) return undefined;
        try {
          if (entry.size !== descriptor.size || await scan(entry.file, entry.size, signal) !== descriptor.digest) {
            throw new Error(`Layer cache integrity check failed for ${descriptor.digest}`);
          }
          return process.versions.bun ? Bun.file(path) : await openAsBlob(path);
        } finally {
          await entry.file.close();
        }
      },
      async importFile(path, mediaType = TAR, { maxBytes = maxLayerBytes, signal } = {}) {
        if (![TAR, TAR_GZIP].includes(mediaType)) throw new TypeError("Expected an OCI tar media type");
        const entry = await openRegular(path, Math.min(maxBytes, maxLayerBytes));
        const temporary = join(root, `.${crypto.randomUUID()}.tmp`);
        try {
          const digest = await scan(entry.file, entry.size, signal, temporary);
          const written = await open(temporary, "r");
          try { await written.sync(); } finally { await written.close(); }
          await publish(temporary, digest, lease, signal);
          return { digest, size: entry.size, media_type: mediaType };
        } finally {
          await entry.file.close();
          await rm(temporary, { force: true });
        }
      },
      async resolveBuild(buildKey, build, { signal } = {}) {
        return cache.resolveBuildDescriptor(buildKey, async () => {
          const { bytes, mediaType } = await build();
          return cache.put(bytes, mediaType);
        }, { signal });
      },
      async resolveBuildDescriptor(buildKey, build, { signal } = {}) {
        const key = keyFor(buildKey);
        const index = join(root, ".builds");
        await mkdir(index, { recursive: true, mode: 0o700 });
        return resolveBuild(join(index, key + ".sqlite"),
          (descriptor) => cache.open(descriptor, { signal }), build, signal);
      },
      async buildDirectory(directory, options = {}) {
        const prepared = await planDirectoryLayer(directory, options);
        const key = buildKey(["directory", 1, prepared.fingerprint()]);
        return cache.resolveBuild(key, () => ({ bytes: prepared.build(), mediaType: TAR }), options);
      },
      async list() {
        return (await readdir(root)).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort().map((name) => `sha256:${name}`);
      },
      async delete(digest, { force = false } = {}) {
        const path = layerPath(digest);
        return leases.transact(async (db) => {
          if (!force && (await leases.active(db)).retained.has(digest)) return false;
          await rm(path, { force: true });
          db.prepare("DELETE FROM leases WHERE digest = ?").run(digest);
          return true;
        });
      },
      async gc({ signal } = {}) {
        return leases.transact(async (db) => {
          const { retained, removedLeases } = await leases.active(db);
          const removedLayers = [];
          for (const digest of await cache.list()) {
            if (retained.has(digest)) continue;
            await rm(layerPath(digest), { force: true });
            removedLayers.push(digest);
          }
          return { removedLayers, removedLeases };
        }, signal);
      },
    };
    return cache;
  }
  return workspace === undefined ? scoped() : scoped(await leases.workspace(workspace, leaseTtlMs));
}

export function buildKey(inputs) {
  return `sha256:${createHash("sha256").update(JSON.stringify(inputs)).digest("hex")}`;
}

export function directorySelection({ include, exclude = [] } = {}) {
  for (const patterns of [include === undefined ? [] : include, exclude]) {
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string"
      || pattern.includes("\0") || pattern.split("/").some((part) => !part || part === "." || part === ".."))) {
      throw new TypeError("Directory layer filters must contain relative paths or glob patterns");
    }
  }
  const matches = (patterns, path) => patterns.some((pattern) => posix.matchesGlob(path, pattern));
  return { include: (path) => !matches(exclude, path), select: (path) => include === undefined || matches(include, path) };
}

async function snapshot(root, { maxBytes, include, select, signal }) {
  const entries = new Map();
  let remaining = maxBytes;
  if (!(await lstat(root)).isDirectory()) throw new TypeError("Workspace root must be a directory");
  async function visit(parent = "", inherited = false) {
    signal?.throwIfAborted();
    let found = false;
    for (const name of (await readdir(join(root, parent))).sort()) {
      const path = parent ? `${parent}/${name}` : name;
      if (name === leaseDirectory || !include(path)) continue;
      if (entries.size >= 4096 || path.split("/").length > 32) throw new RangeError("Workspace exceeds the entry or depth limit");
      const full = join(root, path);
      const info = await lstat(full);
      const selected = inherited || select(path);
      if (info.isDirectory()) {
        entries.set(path, { kind: "directory", path });
        if (await visit(path, selected) || selected) found = true;
        else entries.delete(path);
      } else if (!selected) {
        continue;
      } else if (info.isFile()) {
        const { bytes, mode } = await boundedFile(full, remaining);
        remaining -= bytes.length;
        entries.set(path, { kind: "file", path, bytes, executable: Boolean(mode & 0o111) });
        found = true;
      } else if (info.isSymbolicLink()) {
        entries.set(path, { kind: "symlink", path, target: await readlink(full) });
        found = true;
      } else {
        throw new TypeError(`Unsupported workspace entry ${path}: expected a regular file, directory, or relative symlink`);
      }
    }
    return found;
  }
  await visit();
  if (entries.size > 4096) throw new RangeError("Workspace exceeds the entry limit");
  return entries;
}

export async function planDirectoryLayer(directory, {
  previous, maxBytes = DEFAULT_LAYER_LIMIT, snapshotBytes = 32 * 1024 ** 2,
  include = () => true, select = () => true, signal,
} = {}) {
  const options = { maxBytes: snapshotBytes, include, select, signal };
  const current = await snapshot(resolve(directory), options);
  const prior = previous ? await snapshot(resolve(previous), options) : new Map();
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
      && (entry.executable !== before.executable || !entry.bytes.equals(before.bytes)))
      || (entry.kind === "symlink" && entry.target !== before.target)) delta.push(entry);
  }
  return {
    build: () => buildLayer(delta, { maxBytes }),
    fingerprint() {
      return buildKey(delta.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind.localeCompare(b.kind))
        .map(({ kind, path, executable, bytes, target }) => kind === "file"
          ? [kind, path, executable, bytes.length, createHash("sha256").update(bytes).digest("hex")]
          : kind === "symlink" ? [kind, path, target] : [kind, path]));
    },
  };
}

export async function buildDirectoryLayer(directory, options) {
  return (await planDirectoryLayer(directory, options)).build();
}
