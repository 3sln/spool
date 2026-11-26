import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLayerCache } from "../client/node.mjs";

const sdk = new URL("../client/node.mjs", import.meta.url).href;
const taskfile = new URL("../client/taskfile.mjs", import.meta.url).href;
const wire = new URL("../src/contract.mjs", import.meta.url).href;

function child(script, args) {
  const processChild = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  const notices = new Set();
  let output = "";
  const status = new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("close", (code, signal) => resolve({ code, signal, output }));
  });
  processChild.stdout.setEncoding("utf8");
  processChild.stdout.on("data", (chunk) => {
    output += chunk;
    for (const notify of notices) notify();
  });
  return {
    status, stop: () => processChild.kill("SIGKILL"),
    async until(marker) {
      let notify;
      const found = new Promise((resolve) => {
        notify = () => { if (output.includes(marker)) resolve(); };
        notices.add(notify);
        notify();
      });
      try {
        await Promise.race([found, status.then(() => { throw new Error(`Child exited before ${marker}: ${output}`); })]);
      } finally { notices.delete(notify); }
    },
  };
}

test("identical Taskfile prefixes share one build across separate processes", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spool-single-flight-"));
  const workers = [];
  t.after(async () => {
    for (const job of workers) job.stop();
    await Promise.allSettled(workers.map((job) => job.status));
    await rm(root, { recursive: true, force: true });
  });
  const script = join(root, "build.mjs");
  await writeFile(script, `
    import { appendFile, readFile, stat } from "node:fs/promises";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import { openLayerCache } from ${JSON.stringify(sdk)};
    import { prepareTaskFile } from ${JSON.stringify(taskfile)};
    import { capabilities, sha256 } from ${JSON.stringify(wire)};
    const [, , project, root] = process.argv;
    const cache = await openLayerCache(join(root, "cache"));
    const prepared = await prepareTaskFile(join(project, "task.json"), {
      runner: capabilities("fixture", {}), cache,
      layerBuilders: {
        dependencies: {
          version: "fixture1",
          async fingerprint(recipe, context) {
            const fingerprint = await sha256(await readFile(await context.resolvePath(recipe.input)));
            console.log("fingerprinted");
            return fingerprint;
          },
          async build(recipe, context) {
            if (context.parents.length !== 1) throw new Error("Missing lower layer context");
            await appendFile(join(root, "builders"), "build\\n");
            console.log("building");
            while (!await stat(join(root, "release")).catch(() => null)) await delay(10);
            return { bytes: Uint8Array.of(1, 2, 3), mediaType: "application/vnd.oci.image.layer.v1.tar" };
          },
        },
      },
    });
    console.log(JSON.stringify(prepared.layers));
  `);
  for (const [index, project] of ["alpha", "beta"].entries()) {
    const path = join(root, project);
    const base = index ? "some-other-location" : "base-files";
    await mkdir(join(path, base), { recursive: true });
    await mkdir(join(path, "source"));
    await writeFile(join(path, base, "toolchain"), "identical lower tree");
    await writeFile(join(path, "source", "app.config"), project);
    const input = index ? "different-lockfile-name" : "lockfile";
    await writeFile(join(path, input), "same locked dependency");
    await writeFile(join(path, "task.json"), JSON.stringify({
      version: "0.1", kind: "task", task_timeout_s: 60,
      command: { argv: ["true"] },
      layers: [
        { id: `base-${index}`, kind: "directory", path: base },
        { id: `deps-${index}`, kind: "dependencies", input },
        { id: `app-${index}`, kind: "directory", path: "source" },
      ],
    }));
  }
  const first = child(script, [join(root, "alpha"), root]);
  workers.push(first);
  await first.until("building");
  const second = child(script, [join(root, "beta"), root]);
  workers.push(second);
  await second.until("fingerprinted");
  await writeFile(join(root, "release"), "");
  const [a, b] = await Promise.all(workers.map((job) => job.status));
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  const layers = (result) => JSON.parse(result.output.trim().split("\n").at(-1));
  assert.deepEqual(layers(a).slice(0, 2).map(({ descriptor }) => descriptor), layers(b).slice(0, 2).map(({ descriptor }) => descriptor));
  assert.notEqual(layers(a)[2].descriptor.digest, layers(b)[2].descriptor.digest);
  assert.equal(await readFile(join(root, "builders"), "utf8"), "build\n");
  assert.equal((await readdir(join(root, "cache", ".builds"))).length, 4);

  const cache = await openLayerCache(join(root, "cache"));
  await cache.delete(layers(a)[1].descriptor.digest, { force: true });
  const rebuilt = child(script, [join(root, "alpha"), root]);
  workers.push(rebuilt);
  assert.equal((await rebuilt.status).code, 0);
  assert.equal(await readFile(join(root, "builders"), "utf8"), "build\nbuild\n");
});

test("the next client can take over after a builder process dies", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spool-reclaim-"));
  const script = join(root, "claim.mjs");
  const key = `sha256:${"a".repeat(64)}`;
  await writeFile(script, `
    import { setTimeout as delay } from "node:timers/promises";
    import { openLayerCache } from ${JSON.stringify(sdk)};
    const cache = await openLayerCache(process.argv[2]);
    await cache.resolveBuild(process.argv[3], async () => {
      console.log("locked");
      await delay(30000);
    });
  `);
  const owner = child(script, [root, key]);
  t.after(async () => {
    owner.stop();
    await owner.status;
    await rm(root, { recursive: true, force: true });
  });
  await owner.until("locked");
  const cache = await openLayerCache(root);
  let built = false;
  const waiting = cache.resolveBuild(key, () => {
    built = true;
    return { bytes: Uint8Array.of(9), mediaType: "application/vnd.oci.image.layer.v1.tar" };
  }, { signal: AbortSignal.timeout(5_000) });
  assert.equal(built, false);
  owner.stop();
  assert.equal((await owner.status).signal, "SIGKILL");
  const result = await waiting;
  assert.equal(built, true);
  assert.deepEqual([...await cache.source(result)], [9]);
});
