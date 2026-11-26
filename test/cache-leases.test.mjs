import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLayerCache, buildDirectoryLayer } from "../client/node.mjs";
import { withCacheTransaction } from "../client/build-cache.mjs";

test("workspace leases survive reopening and retain only live shared layers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spool-leases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  const directory = join(root, "cache");
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(join(first, "input.txt"), "input");
  const base = await openLayerCache(directory);
  const a = await base.forWorkspace(first);
  const b = await openLayerCache(directory, { workspace: second });
  const original = await buildDirectoryLayer(first);
  const layer = await a.put(original);
  assert.deepEqual(await buildDirectoryLayer(first), original);
  assert.equal((await stat(a.leasePath)).isFile(), true);
  assert.equal(await b.retain(layer.digest), true);
  assert.equal(await base.delete(layer.digest), false);

  const stale = await b.put(Uint8Array.of(1));
  const lost = await a.put(Uint8Array.of(2));
  const unleased = await base.put(Uint8Array.of(3));
  await withCacheTransaction(join(directory, ".leases.sqlite"), (db) => {
    db.prepare("UPDATE leases SET expires = 1 WHERE digest = ?").run(stale.digest);
    db.prepare("UPDATE leases SET expires = ? WHERE path = ? AND digest = ?").run(Date.now() + 60_000, a.leasePath, layer.digest);
  });

  const reopened = await openLayerCache(directory, { workspace: first });
  assert.equal(reopened.leasePath, a.leasePath);
  assert.equal(await reopened.renew(), 2);
  await rm(a.leasePath);
  await assert.rejects(stat(a.leasePath), { code: "ENOENT" });
  const cleaned = await base.gc();
  assert.deepEqual(new Set(cleaned.removedLayers), new Set([stale.digest, lost.digest, unleased.digest]));
  assert.equal(cleaned.removedLeases, 3);
  assert.deepEqual(await base.list(), [layer.digest]);
  assert.equal(await b.release(), 1);
  assert.deepEqual((await base.gc()).removedLayers, [layer.digest]);
  assert.deepEqual(await base.list(), []);
});

test("publish and GC coordinate across separately opened caches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spool-lease-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  const cache = await openLayerCache(cacheDir, { workspace: root });
  const collector = await openLayerCache(cacheDir);
  const input = join(root, "input.tar");
  await writeFile(input, Buffer.alloc(1024 * 1024, 4));
  const [layer] = await Promise.all([cache.importFile(input), collector.gc(), collector.gc()]);
  assert.deepEqual(await collector.list(), [layer.digest]);
  assert.equal((await cache.open(layer)).size, layer.size);
  assert.equal(await cache.release(), 1);
  assert.deepEqual((await collector.gc()).removedLayers, [layer.digest]);
});
