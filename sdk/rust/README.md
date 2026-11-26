# Spool Rust client

`spool-client` implements the Spool HTTP API for blocking Rust applications. Use
it to discover a runner, submit a stable manifest with `task_timeout_s`,
supply the layers it asks for, download verified artifacts, or cancel explicitly.
The crate includes a deterministic OCI workspace layer builder, a durable
filesystem cache, and a replay policy generated from the same Kin source as
the JavaScript SDK.

Pass a header callback to `Client::new` to provide bearer or Access credentials
for each request. A local wait timeout leaves the remote task running. Save the
accepted task ID and keep its layers in the cache to resume the wait. This
binding uses same-origin transfers by default. Add a configured storage
origin with `Client::with_transfer_origin` to use presigned PUT and multipart
plans without sending runner credentials there. For large prepared archives
use `describe_reader` and `Client::upload_file` for streaming from disk.
The JavaScript SDK also compiles JSON Taskfiles.

Use `LayerCache::open(cache_dir)?.for_workspace(workspace, DEFAULT_LEASE_TTL)?`
to retain layers for a workspace. It shares the SQLite index and marker format
with the JavaScript SDK and MCP. Reads and writes refresh that layer's lease.
Use `retain` for an existing digest, `renew` to extend still-valid references,
`release` to return the workspace's references, and `gc` to collect layers
that have no active reference.

Use `Client::events` to tail live events through SSE or `Client::event_page`
to inspect them a page at a time. `Task::deadline` gives the current deadline.
`Client::extend` requests a new total timeout in seconds from original
acceptance, up to the runner's published limits.

The [smoke example](examples/smoke.rs) runs against a configured local runner
using `SPOOL_URL` and `SPOOL_TOKEN`.
