# Spool Rust client

`spool-client` implements the Spool HTTP API for blocking Rust applications. Use
it to discover a runner, submit a stable manifest, supply the layers it asks
for, replay events, download verified artifacts, or cancel explicitly.
The crate includes a deterministic OCI workspace layer builder, a durable
filesystem cache, and a replay policy generated from the same Kin source as
the JavaScript SDK.

Pass a header callback to `Client::new` to provide bearer or Access credentials
for each request. A local wait timeout leaves the remote task running. Save the
accepted task ID and keep its layers in the cache to resume the wait. This
binding uses same-origin transfers. The JavaScript SDK also compiles JSON
Taskfiles.

The [smoke example](examples/smoke.rs) runs against a configured local runner
using `SPOOL_URL` and `SPOOL_TOKEN`.
