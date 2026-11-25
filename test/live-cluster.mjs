import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createClient, buildLayer, layerDescriptor } from "../client/index.mjs";
import { start } from "../src/node.mjs";
import { defaultGuestImage } from "../src/oci.mjs";

const nats = process.env.SPOOL_NATS_URL ?? "nats://127.0.0.1:4222";
const token = crypto.randomUUID();
const stream = `SPOOL_TEST_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const workerToken = crypto.randomUUID();
const local = await start({
  SPOOL_TOKEN: token, SPOOL_WORKER_TOKEN: workerToken, SPOOL_NATS_URL: nats, SPOOL_NATS_STREAM: stream, SPOOL_DB: ":memory:", PORT: "0",
});
const url = `http://127.0.0.1:${local.server.address().port}`;
const agents = [];
const scratch = await mkdtemp(join(tmpdir(), "spool-agents-"));
const logs = join(scratch, "distribution.log");
try {
  const ready = [];
  for (const id of [1,2]) {
    const engine = join(scratch, `docker-agent-${id}`);
    await writeFile(engine, `#!/bin/sh
if [ "$1" = create ]; then printf '%s\\n' agent-${id} >> '${logs}'; fi
exec docker "$@"
`, {mode:0o700});
    const agent = spawn(process.execPath, ["src/agent.mjs"], {
      env: {...process.env, SPOOL_NATS_URL:nats, SPOOL_NATS_STREAM:stream, SPOOL_WORKER_TOKEN:workerToken, SPOOL_COORDINATOR_URL:url,
        SPOOL_OCI_IMAGE:process.env.SPOOL_OCI_IMAGE ?? defaultGuestImage, SPOOL_OCI_ENGINE:engine},
      stdio:["ignore","pipe","inherit"],
    });
    agents.push(agent);
    ready.push(new Promise((done,reject)=>{
      agent.stdout.on("data", (chunk) => { if (String(chunk).includes("JetStream agent running")) done(); });
      agent.once("exit", (status) => reject(new Error(`Agent ${id} exited ${status}`)));
    }));
  }
  await Promise.all(ready);
  const marker=crypto.randomUUID();
  const bytes=buildLayer([{kind:"file",path:"marker",bytes:Buffer.from(marker)}]);
  const descriptor=await layerDescriptor(bytes);
  const client=createClient({url,headers:{Authorization:`Bearer ${token}`},layerSource:()=>bytes});
  const signal=AbortSignal.timeout(100_000);
  const advertised=await client.capabilities({signal});
  const inputs=Array.from({length:4},(_,i)=>({
    protocol_version:"0.1",client_request_id:`${marker}-${i}`,platform:{os:"linux",arch:"amd64"},
    environment:{base:advertised.bases[0],layers:[descriptor]},
    command:{argv:["sh","-ec","sleep 2; cat marker > result.txt"],cwd:"/workspace"},
    resources:{...advertised.resource_profile,timeout_s:15},network:{mode:"none"},
    outputs:{paths:["/workspace/result.txt"]},
  }));
  const jobs=await Promise.all(inputs.map((manifest)=>client.submit(manifest,{signal})));
  const done=await Promise.all(jobs.map(({task_id})=>client.wait(task_id,{signal})));
  for (const job of done) {
    assert.equal(job.state,"SUCCEEDED",JSON.stringify(job));
    const {artifacts}=await client.artifacts(job.task_id,{signal});
    assert.equal(artifacts.length,1);
    assert.equal(await (await client.download(artifacts[0],{signal})).text(),marker);
  }
  const placements=(await readFile(logs,"utf8")).trim().split("\n");
  assert.equal(placements.length,done.length);
  assert.deepEqual([...new Set(placements)].sort(),["agent-1","agent-2"]);
  console.log(JSON.stringify({runs:done.map(({task_id,state})=>({task_id,state})), placements}));
} finally {
  for (const agent of agents) if (agent.exitCode === null) agent.kill("SIGTERM");
  await Promise.all(agents.filter((agent)=>agent.exitCode === null).map((agent)=>once(agent,"exit")));
  await local.close();
  await rm(scratch, { recursive:true, force:true });
}
