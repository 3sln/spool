import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { consumeGuest } from "./guest-wire.mjs";
import { workChunks } from "./work-stream.mjs";
import pkg from "../package.json" with { type: "json" };

export const defaultGuestImage = `spool-guest:${pkg.version}`;

export const EXECUTION = {
  network: "engine-network-none-with-loopback", cpu: "engine-quota",
  memory: "engine-cgroup-and-process-address-space", disk: "workspace-tmpfs-or-engine-storage-quota",
};

export function engineCommand(engine, args, { input, signal, timeout = 25_000, consume } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let out = 0;
    let err = 0;
    if (!consume) child.stdout.on("data", (data) => {
      out += data.length;
      if (out > 2 * 1024 ** 2) child.kill("SIGKILL");
      else stdout.push(data);
    });
    child.stderr.on("data", (data) => {
      err += data.length;
      if (err <= 8192) stderr.push(data);
    });
    const streaming = consume ? consume(Readable.toWeb(child.stdout))
      .catch((error) => { child.kill(); reject(error); }) : undefined;
    if (input?.[Symbol.asyncIterator]) {
      pipeline(Readable.from(input), child.stdin).catch((error) => {
        if (!["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) {
          child.kill();
          reject(error);
        }
      });
    } else {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`OCI engine exited with ${code}: ${Buffer.concat(stderr).toString().slice(0, 1024)}`));
      else resolve(streaming ?? Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export function ociExecutor(env) {
  const engine = env.SPOOL_OCI_ENGINE ?? "docker";
  const image = env.SPOOL_OCI_IMAGE ?? defaultGuestImage;
  const workspaceDriver = env.SPOOL_WORKSPACE_DRIVER ?? "tmpfs";
  if (workspaceDriver !== "tmpfs" && workspaceDriver !== "quota") throw new Error("Invalid SPOOL_WORKSPACE_DRIVER");
  return async (work, signal, id, onLog, readLayer) => {
    const name = `spool-${id}-${work.claim.slice(0, 8)}`;
    const workspace = work.manifest.resources.disk_mib;
    const quota = workspaceDriver === "quota";
    const memory = quota ? 384 : 384 + workspace;
    const mounts = quota ? ["--storage-opt", `size=${workspace}m`] :
      ["--read-only", "--tmpfs", `/workspace:rw,nosuid,nodev,size=${workspace}m,mode=0755,uid=65532,gid=65532`];
    try {
      if (signal.aborted) return { error: "CANCELLED" };
      await engineCommand(engine, [
        "create", "--rm", "--interactive", "--name", name, "--label", "org.3sln.spool.job=true", "--pull=never",
        "--platform=linux/amd64", "--network=none", "--ipc=none", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--user=65532:65532", "--pids-limit=80", "--cpus=1",
        `--memory=${memory}m`, `--memory-swap=${memory}m`, ...mounts,
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
        "--", image, "stdio-stream",
      ]);
      if (signal.aborted) return { error: "CANCELLED" };
      return await engineCommand(engine, ["start", "--attach", "--interactive", name], {
        input: workChunks(work, readLayer), signal, timeout: Math.max(1, work.expires - Date.now()),
        consume: (body) => consumeGuest(new Response(body, { headers: { "content-type": "application/x-ndjson" } }), onLog),
      });
    } finally {
      try { await engineCommand(engine, ["rm", "--force", name]); }
      catch (error) {
        if (!/no such (container|object)|not found/i.test(error.message)) throw error;
      }
    }
  };
}
