# Runner core

`@3sln/spool-runner/core` uses Fetch, Web Streams, Web Crypto, and timers. Your
host supplies the HTTP server, persistent providers, and executor. The standard
Node and Workers entry points are available when you want managed wiring.

```js
import { createRunnerCore } from "@3sln/spool-runner/core";

const { fetch, service } = createRunnerCore({
  auth: myAuth,
  store: myStateStore,
  layers: myLayerStore,
  artifacts: myArtifactStore,
  execution: {
    network: "isolated-network-namespace",
    cpu: "cgroup-quota",
    memory: "cgroup-limit",
    disk: "workspace-quota",
  },
  limits: { max_task_seconds: 3600, max_active_tasks_per_tenant: 4 },
  concurrency: 2,
});

// Mount fetch(request) as the public handler.
// Call dispatchReady on startup and on a recurring timer or scheduler wake.
async function dispatchReady() {
  const ready = await service.sweep();
  await Promise.all(ready.map(({ id }) => service.run(id, myExecutor)));
}
```

Set `execution` to describe the controls your executor actually enforces.
`limits` overrides supported values from the exported `LIMITS` defaults. The
core uses these values for admission, upload sizes, deadlines, logs, and
retention. Limits can tighten the fixed manifest fields. The current wire
profile offers the Linux/amd64 workspace base and no external network. The
core factory's fixed executor profile offers one CPU and 256 MiB of task
memory. Executors must enforce the advertised profile.

## Providers

Provider methods can be synchronous or asynchronous except `transfers.kind`,
which returns its upload kind synchronously.

| Option | Contract |
| --- | --- |
| `auth` | `profile` identifies the auth scheme. `authenticate(request)` returns a verified `{ issuer, subject }` or throws a `Fault`. Optional `challenge` and `metadata` supply the HTTP challenge and OAuth discovery document. |
| `store` | `get(key)` returns a detached value or `undefined`. `list(prefix)` returns detached `[key, value]` pairs. `commit(entries, removes)` atomically applies the object of entries and optional array of deleted keys. Reads must see completed commits. The state values are core-owned records. |
| `layers` | `has(key)`, `delete(key)`, and either `open(key)` or `get(key)`. Reads return a fresh byte stream, byte array, or `undefined`. If gateway uploads are advertised, supply either `put(key, bytes)` for bytes the core verifies or `putVerified(key, request, descriptor)` to verify and persist the stream yourself. |
| `artifacts` | Optional `open(key)`, `delete(key)`, and `putVerified(key, request, descriptor)`. The input exposes a byte stream through `body` and may carry an abort signal. The executor stages declared outputs before reporting completion. |
| `transfers` | Optional direct-upload provider described below. |
| `wake`, `stop` | `wake(job)` schedules a future sweep. It may run before the state transition commits. `stop(id, claim)` signals cancellation or expiry to an external executor. Keep both callbacks idempotent and avoid calling back into the service while awaiting them. |

Streaming writers must verify both the exact byte count and SHA-256 digest
before exposing bytes. Storage keys are opaque, deletes must tolerate missing
objects, and retries must preserve bytes already published under the same key.
With no artifact provider, executors can return small inline artifacts using
`{ path, body }`, where `body` is base64. Inline output is capped at 512 KiB
across the task and by the configured artifact budget.

With an artifact provider and a layer provider that implements `putVerified`, the core can seed the layer cache from a previous task's archive artifact in the same tenant.

An artifact provider can implement `presignDownload(key, expiresAtMs)` to issue a short-lived HTTPS GET URL for the verified object. Return `undefined` when the artifact needs an authenticated gateway download.

Gateway PUT is the default. A transfer provider defaults to advertising
`presigned-put` and `presigned-multipart`. Set `limits.uploads` for a subset or
to offer gateway PUT alongside them.

- `kind(size)` chooses one advertised upload transport.
- `create({ storage, size })` provisionally opens a direct upload and returns
  provider metadata to persist with the core's `storage` key and expiry.
- `plan(stage, descriptor)` returns the wire offer, including the upload URL
  or ordered parts and authentication requirements. The core adds the
  authenticated completion URL.
- `confirm(stage, descriptor, parts)` checks exact size and digest, completes
  multipart if applicable, and returns a key readable through `layers`.
  Published bytes must be protected from replay of the upload URL.
- `discard(stage)` cleans up abandoned upload resources. Preserve
  `stage.keep` when it points at the published bytes.

The [HTTP contract](README.md) describes the upload plan fields.

## Scheduling and claim ownership

Run **one active core instance per state partition**. Its state machine
serializes the read, check, and commit of each claim within that instance. A
store's atomic batch writes preserve task and index changes. Multiple live
coordinators against the same partition require coordination at the host
level. Route the partition to one owner and fence the old owner before failover.

For in-process execution, call `service.run(id, executor)` with an executor of
the following shape.

```js
async function executor(work, signal, taskId, log, readLayer, stageArtifact) {
  // Apply the layers from readLayer(index) and run inside your sandbox.
  // Observe signal and enforce work.expires as an absolute deadline in ms.
  // Report progress with await log({ channel: "stdout", text: "..." }).
  // Await stageArtifact({ path, size, digest }, byteStream) for each output.
  return { exit_code: 0 };
}
```

For a queue or remote execution service, dispatch the `{ id, epoch }` pairs
returned by `service.sweep()`. The coordinator calls `service.claim(id, epoch)`
for the worker before execution. A winning claim returns work and an opaque
claim token. Pass that token to `service.executionLayer`, `service.log`,
`service.stageArtifact`, and `service.finish`. Duplicate or stale queue epochs
fail to claim. Writes after cancellation, expiry, or a mismatched claim are
rejected. The host is responsible for authenticating its internal worker
transport and for stopping the actual sandbox.

Run sweeps after startup and while work or retention timers are outstanding.
`service.nextAlarm()` supplies an absolute timestamp for hosts that schedule
alarms, or `Infinity` when there is no pending work. External workers can poll
`service.liveClaim(id, claim)` to observe cancellation or the effective
deadline. `work.expires` is the hard execution deadline, including room for a
client extension. Tasks with a lost executor expire so another actor cannot
silently repeat an ambiguous execution.

## Split HTTP front end

For a front end that routes tenants to different coordinators,
`createRunnerHandler({ auth, execution, limits, origins, dispatch })` exposes
discovery and authenticates requests before calling `dispatch(request, tenant)`.
The tenant is derived from the verified identity. Forward it across a trusted
internal boundary. An internal coordinator can use
`dispatchTaskRequest(request, tenant, service)` for task routes. Keep this
internal handler behind authentication, and advertise the same policy at the
front end and coordinator.
