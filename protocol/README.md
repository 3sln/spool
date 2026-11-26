# Spool 0.1 portable HTTP profile

Discover bases, media types, limits, and authentication at `/.well-known/portable-task-runner`. Use the advertised base exactly. [The HTTP binding](openapi.yaml) and [task schema](manifest.schema.json) describe the wire format. The guest interprets archive names relative to `/workspace`. Paths and command arguments are well-formed Unicode without NUL. The service rejects unknown manifest fields, conflicting descriptors for one digest, and any manifest exceeding the advertised combined layer size.

## Identities and retry

The authenticated principal and `client_request_id` identify one submission for 24 hours after finalization. Repeating the same manifest returns the original resource. Submitting different content with the same key returns HTTP 409. Treat each `task_id` as opaque. A layer's SHA-256 covers the transmitted bytes, including compression. An environment's SHA-256 covers the UTF-8 canonical JSON of `{platform,environment}`. Canonical JSON recursively sorts object keys by UTF-16 code unit, preserves array order, and uses ECMAScript JSON string and integer formatting with no extra whitespace.

The discovery document reports the auth profile. OAuth runners expose [protected-resource metadata](https://www.rfc-editor.org/rfc/rfc9728.html) at `/.well-known/oauth-protected-resource`. Clients can verify credentials with `GET /v1/auth/check`, which returns HTTP 204 after authentication without creating a task.

## Deadlines and states

Every submission supplies a positive `task_timeout_s`. It starts at acceptance and covers layer uploads, queueing, startup, and execution. The runner advertises `limits.max_task_seconds`, which fixes `hard_deadline` at acceptance. The status field `task_deadline` is the requested whole-task deadline. `deadline` is the effective deadline in the current state. While waiting for layers or queueing, it is also bounded by the admission window. An optional `resources.timeout_s` separately limits command runtime. `execution_deadline_limit` gives the latest effective deadline the runner can grant after claiming the task.

The owning principal can `POST /v1/tasks/{id}/extend` with `{"task_timeout_s":600}` to request a deadline 600 seconds after original acceptance. The task must be running before its effective deadline. Requests within the current deadline return the current state. An increase within the fixed limits records a `task.deadline_extended` event. Extending the task leaves an explicitly supplied command timeout in force.

`RUNNING` denotes an exclusive claim and includes sandbox startup. `SUCCEEDED`, `FAILED`, `CANCELLED` and `EXPIRED` are terminal. Cancellation or expiry records the outcome and signals the executor. The coordinator discards results from an expired or cancelled claim. A lost executor can result in `SANDBOX_FAILURE` or deadline expiry. Clients can resubmit with a new request ID.

## Observation

Events are records of `{job_id,sequence,type,time,data}`. The per-task sequence starts at 1. `GET /v1/tasks/{id}/events` tails live events over SSE. Reconnect with `Last-Event-ID` or `cursor` and deduplicate by job ID and sequence. Streams close after about 20 seconds or after terminal replay. Disconnecting leaves the task running. Include `?cursor=0&limit=100` for a JSON page and use `next_cursor` on subsequent calls. `has_more` indicates unread events already available, and `terminal` indicates whether new events can still arrive. Both use the same sequence.

Live `task.stdout` and `task.stderr` events carry UTF-8 chunks and per-channel byte offsets. Spool retains up to 128 KiB or 1,024 log events across the two channels and reports truncation in the terminal result.

## Layer transfers

The initial manifest declares each layer's exact compressed or raw transfer size and SHA-256. The runner checks discovery limits for each layer and the sum before admitting the task. Expanded layer data has a separate budget enforced during extraction.

`layer.required` events and task status carry the pending descriptors and an `upload_plans` map indexed by digest. The plan names the transport, byte limit, expiry and authentication policy. A direct-upload plan includes a same-origin `prepare_url`. POST there to obtain the temporary URLs and completion endpoint. Plans are scoped to one task owner's requested digest.

- `http-put` uploads exact bytes to the runner URL using its existing caller authentication.
- `presigned-put` uploads exact bytes directly to object storage, then POSTs `{"parts":[]}` to the runner's `complete_url`.
- `presigned-multipart` uploads each plan range to its own URL. Take the returned `ETag` for each part, then POST `{"parts":[{"number":1,"etag":"..."}]}` to the runner's `complete_url` in order. The runner completes the provider upload and verifies the assembled content. Retrying a part uses the same range and URL while the plan is valid.

All transfer requests have the content length declared by their plan. Presigned requests omit runner credentials. A transport can supply a separate `bearer_token` scoped to its upload URL, and clients should apply their configured destination policy before using it. Completion requests are authenticated to the runner and can be retried.

The cache is scoped to the tenant and can be evicted. The executor verifies the archived bytes again as they enter the offline guest. Cache retention is advisory and independent of the upload and task deadlines. Missing layers at the admission deadline yield `LAYER_UNAVAILABLE`.

## Artifacts

The runner collects declared regular files in manifest order within the combined `limits.max_artifact_bytes_total` budget. An output that is absent or exceeds the remaining budget is omitted. Artifact listings include the path, byte size, SHA-256 and an authenticated download URL. Downloads are raw byte streams with a `Content-Length` header. They require the owning principal and expire with task history.

## Client transport

Client libraries use this HTTP profile for layer transfer, execution, and event replay. The standalone MCP adapter speaks stdio and calls the same client library, using its local cache to supply layers. A caller can implement the portable protocol without either SDK or MCP.
