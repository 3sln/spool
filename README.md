# Spool

Spool runs the same portable task manifest on Cloudflare Containers and self-hosted Docker or Podman. Both providers expose the portable HTTP task API. MCP runs over stdio on the client side. Clients keep the authoritative layer bytes and upload on a cache miss. Accepted tasks have durable IDs and continue after a client disconnects.

## Install from release artifacts

Each release builds these assets together and records their SHA-256 checksums.

| Artifact | Contents |
| --- | --- |
| `3sln-spool-<version>.tgz` | Fetch SDK, Node/Bun layer cache, and JSON Taskfile builder |
| `spool-client-<version>.crate` | Native Rust SDK, deterministic layer builder, and local cache |
| `3sln-spool-runner-<version>.tgz` | Self-hosted `spool-runner` CLI, runner library, Cloudflare Worker, and guest recipe |
| `3sln-spool-mcp-<version>.tgz` | Standalone `spool-mcp` CLI for stdio MCP |
| `spool-guest-<version>-linux-amd64.tar.gz` | Prebuilt OCI guest image for a compatible engine |

Install npm tarballs with `npm install ./<file>.tgz`; add `-g` to put the CLIs
on your PATH. Unpack the Rust crate and use a Cargo path dependency for local
installation. To use the prebuilt guest, run `docker load -i <image>.tar.gz`.
The runner can also build the guest with `spool-runner guest-build`.

## Self-hosted

Use Node 22.13+ or Bun 1.3+ and a Docker engine with Linux/amd64 support. An installed runner starts with `spool-runner serve`. The following commands use the source checkout. On Apple silicon that requires amd64 emulation. Spool ships the portable guest image recipe. The engine and Linux VM are platform dependencies.

```sh
npm run guest:build
export SPOOL_TOKEN="$(openssl rand -hex 32)"
npm start
```

In another terminal, run `SPOOL_TOKEN=<same-token> npm run smoke`. The smoke client builds and caches a layer, submits over HTTP, uploads the layer on request, replays SSE, and verifies the artifact. Set `SPOOL_URL` to test a remote provider.

The default listener is `127.0.0.1:8787` and the SQLite store lives at `.spool/spool.sqlite`. Set `SPOOL_DB` to use a durable volume. For Bun run `bun src/node.mjs`. For a Podman evaluation, build the image with `podman build --platform linux/amd64 -t spool-guest:0.1.0 guest` and set `SPOOL_OCI_ENGINE=podman`. Set `SPOOL_OCI_IMAGE` to use a trusted prebuilt copy. A reverse proxy can terminate TLS for remote clients. Browser requests require a comma-separated allowlist in `SPOOL_ALLOWED_ORIGINS`.

## Authentication

| Mode | Configuration |
| --- | --- |
| Bearer token | `SPOOL_AUTH=token` and random `SPOOL_TOKEN` of at least 24 characters. `SPOOL_TENANT` optionally labels the principal. |
| Cloudflare Zero Trust | `SPOOL_AUTH=access`, `SPOOL_ISSUER=https://<team>.cloudflareaccess.com`, and `SPOOL_AUDIENCE=<application AUD>`. Configure Access for the hostname. Spool verifies the signed Access assertion. |
| Your OAuth issuer | `SPOOL_AUTH=oauth`, `SPOOL_ISSUER`, `SPOOL_JWKS_URL`, `SPOOL_AUDIENCE`, and `SPOOL_PUBLIC_URL` over HTTPS. Issue JWT access tokens with `scope` containing `spool:run` or the configured `SPOOL_OAUTH_SCOPE`. RS256 is the default. Set `SPOOL_JWT_ALGORITHM=ES256` for an ES256 issuer. |
| Custom adapter | Supply `authenticate(Request)` returning `{ issuer, subject }`, a `profile` label, and optional `challenge` and `metadata`. Pass it to the Node `start` override or wire it into the Worker entry point. |

OAuth mode publishes protected-resource metadata. Token issuance, client registration, and consent are the responsibility of the configured issuer. Access mode uses clients that can present Access credentials or use an Access integration. The client library accepts a per-request header callback for refreshed tokens and custom authentication. Tenant keys derive from authenticated issuer and subject.

## Client libraries

Import `@3sln/spool` for the Fetch-based client and byte-level OCI layer builder. Import `@3sln/spool/node` for the Node or Bun filesystem cache and directory builder. The `include` callback can exclude local files before packaging, including entire directories.

