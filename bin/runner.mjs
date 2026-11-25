#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { defaultGuestImage } from "../src/oci.mjs";

const args = process.argv.slice(2);
const usage = "Usage: spool-runner [serve|agent|guest-build|--version]";
try {
  if (args.length > 1) throw new Error(usage);
  switch (args[0] ?? "serve") {
    case "--help": console.log(usage); break;
    case "--version": console.log(pkg.version); break;
    case "guest-build": {
      const guest = fileURLToPath(new URL("../guest/", import.meta.url));
      const result = spawnSync(process.env.SPOOL_OCI_ENGINE ?? "docker", [
        "build", "--platform", "linux/amd64", "-t", process.env.SPOOL_OCI_IMAGE ?? defaultGuestImage, guest,
      ], { stdio: "inherit" });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      break;
    }
    case "agent": await import("../src/agent.mjs"); break;
    case "serve": {
      const { start } = await import("../src/node.mjs");
      const { server, close } = await start();
      console.log(`Spool listening on ${server.address().address}:${server.address().port}`);
      let closing;
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
          closing ??= close().catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
          });
        });
      }
      break;
    }
    default: throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
