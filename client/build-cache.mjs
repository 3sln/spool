import { setTimeout as sleep } from "node:timers/promises";

async function execWhenReady(db, statement, signal) {
  for (;;) {
    signal?.throwIfAborted();
    try {
      db.exec(statement);
      return;
    } catch (error) {
      if (error.code !== "SQLITE_BUSY" && error.errcode !== 5 && error.errno !== 5) throw error;
    }
    await sleep(20 + Math.floor(Math.random() * 40), undefined, { signal });
  }
}

export async function withCacheTransaction(path, action, signal) {
  const Database = process.versions.bun ? (await import("bun:sqlite")).Database : (await import("node:sqlite")).DatabaseSync;
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // Each key has its own SQLite file. A process exit releases its write lock;
    // unfinished transactions roll back without a time-based lock takeover.
    await execWhenReady(db, "BEGIN IMMEDIATE", signal);
    const result = await action(db);
    // SQLite can briefly retain readers when a writer commits. Complete the
    // transaction even if cancellation arrived after a filesystem mutation.
    await execWhenReady(db, "COMMIT");
    return result;
  } finally {
    db.close();
  }
}

export async function resolveBuild(path, lookup, build, signal) {
  return withCacheTransaction(path, async (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS build (slot INTEGER PRIMARY KEY, descriptor TEXT NOT NULL)");
    const row = db.prepare("SELECT descriptor FROM build WHERE slot = 1").get();
    const prior = row && JSON.parse(row.descriptor);
    if (prior && await lookup(prior)) return prior;
    signal?.throwIfAborted();
    const descriptor = await build();
    db.prepare("INSERT OR REPLACE INTO build VALUES (1, ?)").run(JSON.stringify(descriptor));
    return descriptor;
  }, signal);
}