```js
import { createClient } from "@3sln/spool";
import { buildDirectoryLayer, openLayerCache } from "@3sln/spool/node";

const cache = await openLayerCache("./prepared-layers");
const client = createClient({
  url: "https://runner.example.com",
  headers: () => ({ Authorization: `Bearer ${process.env.SPOOL_TOKEN}` }),
  layerSource: cache.source,
});
const layer = await cache.put(await buildDirectoryLayer("./prepared-workspace", {
  include: (path) => !path.split("/").some((part) => part.startsWith(".")),
}));
const info = await client.capabilities();
const task = await client.submit({
  protocol_version: "0.1",
  client_request_id: crypto.randomUUID(),
  platform: { os: "linux", arch: "amd64" },
  environment: { base: info.bases[0], layers: [layer] },
  command: { argv: ["python", "main.py"], cwd: "/workspace" },
  resources: { ...info.resource_profile, timeout_s: 30 },
  network: { mode: "none" },
});
const outcome = await client.wait(task.task_id);
```

Pass `previous` to build a directory delta against a prior snapshot. Reproducible tar layers use normalized ownership, timestamps, and executable modes. The byte builder also accepts explicit directory, file, whiteout, and opaque entries. Import prebuilt layers with `cache.put(bytes, mediaType)`. Prepare toolchains and dependencies in a compatible build environment before packaging them. Keep exact cached bytes while any task may reference them. The cache verifies reads against the manifest descriptor and exposes explicit list and delete operations.

`wait` supplies only requested digests and polls until the task finishes. `events` replays and reconnects from the caller's cursor, deduplicating records across connections. Cancel the local wait with an abort signal or cancel the durable remote task explicitly with `client.cancel`. `client.artifacts` and `client.download` list and retrieve results.

Kin generates the event replay policy to JavaScript and Rust. The [Rust SDK](sdk/rust/README.md) includes blocking HTTP, deterministic USTAR layers, a local cache, replay, and artifact verification. JSON Taskfile compilation is in the JavaScript SDK. Regenerate with `npm run client:emit` using sibling Kin and Snug checkouts, or set `SPOOL_KIN_SRC` and `SPOOL_SNUG_KIN_SRC`. The checked-in output runs without Babashka.

## JSON Taskfiles

Check in [a task](examples/taskfiles/check.json), [a reusable base](examples/taskfiles/python-base.json), and the sources or preparation steps that build the layers. The [Taskfile schema](protocol/taskfile.schema.json) describes the format. Bases can extend other bases. The client visits ancestors in the order listed and includes a shared ancestor once. It appends each file's layers in order. Layer IDs identify the recipes within the assembled task. The child can override inherited command or resource fields. Runner requirements accumulate, with exact matches for platform and logical base ID, a union of features, and the highest minimum for each limit.

Call the library to resolve runner capabilities, build the ordered layers, and merge their SHA-256 descriptors into the manifest.

```js
import { runTaskFile } from "@3sln/spool/taskfile";

const { task } = await runTaskFile("./examples/taskfiles/check.json", {
  client, cache,
  requestId: crypto.randomUUID(),
  onAccepted: ({ task_id }) => console.log(task_id),
});
```

The runner returns any missing digests. The client reads those exact bytes from its cache and uploads them. The runner starts after every layer has been verified. Retries use the same request ID and manifest. A caller can persist the accepted task ID and resume waiting with the same client cache. Use `prepareTaskFile` for the merged manifest and descriptors without submitting.

Paths resolve relative to the file declaring them and stay inside the caller's context root. Directory recipes accept a `previous` snapshot and optional subtree exclusions. Archive recipes import prebuilt OCI bytes. Register additional recipe kinds through `layerBuilders` in the library. A custom builder receives the selected platform and base, the runner capabilities, and a scoped path resolver. Reusing a base reuses any byte-identical layers. The submitted manifest records the actual digests produced on the client.

## MCP over stdio

Install `spool-mcp` and initialize the project configuration.

```sh
spool-mcp init --runner http://127.0.0.1:8787 --workspace .
```

The default writes `.mcp.json`. Use `--client cursor` for `.cursor/mcp.json`,
`--config PATH` for a custom JSON config, or `--dry-run` to see the proposed
server entry. Existing entries are preserved. Use `--force` to replace a
conflicting Spool entry. Configure `SPOOL_TOKEN` or the Access service
credentials in the MCP host environment. The generated config contains the
runner origin and startup arguments.

Shared mode uses a per-user disk cache so separate stdio processes share
immutable layers. Use `--state-mode isolated` for a cache that is removed
when the CLI exits or `--state-dir PATH` to point multiple instances at a
specified directory. `SPOOL_STATE_DIR` and `SPOOL_STATE_MODE` work for
hosts that configure the adapter through environment variables. Task state
and event cursors are served by the runner.

`submit_template` compiles a checked-in Taskfile under the workspace root.
Call `wait_task` to satisfy layer requests from disk. Use
`task_artifacts` and `read_artifact` to retrieve results.

