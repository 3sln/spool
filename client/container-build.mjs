import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MiB = 1024 ** 2;
const infoFormat = {
  docker: "{{.NCPU}} {{.MemTotal}}",
  podman: "{{.Host.CPUs}} {{.Host.MemTotal}}",
};

async function selectEngine(resources, directory, engines, image, signal) {
  const disk = await statfs(directory);
  if (disk.bavail * disk.bsize < (resources.disk_mib ?? 0) * MiB) {
    throw new Error(`Layer build requires ${resources.disk_mib} MiB of free scratch disk`);
  }
  const failures = [];
  for (const engine of engines) {
    signal?.throwIfAborted();
    try {
      const probe = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const { stdout } = await exec(engine, ["info", "--format", infoFormat[engine]], {
        signal: probe,
      });
      const [cpu, memory] = stdout.trim().split(/\s+/u).map(Number);
      if (!Number.isFinite(cpu) || !Number.isFinite(memory) || cpu < (resources.cpu ?? 1)
        || memory < (resources.memory_mib ?? 1) * MiB) {
        failures.push(`${engine} has ${cpu} CPUs and ${Math.floor(memory / MiB)} MiB of memory`);
        continue;
      }
      if (await exec(engine, ["image", "inspect", image], { signal: probe }).then(() => true, () => false)) return engine;
      failures.push(`${engine} needs the pinned image loaded for linux/amd64`);
    } catch {
      signal?.throwIfAborted();
      failures.push(`${engine} is unavailable`);
    }
  }
  throw new Error(`No local container engine satisfies layer build resources ${JSON.stringify(resources)} (${failures.join("; ")})`);
}

function runBuild(engine, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = Buffer.alloc(0);
    child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(-4096); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve()
      : reject(new Error(stderr.toString("utf8").trim() || `Container exited with status ${code}`)));
  });
}

// The image receives a bounded, read-only snapshot and its own scratch directory.
// Mounted scratch requires a local engine or a desktop VM with the path shared.
export async function buildContainerLayer({
  image, argv, input, resources, timeout, signal,
  engines = (process.env.SPOOL_BUILD_ENGINES ?? "docker,podman").split(",").map((name) => name.trim()),
}, importArchive) {
  if (!Array.isArray(engines) || !engines.length || engines.some((name) => !Object.hasOwn(infoFormat, name))) {
    throw new TypeError("Build engines must be docker, podman, or an ordered list of both");
  }
  const deadline = AbortSignal.timeout(timeout * 1000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const scratch = await mkdtemp(join(process.env.SPOOL_BUILD_TMPDIR ?? tmpdir(), "spool-layer-build-"));
  const name = `spool-layer-${crypto.randomUUID()}`;
  let engine;
  let launched = false;
  try {
    engine = await selectEngine(resources, scratch, engines, image, signal);
    const source = join(scratch, "input.tar");
    const output = join(scratch, "work");
    await writeFile(source, input(), { flag: "wx", mode: 0o600, signal });
    await mkdir(output, { mode: 0o700 });
    const user = process.getuid === undefined ? [] : ["--user", `${process.getuid()}:${process.getgid()}`];
    launched = true;
    await runBuild(engine, ["run", "--rm", "--name", name, "--pull=never", "--platform=linux/amd64",
      "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
      ...(engine === "podman" && process.getuid?.() ? ["--userns=keep-id"] : []),
      ...user, "--workdir", "/build", "--env", "TMPDIR=/build", "--env", "HOME=/build",
      "--mount", `type=bind,source=${source},target=/inputs.tar,readonly`,
      "--mount", `type=bind,source=${output},target=/build`,
      "--entrypoint", argv[0], image, ...argv.slice(1),
    ], signal);
    return await importArchive(join(output, "layer.tar"), signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!launched) throw error;
    throw new Error(`Container layer build failed: ${error.message}`, { cause: error });
  } finally {
    if (launched) {
      await exec(engine, ["rm", "--force", name], { timeout: 5000 }).catch(() => {});
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
