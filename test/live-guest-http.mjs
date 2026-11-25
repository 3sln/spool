import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultGuestImage, engineCommand } from "../src/oci.mjs";
import { buildLayer, layerDescriptor, TAR } from "../client/index.mjs";

const engine = process.env.SPOOL_OCI_ENGINE ?? "docker";
const image = process.env.SPOOL_OCI_IMAGE ?? defaultGuestImage;
const name = `spool-guest-http-${crypto.randomUUID()}`;
const claim = crypto.randomUUID();
const signal = AbortSignal.timeout(55_000);

try {
  await engineCommand(engine, [
    "run", "--rm", "--detach", "--name", name, "--platform", "linux/amd64", "--pull=never",
    "--publish", "127.0.0.1::8080", image, "http",
  ]);
  const published = (await engineCommand(engine, ["port", name, "8080/tcp"])).trim();
  const url = new URL(`http://${published}`);
  for (;;) {
    const health = await fetch(new URL("/healthz", url), { signal }).catch(() => undefined);
    if (health?.status === 204) break;
    await sleep(200, undefined, { signal });
  }
  const layer = buildLayer([{ path: "input", kind: "file", bytes: Buffer.from("started\n") }]);
  const work = {
    claim, expires: Date.now() + 3 * 86400 * 1000,
    manifest: {
      environment: { layers: [await layerDescriptor(layer, TAR)] }, resources: { timeout_s: 20 },
      command: { argv: ["bash", "-ec", `cat input
id -u
grep NoNewPrivs /proc/$$/status
exec 3<>/dev/tcp/127.0.0.1/8080
printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3
read -r -u 3 response
[[ "$response" == *" 204 "* ]]
exec 3>&-
sleep 3
echo done > output`],
        cwd: "/workspace" },
      outputs: { paths: ["/workspace/output"] },
    },
  };
  const accepted = await fetch(new URL("/start", url), {
    method: "POST", headers: { "content-type": "application/octet-stream" },
    body: new Blob([JSON.stringify(work) + "\n", layer]), signal,
  });
  assert.equal(accepted.status, 202);
  const inspect = (cursor, credential = claim) => fetch(new URL(`/status?cursor=${cursor}`, url), {
    headers: { "x-spool-claim": credential }, signal,
  });
  assert.equal((await inspect(0, crypto.randomUUID())).status, 404);
  let cursor = 0;
  let logs = "";
  let result;
  let sawLiveLogs = false;
  for (;;) {
    const page = await (await inspect(cursor)).json();
    logs += page.logs.map(({ text }) => text).join("");
    cursor = page.cursor;
    if (!page.result && logs.includes("started")) sawLiveLogs = true;
    if (page.result) {
      result = page.result;
      break;
    }
    await sleep(100, undefined, { signal });
  }
  assert.equal(sawLiveLogs, true);
  assert.match(logs, /started\n65532\nNoNewPrivs:\s+1/u);
  assert.equal(result.exit_code, 0);
  assert.equal(Buffer.from(result.artifacts[0].body, "base64").toString(), "done\n");
  assert.deepEqual(await (await inspect(cursor)).json(), { cursor, logs: [], result });
  console.log("Detached native guest launch, live logs, privilege drop and replay passed");
} finally {
  await engineCommand(engine, ["rm", "--force", name]).catch((error) => {
    if (!/no such (container|object)|not found/i.test(error.message)) throw error;
  });
}
