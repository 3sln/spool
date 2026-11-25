import { connectQueue } from "./jetstream.mjs";
import { ociExecutor } from "./oci.mjs";
import { taskPattern } from "./contract.mjs";

const env = process.env;
if (!env.SPOOL_NATS_URL || !env.SPOOL_COORDINATOR_URL || !env.SPOOL_WORKER_TOKEN) {
  throw new Error("Set SPOOL_NATS_URL, SPOOL_COORDINATOR_URL and SPOOL_WORKER_TOKEN");
}
const coordinator = new URL(env.SPOOL_COORDINATOR_URL);
if (coordinator.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(coordinator.hostname)) {
  throw new Error("Use HTTPS for remote coordinator connections");
}

const queue = await connectQueue(env, false);
const executor = ociExecutor(env);
const consumer = await queue.consumer();
const signal = new AbortController();
for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => signal.abort());
const slots = Number(env.SPOOL_CONCURRENCY ?? 1);
if (!Number.isInteger(slots) || slots < 1 || slots > 64) throw new Error("Invalid SPOOL_CONCURRENCY");

async function call(id, action, body) {
  const response = await fetch(new URL(`/internal/${id}/${action}`, coordinator), {
    method: "POST", redirect: "error", headers: {
      authorization: `Bearer ${env.SPOOL_WORKER_TOKEN}`, "content-type": "application/json",
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Coordinator returned ${response.status}`);
  return response.json();
}

async function processMessage(message) {
  let job;
  try { job = queue.decode(message); }
  catch { message.term(); return; }
  if (typeof job?.id !== "string" || !taskPattern.test(job.id) || typeof job.epoch !== "string") {
    message.term();
    return;
  }
  const keepDelivery = setInterval(() => message.working(), 5000);
  try {
    const work = await call(job.id, "claim", { epoch: job.epoch });
    if (work) {
      const task = new AbortController();
      const executionSignal = AbortSignal.any([signal.signal, task.signal, AbortSignal.timeout(Math.max(0, work.expires - Date.now()))]);
      let checking = false;
      const cancellation = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          if (!(await call(job.id, "live", { claim: work.claim })).live) task.abort();
        } catch {
          // Loss of the coordinator is bounded independently by the execution deadline.
        } finally { checking = false; }
      }, 1500);
      let result;
      try { result = await executor(work, executionSignal, job.id); }
      catch (error) { console.error("OCI execution:", error.message); result = { error: "SANDBOX_FAILURE" }; }
      finally { clearInterval(cancellation); }
      await call(job.id, "finish", { claim: work.claim, result });
    }
    message.ack();
  } catch (error) {
    console.error("JetStream delivery:", error.message);
    message.nak(1000);
  } finally { clearInterval(keepDelivery); }
}

async function consume() {
  while (!signal.signal.aborted) {
    try {
      const message = await consumer.next({ expires: 5000 });
      if (message) await processMessage(message);
    } catch (error) {
      if (!signal.signal.aborted) {
        console.error("JetStream pull:", error.message);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

console.log(`Spool JetStream agent running with ${slots} slot(s)`);
try { await Promise.all(Array.from({ length: slots }, consume)); }
finally { await queue.close(); }
