const { DatabaseSync } = process.versions.bun
  ? { DatabaseSync: (await import("bun:sqlite")).Database }
  : await import("node:sqlite");

export function openData(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS blob (key TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  `);
  const select = db.prepare("SELECT value FROM state WHERE key = ?");
  const range = db.prepare("SELECT key, value FROM state WHERE key >= ? AND key < ? ORDER BY key");
  const write = db.prepare("INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const del = db.prepare("DELETE FROM state WHERE key = ?");
  const store = {
    get(key) { const row = select.get(key); return row && JSON.parse(row.value); },
    list(prefix) { return range.all(prefix, prefix + "\uffff").map(({ key, value }) => [key, JSON.parse(value)]); },
    commit(entries, removes = []) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [key, value] of Object.entries(entries)) write.run(key, JSON.stringify(value));
        for (const key of removes) del.run(key);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const hasBlob = db.prepare("SELECT 1 FROM blob WHERE key = ?");
  const getBlob = db.prepare("SELECT bytes FROM blob WHERE key = ?");
  const putBlob = db.prepare("INSERT OR IGNORE INTO blob VALUES (?, ?)");
  const deleteBlob = db.prepare("DELETE FROM blob WHERE key = ?");
  const blobs = {
    has(key) { return Boolean(hasBlob.get(key)); },
    get(key) { return getBlob.get(key)?.bytes; },
    put(key, bytes) { putBlob.run(key, bytes); },
    delete(key) { deleteBlob.run(key); },
  };
  return { store, blobs, close: () => db.close() };
}
