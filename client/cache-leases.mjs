import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withCacheTransaction } from "./build-cache.mjs";

export const defaultLeaseMs = 7 * 24 * 60 * 60 * 1000;
export const leaseDirectory = ".spool-leases";
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isMissing = ({ code }) => code === "ENOENT" || code === "ENOTDIR";

async function marker(path) {
  const parent = dirname(path);
  const actual = await realpath(parent).catch((error) => {
    if (isMissing(error) || error.code === "ELOOP") return undefined;
    throw error;
  });
  if (actual !== parent) return undefined;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    if (isMissing(error) || error.code === "ELOOP") return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== 36) return undefined;
    const bytes = Buffer.alloc(36);
    const { bytesRead } = await file.read(bytes);
    const token = bytes.toString("latin1");
    if (bytesRead === 36 && tokenPattern.test(token)) return token;
  } finally { await file.close(); }
}

async function ensureMarker(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("Lease directory must be inside the workspace");
  const previous = await marker(path);
  if (previous) return previous;
  const token = randomUUID();
  const temporary = join(directory, `.${token}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(token);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return token;
}

export function leaseIndex(root) {
  const index = join(root, ".leases.sqlite");
  const cacheId = createHash("sha256").update(root).digest("hex");
  const transact = (action, signal) => withCacheTransaction(index, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS leases (
      path TEXT NOT NULL, digest TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY (path, digest)
    )`);
    return action(db);
  }, signal);

  async function active(db) {
    const rows = db.prepare("SELECT path, digest, token, expires FROM leases").all();
    const markers = new Map();
    const retained = new Set();
    const remove = db.prepare("DELETE FROM leases WHERE path = ? AND digest = ?");
    let removedLeases = 0;
    const now = Date.now();
    for (const row of rows) {
      if (row.expires > now) {
        if (!markers.has(row.path)) markers.set(row.path, await marker(row.path));
        if (markers.get(row.path) === row.token) {
          retained.add(row.digest);
          continue;
        }
      }
      remove.run(row.path, row.digest);
      removedLeases++;
    }
    return { retained, removedLeases };
  }

  return {
    transact,
    active,
    async workspace(directory, ttlMs = defaultLeaseMs) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > Number.MAX_SAFE_INTEGER - Date.now()) {
        throw new RangeError("Lease TTL must be a positive duration in milliseconds");
      }
      const workspace = await realpath(directory);
      if (!(await lstat(workspace)).isDirectory()) throw new TypeError("Lease workspace must be a directory");
      const path = join(workspace, leaseDirectory, `${cacheId}.lease`);
      return {
        path,
        async retain(db, digest) {
          const token = await ensureMarker(path);
          db.prepare(`INSERT INTO leases VALUES (?, ?, ?, ?)
            ON CONFLICT(path, digest) DO UPDATE SET token = excluded.token,
              expires = CASE WHEN leases.token = excluded.token THEN MAX(leases.expires, excluded.expires) ELSE excluded.expires END`)
            .run(path, digest, token, Date.now() + ttlMs);
        },
        renew: () => transact(async (db) => {
          const token = await marker(path);
          if (!token) return 0;
          const now = Date.now();
          const { changes } = db.prepare("UPDATE leases SET expires = MAX(expires, ?) WHERE path = ? AND token = ? AND expires > ?")
            .run(now + ttlMs, path, token, now);
          return Number(changes);
        }),
        release: () => transact(async (db) => {
          if (await marker(path)) await rm(path, { force: true });
          return Number(db.prepare("DELETE FROM leases WHERE path = ?").run(path).changes);
        }),
      };
    },
  };
}
