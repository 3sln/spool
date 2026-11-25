# Spool 0.1 portable HTTP profile

Discover bases, media types, limits, and authentication at `/.well-known/portable-task-runner`. Use the advertised base exactly. [The HTTP binding](openapi.yaml) and [task schema](manifest.schema.json) describe the wire format. The guest interprets archive names relative to `/workspace`. Paths and command arguments are well-formed Unicode without NUL. The service rejects unknown manifest fields, conflicting descriptors for one digest, and any manifest exceeding the advertised combined layer size.

## Identities and retry

The authenticated principal and `client_request_id` identify one submission for 24 hours after finalization. Repeating the same manifest returns the original resource. Submitting different content with the same key returns HTTP 409. Treat each `task_id` as opaque. A layer's SHA-256 covers the transmitted bytes, including compression. An environment's SHA-256 covers the UTF-8 canonical JSON of `{platform,environment}`. Canonical JSON recursively sorts object keys by UTF-16 code unit, preserves array order, and uses ECMAScript JSON string and integer formatting with no extra whitespace.

## States, leases, and events

`WAITING_FOR_LAYER` and `QUEUED` share an admission deadline. `RUNNING` denotes an exclusive claim, including sandbox startup, with a new execution lease. `SUCCEEDED`, `FAILED`, `CANCELLED` and `EXPIRED` are terminal. Cancellation records the outcome immediately and signals the executor. The coordinator discards results received after cancellation or lease expiry. A lost executor produces a terminal `SANDBOX_FAILURE`. Clients can resubmit with a new request ID.

Events are records of `{job_id,sequence,type,time,data}`. The per-task sequence starts at 1. Reconnect to the SSE endpoint with `Last-Event-ID` or `cursor` and deduplicate by job ID and sequence. Streams close after about 20 seconds or after terminal replay. Disconnecting has no effect on the job. Logs are UTF-8 chunks recorded at completion with per-channel byte offsets.

`layer.required` carries pending descriptors, a nonce, deadline and upload flow. Obtain the upload capability per digest and PUT the exact bytes with caller authentication. Replaying an accepted upload during its lease is idempotent. Cache entries are scoped to the tenant and can be evicted. A task re-requests a missing entry before a claim. A cache lease is advisory and separate from the upload and execution leases. Missing layers at the admission deadline yield `LAYER_UNAVAILABLE`. Artifact downloads require the owning principal and expire with task history.

## Client transport

Client libraries use this HTTP profile for layer transfer, execution, and event replay. The standalone MCP adapter speaks stdio and calls the same client library, using its local cache to supply layers. A caller can implement the portable protocol without either SDK or MCP.
