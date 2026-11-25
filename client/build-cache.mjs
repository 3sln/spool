import { setTimeout as sleep } from "node:timers/promises";

async function acquire(db, signal) {
  for (;;) {
    signal?.throwIfAborted();
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (error.code !== "SQLITE_BUSY" && error.errcode !== 5 && error.errno !== 5) throw error;
    }
    await sleep(20 + Math.floor(Math.random() * 40), undefined, { signal });
  }
}

export async function resolveBuild(path, lookup, build, signal) {
  const Database = process.versions.bun ? (await import("bun:sqlite")).Database : (await import("node:sqlite")).DatabaseSync;
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // Each key has its own SQLite file. A process exit releases its write lock;
    // unfinished transactions roll back without a time-based lock takeover.
    await acquire(db, signal);
    db.exec("CREATE TABLE IF NOT EXISTS build (slot INTEGER PRIMARY KEY, descriptor TEXT NOT NULL)");
    const row = db.prepare("SELECT descriptor FROM build WHERE slot = 1").get();
    const prior = row && JSON.parse(row.descriptor);
    if (prior && await lookup(prior)) {
      db.exec("COMMIT");
      return prior;
    }
    signal?.throwIfAborted();
    const descriptor = await build();
    db.prepare("INSERT OR REPLACE INTO build VALUES (1, ?)").run(JSON.stringify(descriptor));
    db.exec("COMMIT");
    return descriptor;
  } finally {
    db.close();
  }
}
