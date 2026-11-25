import { spawn } from "node:child_process";
import pkg from "../package.json" with { type: "json" };

export const defaultGuestImage = `spool-guest:${pkg.version}`;

export const EXECUTION = {
  network: "engine-network-none", cpu: "engine-quota", memory: "engine-cgroup",
  disk: "64-MiB-workspace-tmpfs-plus-bounded-tmpfs",
};

export function engineCommand(engine, args, { input, signal, timeout = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let out = 0;
    let err = 0;
    child.stdout.on("data", (data) => {
      out += data.length;
      if (out > 2 * 1024 ** 2) child.kill("SIGKILL");
      else stdout.push(data);
    });
    child.stderr.on("data", (data) => {
      err += data.length;
      if (err <= 8192) stderr.push(data);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`OCI engine exited with ${code}: ${Buffer.concat(stderr).toString().slice(0, 1024)}`));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export function ociExecutor(env) {
  const engine = env.SPOOL_OCI_ENGINE ?? "docker";
  const image = env.SPOOL_OCI_IMAGE ?? defaultGuestImage;
  return async (work, signal, id) => {
    const name = `spool-${id}-${work.claim.slice(0, 8)}`;
    try {
      if (signal.aborted) return { error: "CANCELLED" };
      await engineCommand(engine, [
        "create", "--rm", "--interactive", "--name", name, "--label", "org.3sln.spool.job=true", "--pull=never",
        "--platform=linux/amd64", "--network=none", "--read-only", "--ipc=none", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--user=65532:65532", "--pids-limit=80", "--cpus=1",
        "--memory=256m", "--memory-swap=256m",
        "--tmpfs", "/workspace:rw,nosuid,nodev,size=64m,mode=0755,uid=65532,gid=65532",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
        "--", image, "stdio",
      ]);
      if (signal.aborted) return { error: "CANCELLED" };
      const result = await engineCommand(engine, ["start", "--attach", "--interactive", name], {
        input: JSON.stringify(work), signal, timeout: work.manifest.resources.timeout_s * 1000 + 35_000,
      });
      return JSON.parse(result);
    } finally {
      try { await engineCommand(engine, ["rm", "--force", name]); }
      catch (error) {
        if (!/no such (container|object)|not found/i.test(error.message)) throw error;
      }
    }
  };
}