## Cloudflare preview

Cloudflare is a preview adapter. Live probes proved layer application and a fixed composed-root diagnostic, and repeated starts also encountered placement failures. Use a Workers account with Containers and R2 enabled, Wrangler, and a working Docker engine. Configure a private custom domain route or an Access-protected hostname. The supplied Wrangler config disables workers.dev and preview URLs.

```sh
wrangler r2 bucket create spool-layers
npm run worker:check
wrangler deploy --secrets-file ./secrets.json
SPOOL_URL=https://<configured-hostname> SPOOL_TOKEN=<same-token> npm run smoke
```

For Access service credentials use `SPOOL_ACCESS_CLIENT_ID` and `SPOOL_ACCESS_CLIENT_SECRET` with the smoke client. The Wrangler config uses the scheduling policy accepted by Wrangler 4.56.0 and caps the app at four VM instances. A SQLite Durable Object queues one running task per tenant. R2 caches layers by tenant and digest. A separate container-bound object starts a fresh VM per attempt, disables Internet access, and destroys the instance afterward. The capability document lists each provider's resource enforcement.

## JetStream workers

The self-hosted coordinator publishes ready task IDs to a durable JetStream consumer. Agents pull one delivery per free execution slot. The coordinator holds task state, layer bytes and claim leases. Agents fetch input and submit results over a private HTTP API. A lost claimed execution expires and can be resubmitted with a new request ID. Spool does not automatically repeat a command after an ambiguous runner failure.

For a disposable single-machine trial, start a broker and install the optional NATS packages.

```sh
docker run --rm -p 127.0.0.1:4222:4222 nats:2.11-alpine -js
npm install
```

Build the guest on each agent host. Share the following settings across the coordinator and agents, with a worker token distinct from the public API token. Start the coordinator with `npm start` and `SPOOL_TOKEN` set. Start each agent with `npm run agent`. Set `SPOOL_CONCURRENCY` for more than one slot per agent.

```sh
export SPOOL_NATS_URL=nats://127.0.0.1:4222
export SPOOL_WORKER_TOKEN=<different-random-secret>
export SPOOL_COORDINATOR_URL=http://127.0.0.1:8787
```

Across hosts, use HTTPS for coordinator calls, a private authenticated TLS connection to NATS, and persistent broker storage. `SPOOL_NATS_URL` accepts comma-separated servers. Provide `SPOOL_NATS_TOKEN` or `SPOOL_NATS_USER` and `SPOOL_NATS_PASSWORD`. `SPOOL_NATS_STREAM` names the deployment's stream and `SPOOL_NATS_REPLICAS` controls replication at creation. Limit proxy access to `/internal/` to trusted agents. One coordinator owns each SQLite database. Replicated metadata and coordinator failover are future work.

## Contract and verification

- [JSON Schema](protocol/manifest.schema.json), [OpenAPI](protocol/openapi.yaml), and [wire semantics](protocol/README.md).
- The execution profile supports Linux/amd64 with a pinned Python 3.13 base and ordered OCI tar or gzip changesets. Regular files, directories, the executable bit, whiteouts, and opaque directories are supported under `/workspace`. Archive links, special files and extended attributes are outside the profile.
- Logs arrive at completion. The first profile uses bounded gateway uploads and a one-hour advisory cache lease. Task history and idempotency are retained for 24 hours after completion. Full-root composition, large direct transfers, warm reuse, live logs, and public multi-tenant hardening are separate gates.
- `npm test` checks the HTTP runner, client cache and SDK, stdio MCP, SQLite, JWT verification and the actual guest code with Python 3. `npm run test:worker` exercises the Worker and SQLite Durable Object in workerd with fixture blob and execution bindings. Set `SPOOL_TOOL_MODULES` to the directory containing the installed workerd and esbuild packages if they are outside the global npm root. `npm run worker:check` also requires Docker. Use `npm run smoke` against a running provider for an integration check.

## Development and release

Run `npm ci && npm test` for the JavaScript tests, `cargo test --locked --manifest-path sdk/rust/Cargo.toml` for Rust, and `npm run test:oci` with a working Docker engine for the integration suite. Set `SPOOL_TEST_RUST=1` to include the Rust client against the same runner. The GitHub verification workflow also runs the Worker fixture, the JetStream worker pool, and tarball installation in a clean consumer.

Run `SPOOL_RELEASE_OCI=1 npm run release:build` to prepare and verify the complete release assets in `dist/`. The GitHub release workflow builds private artifacts by default and can stage a draft prerelease from main. See [development status](DEVLOG.md), [security scope](SECURITY.md), and the [MIT license](LICENSE).
