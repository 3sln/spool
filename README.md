# Spool

Spool runs the same portable task manifest on Cloudflare Containers and self-hosted Docker or Podman. Both providers expose the portable HTTP task API. MCP runs over stdio on the client side. On a runner cache miss, the client can upload a layer or give the runner a URL to fetch it. Accepted tasks have durable IDs and continue after a client disconnects.

## Install from release artifacts

Install the MCP CLI with `npm install -g @3sln/spool-mcp`. It exposes the
`spool-mcp` command. The GitHub archives contain standalone executables for
Linux, macOS, and Windows on x64 and ARM64.

Each release builds these assets together and records their SHA-256 checksums.

| Artifact | Contents |
| --- | --- |
| `3sln-spool-client-<version>.tgz` | Fetch SDK, Node/Bun layer cache, and JSON Taskfile builder |
| `spool-client-<version>.crate` | Native Rust SDK, deterministic layer builder, and local cache |
| `3sln-spool-runner-<version>.tgz` | Self-hosted `spool-runner` CLI, runner library, Cloudflare Worker, and guest recipe |
| `3sln-spool-mcp-<version>.tgz` | Node-based `spool-mcp` CLI for stdio MCP |
| `spool-mcp-<version>-<platform>.tar.gz` or `.zip` | Standalone `spool-mcp` executable |

Install npm tarballs with `npm install ./<file>.tgz`; add `-g` to put the CLIs
on your PATH. Unpack the Rust crate and use a Cargo path dependency for local
installation. Build the runner's OCI guest with `spool-runner guest-build`.

## Self-hosted

Embed `start` from `@3sln/spool-runner/node` in a Node or Bun application, or use the optional `spool-runner` CLI. It uses SQLite for coordination, the configured local or S3 layer cache, and an OCI executor. A host application can pass a custom authentication adapter to `start(env, { auth })`.

Use Node 22.13+ or Bun 1.3+ and a Docker engine with Linux/amd64 support. An installed runner starts with `spool-runner serve`. The following commands use the source checkout. On Apple silicon that requires amd64 emulation. Spool ships the portable guest image recipe. The engine and Linux VM are platform dependencies.

```sh
bb guest-build
export SPOOL_TOKEN="$(openssl rand -hex 32)"
bb serve
```

In another terminal, run `SPOOL_TOKEN=<same-token> bb smoke`. The smoke client builds and caches a layer, submits over HTTP, uploads the layer on request, replays SSE, and verifies the artifact. Set `SPOOL_URL` to test a remote provider.

The default listener is `127.0.0.1:8787`. The SQLite metadata store lives at `.spool/spool.sqlite` and the filesystem layer cache is next to it at `.spool/spool.sqlite.layers`. Put both on durable storage with `SPOOL_DB`. For Bun run `bun src/node.mjs`. For a Podman evaluation, build the image with `podman build --platform linux/amd64 -t spool-guest:0.1.0 guest` and set `SPOOL_OCI_ENGINE=podman`. Set `SPOOL_OCI_IMAGE` to use a trusted prebuilt copy. A reverse proxy can terminate TLS for remote clients. Browser requests require a comma-separated allowlist in `SPOOL_ALLOWED_ORIGINS`.

Both providers require a submitter-supplied `task_timeout_s`. It covers everything from acceptance through completion. Runners accept up to seven days by default. Set `SPOOL_MAX_TASK_SECONDS` to a defensible cap for the deployment. Runners advertise the configured cap through discovery. An optional `resources.timeout_s` caps the command itself.

Tasks run offline with loopback available. Prepare dependencies, tools, and input data in the pinned base or in the uploaded layers before submitting the task. Each task has its own writable workspace and temporary files. Host directories and credentials are outside the task sandbox. The runner exposes logs and explicitly declared output files through the task API.

The self-hosted runner defaults to 512 MiB per layer, 2 GiB of uploaded layers per task, and a 4 GiB workspace. Set `SPOOL_MAX_LAYER_MIB`, `SPOOL_MAX_INPUT_MIB`, and `SPOOL_WORKSPACE_MIB` to match the host and workload. The runner rejects unsupported declared sizes at submission. Expanded archive bytes have a separate budget equal to three quarters of workspace capacity. `SPOOL_ADMISSION_SECONDS` sets the upload and queue window, and `SPOOL_STARTUP_SECONDS` sets the sandbox startup allowance. The default tmpfs workspace uses host memory as it fills. For a disk-backed workspace use `SPOOL_WORKSPACE_DRIVER=quota` on an engine with a configured storage quota.

Set `SPOOL_S3_BUCKET` to use an existing private S3-compatible bucket for layers and output artifacts. Use the AWS SDK credential chain on the coordinator and configure `SPOOL_S3_REGION` and an optional HTTPS `SPOOL_S3_ENDPOINT`. The coordinator issues signed uploads and direct artifact download plans. The filesystem and S3 backends both feed verified bytes to the executor in order.

## Authentication

| Mode | Configuration |
| --- | --- |
| Bearer token | `SPOOL_AUTH=token` and random `SPOOL_TOKEN` of at least 24 characters. `SPOOL_TENANT` optionally labels the principal. |
| Cloudflare Zero Trust | `SPOOL_AUTH=access`, `SPOOL_ISSUER=https://<team>.cloudflareaccess.com`, and `SPOOL_AUDIENCE=<application AUD>`. Configure Access for the hostname. Spool verifies the signed Access assertion. |
| Your OAuth issuer | `SPOOL_AUTH=oauth`, `SPOOL_ISSUER`, `SPOOL_JWKS_URL`, `SPOOL_AUDIENCE`, and `SPOOL_PUBLIC_URL` over HTTPS. Issue JWT access tokens with `scope` containing `spool:run` or the configured `SPOOL_OAUTH_SCOPE`. RS256 is the default. Set `SPOOL_JWT_ALGORITHM=ES256` for an ES256 issuer. |
| Custom adapter | Supply `authenticate(Request)` returning `{ issuer, subject }`, a `profile` label, and optional `challenge` and `metadata`. Pass it to the Node `start` override or wire it into the Worker entry point. |

OAuth mode publishes protected-resource metadata. Token issuance, client registration, and consent are the responsibility of the configured issuer. Access mode uses clients that can present Access credentials or use an Access integration. The client library accepts a per-request header callback for refreshed tokens and custom authentication. Tenant keys derive from authenticated issuer and subject.

## Custom runner providers

Import `createRunnerCore` from `@3sln/spool-runner/core` to use Spool's HTTP API and task lifecycle with your own state store, layer cache, artifact store, authentication, and scheduler. It returns a Fetch handler and a task service. Mount the handler in your application and drive the service from your job loop or queue consumer. The turnkey Node SDK also accepts `executor` and `execution` overrides for in-process execution. See the [provider contracts and scheduling examples](protocol/runner-core.md).

## Client libraries

Import `@3sln/spool-client` for the Fetch-based client and byte-level OCI layer builder. Import `@3sln/spool-client/node` for the Node or Bun filesystem cache and directory builder. The `include` callback can exclude local files before packaging, including entire directories.

```js
import { createClient } from "@3sln/spool-client";
import { buildDirectoryLayer, openLayerCache } from "@3sln/spool-client/node";

const cache = await openLayerCache("./prepared-layers", { workspace: "./prepared-workspace" });
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
  task_timeout_s: 300,
  command: { argv: ["sh", "main.sh"], cwd: "/workspace" },
  resources: { ...info.resource_profile },
  network: { mode: "none" },
});
const outcome = await client.wait(task.task_id);
```

Pass `previous` to build a directory delta against a prior snapshot. Reproducible tar layers use normalized ownership, timestamps, and executable modes. The byte builder also accepts explicit directory, file, symlink, whiteout, and opaque entries. For large prepared archives use `cache.importFile(path, mediaType)` and `layerSource: cache.open` to upload from disk. The cache verifies reads against the manifest descriptor.

### Client layer leases

Bind a cache to a workspace with `openLayerCache(path, { workspace })` or `await cache.forWorkspace(workspace)`. Taskfile builds and MCP with a workspace do this automatically. The first use writes a marker under `.spool-leases/` in the workspace and records its absolute path, identity, and each layer's expiry in the shared cache. Put, import, and reads through that workspace refresh the touched layer for seven days by default. Use `leaseTtlMs` on open or `{ ttlMs }` on `forWorkspace` to change the duration. The marker directory is skipped in layer snapshots and belongs in your project's ignore file.

`cache.retain(digest)` claims an existing layer. `cache.renew()` extends the workspace's still-valid references. `cache.release()` returns all its references to that cache and removes its marker. Deleting or moving the workspace also invalidates its references. `cache.gc()` removes a layer once every workspace reference has expired, been returned, or lost its marker. A cache opened without a workspace can run GC and inspect layers. Existing unleased content is eligible for collection, so bind existing projects and retain any contents they still need before the first GC.

For presigned transfers, pass an `allowTransferURL` callback that accepts the configured object storage origin. The SDK omits runner credentials from presigned requests. A browser client also needs bucket CORS to allow its origin and PUT requests and to expose the response `ETag`.

`wait` supplies only requested digests and polls until the task finishes. `client.events` streams live logs and state changes over SSE, resuming from the last cursor. `client.eventPage(id, {cursor, limit})` reads the same events as JSON pages. Check `deadline` and `execution_deadline_limit` in status, then call `client.extend(id, 600)` to ask for a new deadline 600 seconds from original acceptance. Cancel the local wait with an abort signal or cancel the remote task explicitly with `client.cancel`. `client.artifacts` and `client.download` list and retrieve results.

Kin generates the event replay policy to JavaScript and Rust. The [Rust SDK](sdk/rust/README.md) includes blocking HTTP, deterministic USTAR layers, a local cache, replay, and artifact verification. JSON Taskfile compilation is in the JavaScript SDK. Regenerate with `bb client-emit` using sibling Kin and Snug checkouts, or set `SPOOL_KIN_SRC` and `SPOOL_SNUG_KIN_SRC`. The checked-in output runs without Babashka.

## S3 client layer cache and runner pulls

Set `SPOOL_LAYER_PULL_ORIGINS` on the runner to a comma-separated list of trusted HTTPS object storage origins, for example `https://s3.us-east-1.amazonaws.com`. The runner only follows requests to these exact origins, refuses redirects and verifies the byte count and SHA-256 before admitting the layer. `SPOOL_LAYER_PULL_TIMEOUT_SECONDS` defaults to 300 seconds. Gateway PUTs on a Worker with binding-only storage still have a 32 MiB cap. When pulls are enabled the task's layer limit defaults to 512 MiB, and its plans require a pull for layers above the gateway cap.

```sh
spool-mcp run Taskfile.json --profile NAME --s3-cache-bucket my-spool-layers --s3-cache-region us-east-1
spool-mcp init --profile NAME --workspace . --s3-cache-bucket my-spool-layers
```

Use `--s3-cache-endpoint` for a compatible HTTPS service and `--s3-cache-prefix` to change the default `spool/layers` prefix. The corresponding environment variables are `SPOOL_CACHE_S3_BUCKET`, `SPOOL_CACHE_S3_REGION`, `SPOOL_CACHE_S3_ENDPOINT`, and `SPOOL_CACHE_S3_PREFIX`. The CLI uses the AWS SDK credential chain. It signs a short-lived GET for the runner and falls back to a client upload when the runner offers an upload and cannot pull from that origin. Local state still holds recipes and leases. `cache-gc` reclaims local cache files. Use a bucket lifecycle rule to reclaim shared S3 objects.

A Taskfile can reference an existing cache object by digest as `{"id":"dataset","kind":"cached","digest":"sha256:<64 lowercase hex digits>"}`. Objects use the key `<prefix>/<64 lowercase hex digits>`. Supply `media_type` when the object does not have a supported layer media type as its content type. SDK callers can use `openS3LayerCache` from `@3sln/spool-client/s3-cache` and pass `cache.pullPlan` as `layerPullSource`. For a different storage source, use `client.pullLayer(taskId, digest, urlOrPlan)` or the MCP `pull_layer` tool. A plan has a `url`, optional `headers`, and optional `expires_at`. The MCP `supply_layers` tool transfers layers from the configured cache independently of the short `wait_task` polling window.

## JSON Taskfiles

Run `spool-mcp taskfile` for syntax, inheritance rules, and the submission
workflow. `spool-mcp taskfile schema` prints both JSON schemas.
`spool-mcp taskfile example` prints a map of filenames to runnable file
contents. Agents can call `taskfile_help` with `guide`, `schema`, or `example`,
or browse the `spool://taskfile/` MCP resources.

Check in [a task](examples/taskfiles/check.json), [a reusable base](examples/taskfiles/debian-base.json), and the sources or preparation steps that build the layers. The [Taskfile schema](protocol/taskfile.schema.json) describes the format. Bases can extend other bases. The client visits ancestors in the order listed and includes a shared ancestor once. It appends each file's layers in order. Layer IDs identify the recipes within the assembled task. The child can override the inherited task timeout, command, or resource fields. Runner requirements accumulate, with exact matches for platform and logical base ID, a union of features, and the highest minimum for each limit or resource.

Set `requires.resources` on a task or base when it needs more CPU, memory, or workspace disk than the defaults. For example, `"requires": { "resources": { "cpu": 2, "memory_mib": 4096, "disk_mib": 8192 } }`. The compiler checks the runner's advertised profiles before building layers. The runner independently checks the submitted minima before accepting the task. Task status reports the selected profile and effective budgets.

Each locally built container layer can declare separate `build_resources`. Spool checks the local engine's CPU and memory capacity and the scratch filesystem's free space on a cache miss. Set `SPOOL_BUILD_ENGINES` to an ordered list such as `podman,docker` and `SPOOL_BUILD_TMPDIR` to a directory shared with the engine. Preload the image for Linux/amd64. The build runs offline with a read-only snapshot at `/inputs.tar` and writes its layer to `/build/layer.tar`. Build minimums stay on the client. They never enter the submitted task manifest.

```json
{
  "id": "prepared",
  "kind": "docker",
  "path": "build-input",
  "image": "debian:bookworm-slim@sha256:311f7a192fd9a92b165a86b32fa3aae9005b11849bfb1db2d4fd784559ee464f",
  "argv": ["/bin/sh", "-ec", "tar -xf /inputs.tar; sh prepare.sh; tar --format=ustar -cf layer.tar -C output ."],
  "build_resources": { "cpu": 2, "memory_mib": 4096, "disk_mib": 8192 }
}
```

SDK callers can choose build engines with `buildEngines`. Custom layer builders receive declared `buildResources` in their build context.

Call the library to resolve runner capabilities, build the ordered layers, and merge their SHA-256 descriptors into the manifest.

```js
import { runTaskFile } from "@3sln/spool-client/taskfile";

const { task } = await runTaskFile("./examples/taskfiles/check.json", {
  client, cache,
  requestId: crypto.randomUUID(),
  onAccepted: ({ task_id }) => console.log(task_id),
});
```

The runner returns any missing digests and a transfer plan for each. The client uploads the exact bytes from its cache or supplies a download URL when the plan offers a pull. The runner starts after every layer has been verified. Retries use the same request ID and manifest. A caller can persist the accepted task ID and resume waiting with the same client cache. Use `prepareTaskFile` for the merged manifest and descriptors without submitting.

Paths resolve relative to the file declaring them and stay inside the caller's context root. Directory recipes accept a `previous` snapshot and optional `include` and `exclude` lists of paths or globs relative to the layer directory. For example, `"include": ["src", "docs/**/*.json"], "exclude": ["**/fixtures", ".git"]` selects source and JSON input files. A matched directory includes or excludes its subtree. The same filters apply to both sides of a delta. Archive recipes import prebuilt OCI bytes.

### Source trees and incremental patches

Use a `sources` layer to map local directories to their guest destinations. Paths resolve relative to the Taskfile that declares each mapping. Include and exclude patterns are relative to that source directory. A mapping owns its destination subtree and replaces any earlier contents there. Destinations within one recipe must be disjoint. Use a destination such as `/workspace/app` to preserve earlier files elsewhere in the workspace.

```json
{
  "version": "0.1",
  "kind": "task",
  "task_timeout_s": 600,
  "layers": [
    {
      "id": "sources",
      "kind": "sources",
      "sources": [
        { "path": ".", "destination": "/workspace/app", "exclude": [".git", "target", "node_modules"] },
        { "path": "../shared", "destination": "/workspace/shared", "exclude": [".git"] }
      ]
    }
  ],
  "command": { "argv": ["sh", "check.sh"], "cwd": "/workspace/app" }
}
```

Run `spool-mcp run Taskfile.json --profile NAME --source-root ../shared` or pass the same source root to `spool-mcp init` for MCP. Repeat `--source-root` for more directories outside the project. SDK callers pass `sourceRoots` to `prepareTaskFile` or `runTaskFile`.

The client snapshots included files, executable bits, empty directories, and workspace-contained relative symlinks. The first submit builds deterministic uncompressed archives. Small edits produce byte patches against the previous snapshot, including edits inside binary files. The runner reconstructs the current archive before extraction, which also handles deletions. Patches reuse cached bases and earlier patches until the chain grows too large for the size or layer budget. The client then makes a fresh base. A runner can ask for an older base again after eviction. Fresh bases match across checkouts with the same normalized content, mapping and packing limits. Clients with different cache histories may use different patch chains to produce the same workspace.

Large trees split between archive entries. One file still needs to fit in a single base archive, and all archives and patches count toward the runner's layer and transfer limits. Runners with the older media profile receive full archives.

The built-in encoder works with Git checkouts and ordinary directories. Omit `diff` for the usual workflow. To use a custom command, start the CLI or MCP adapter with `--allow-source-diff-command` or set `allowSourceDiffCommand` in the SDK. These commands run locally with the client's user permissions.

```json
"diff": {
  "format": "git",
  "argv": ["git", "diff", "--no-index", "--binary", "--", "{base}", "{current}"]
}
```

For `git`, Spool passes two staged directory names. The command emits a Git patch on stdout and can exit with status 1 when differences exist. Spool applies it to scratch files, verifies file bytes, symlink targets and executable bits against the target, and encodes the result for the guest. The default `strip` count of 2 matches the example. Directory entries come from the source snapshot. `git diff HEAD` compares with a Git commit, while the staged directories represent the exact snapshots for this run.

For `vcdiff`, the placeholders `{base}` and `{current}` refer to uncompressed tar files. The command writes the RFC 3284 delta to `{patch}`. For example, use `["xdelta3", "-e", "-A", "-n", "-S", "none", "-B", "8388608", "-W", "1048576", "-s", "{base}", "{current}", "{patch}"]`. [Supported VCDIFF wire profile](protocol/README.md#source-archive-patches)

### Layer build reuse

Keep large stable inputs in lower layers and frequently edited scripts or patches in upper layers. The client fingerprints directory content and indexes each built layer by the recipe version, platform, base, ordered parent digests, and normalized inputs. Separate projects with the same prefix and local cache share one build, even when their checkout paths or layer IDs differ. A per-key SQLite lock coordinates the processes and releases when a builder exits. The actual archive SHA-256 stays in the manifest for uploads and verification.

### Prepare Linux binaries and reuse build outputs

Tasks run offline on Linux/amd64. For pure Go on macOS, run `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o .cache/spool/bin/tool ./cmd/tool` and add `.cache/spool` as a directory layer. For CGO or native dependencies, build in a Linux/amd64 environment compatible with the Debian 12 base. Discovery's `base_packages` lists the pinned base's Debian package versions. Check those versions and the runner's layer limits before packaging add-on toolchains.

To build once and run a binary in later tasks, have the producer write an archive such as `tar --format=ustar -cf /workspace/tool.tar -C /workspace/out bin` and declare `/workspace/tool.tar` in `outputs.paths`. The consumer can include this recipe on the same runner and profile while the producer's history is retained.

```json
{ "id": "tool", "kind": "artifact", "task_id": "PRODUCER_TASK_ID", "path": "/workspace/tool.tar" }
```

The runner verifies and caches the archive without sending its bytes through the client. Use `media_type` for gzip archives. Discovery advertises `artifact-layer-source` when available.

Use `"outputs": {"paths": ["/workspace/report.json", "/workspace/results.tar"]}` to keep files from the final workspace. For directories, create an archive in the task and declare that file. Artifacts are private to the submitting tenant and expire after 24 hours by default. Set `SPOOL_HISTORY_TTL_SECONDS` on the runner to change retention. Listings include the size, digest, expiry, and a download plan endpoint. Clients with an allowed storage origin use the runner's short-lived presigned GET when available.

Register additional recipe kinds with `layerBuilders`. A function receives the recipe and the build context. To share builds, supply an object with `version`, `fingerprint(recipe, context)`, and `build(recipe, context)`. The fingerprint must include all remaining inputs that affect the bytes, including tool versions or option values, and describe the exact inputs used by the build. The context includes the selected platform and base, ordered parent descriptors, runner capabilities, and a scoped path resolver.

## MCP over stdio

Install `spool-mcp` and initialize the project configuration.

```sh
spool-mcp init --runner http://127.0.0.1:8787 --workspace .
```

Use `spool-mcp --help` for the workflow, or pass `--help` to a command such
as `init`, `serve`, or `auth login` for its options and examples.

The default writes `.mcp.json`. Use `--client cursor` for `.cursor/mcp.json`,
`--config PATH` for a custom JSON config, or `--dry-run` to see the proposed
server entry. Existing entries are preserved. Use `--force` to replace a
conflicting Spool entry. Configure a local authentication profile or pass
`SPOOL_TOKEN` in the MCP host environment. The generated config contains
startup arguments and may name a profile. Keep machine-specific entries with
absolute paths or local profile names out of version control, and add
`.spool-leases/` to your project's ignore file. Claude Code prompts for
approval for project-scoped servers. To register across projects in Claude
Code, run `spool-mcp init --client claude --scope user --profile NAME`. The
adapter uses Claude's current project directory when no workspace is passed.
[Claude Code MCP scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)
Set `SPOOL_TRANSFER_ORIGINS` to a comma-separated list of allowed HTTPS storage origins for direct uploads and downloads.

Shared mode uses a per-user local disk cache so separate stdio processes share
both completed layers and in-flight builds. Use `--state-mode isolated` for a cache that is removed
when the CLI exits or `--state-dir PATH` to point multiple instances at a
specified directory. `SPOOL_STATE_DIR` and `SPOOL_STATE_MODE` work for
hosts that configure the adapter through environment variables. Task state
and event cursors are served by the runner.

With a workspace configured, `renew_cache_lease` and `release_cache_lease`
manage its current references. Set `SPOOL_CACHE_LEASE_SECONDS` to override the
default duration. Run `spool-mcp cache-gc` or call `gc_layer_cache` to reclaim
unleased layers. Pass `--state-dir PATH` to the command for a custom cache.

Run `spool-mcp capabilities --profile NAME` before connecting MCP to see the live runner's base packages, profiles, and limits. `submit_template` compiles a Taskfile under the workspace root. Pass `shards: 4` to run four tasks with the same layers and zero-based `SPOOL_SHARD_INDEX` and `SPOOL_SHARD_COUNT` in their environment. Wait on each returned ID. If a batch is partially accepted, finish the accepted tasks and repeat with the returned `client_request_id` to resume the batch.

Call `wait_task` to satisfy layer requests from disk. It waits for up to 100 seconds per call, then returns current status. Call `task_status` and `task_events` to inspect progress. Use `extend_task` to request a later deadline. `read_artifact` can return artifacts up to 512 KiB as UTF-8 or base64. `download_artifact` streams larger files into the workspace and verifies their digests.

### Authentication profiles

Use a separate profile name for each runner or identity. `spool-mcp auth list`
shows runner origins, schemes and expiry. `spool-mcp auth logout --profile NAME`
removes the local profile. `spool-mcp init --profile NAME --workspace .` selects it
for a project, or use `SPOOL_PROFILE` in the MCP host. Credentials live in
private per-user files under the Spool state home. `SPOOL_AUTH_DIR` overrides
that location independently of the layer cache.

```sh
spool-mcp auth login --profile team --runner https://runner.example.net --client-id YOUR_PUBLIC_CLIENT_ID
spool-mcp init --profile team --workspace .
```

OAuth login uses the runner's protected-resource metadata to discover its issuer.
It uses device authorization when advertised or a browser code flow with S256
PKCE. Register a public client with the issuer. For browser login, register the
`http://127.0.0.1:<port>/oauth/callback` redirect. Set `--redirect-port` for an issuer
that requires a fixed port. Select `--issuer` when the runner advertises several.
The CLI refreshes expiring credentials when the issuer supplies a refresh token.

For a personal Worker using the bearer-token adapter, provision the same random
token as a Worker secret and in the local CLI. Run these commands when that
Worker is ready to use.

```sh
token=$(openssl rand -hex 32)
printf '%s' "$token" | wrangler secret put SPOOL_TOKEN --name YOUR_WORKER
printf '%s' "$token" | spool-mcp auth login --profile personal --runner https://YOUR_RUNNER --scheme bearer --token-stdin
unset token
spool-mcp init --profile personal --workspace .
```

## Cloudflare preview

Import the Worker adapter in your own application and export the two Durable Object classes from your Worker entry point.

```js
import { createWorkerRunner } from "@3sln/spool-runner/worker";
export { TenantRunner, GuestSlot } from "@3sln/spool-runner/worker";
export default createWorkerRunner();
```

In your application’s config, bind a SQLite Durable Object namespace named `TENANTS` to `TenantRunner` and another named `GUESTS` to the container-backed `GuestSlot`. With the `/worker` entry point, bind an R2 bucket as `LAYERS`. The guest image recipe and build context are in the installed runner package under `guest/`. The Dockerfile is also available through `@3sln/spool-runner/guest/Dockerfile`. Configure the app’s routing, auth, and container settings in your deployment. Use `createWorkerRunner({ auth: (env) => adapter })` to supply a custom authentication adapter. For Access service credentials use `SPOOL_ACCESS_CLIENT_ID` and `SPOOL_ACCESS_CLIENT_SECRET` with the smoke client.

For the Durable Object scheduling policy, configure a named guest image under `containers[].images` and set `SPOOL_CONTAINER_IMAGE` to that name. `SPOOL_CONTAINER_INSTANCE` sets the default for tasks without hints and defaults to `standard-2`. Workers choose the smallest enabled tier that fits a task's minima. Supported tiers are `standard-2`, `standard-3`, and `standard-4`. The runner enables the default tier and larger ones. Set `SPOOL_CONTAINER_INSTANCES` to a comma-separated allowlist that includes the default to restrict which tiers can launch. A deployment using Cloudflare's default scheduling policy has a fixed profile set by its app configuration. [Cloudflare scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)

The selected `resource_profile` reports the workspace disk budget (4 GiB by default) and the tier's usable `capacity`. Request a larger disk budget with `requires.resources.disk_mib`. Stock Workers enforce memory through the VM and stock Docker or Podman through the engine cgroup. The provider caps actual allocation, so runtimes can reserve virtual address space. Cloudflare profile `provisioned` values describe the vCPU, memory and disk quantities for pricing. Cloudflare bills provisioned memory and disk while the Container is active and bills active CPU usage. [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)

A SQLite Durable Object queues one running task per tenant. The storage provider caches layers by tenant and digest. A separate container-bound object starts a fresh VM per attempt with Internet access disabled. The native guest runs the command independently. Short Durable Object alarms poll logs and results, resume from the persisted cursor, and stop the VM at expiry or completion. The guest also stops when its hard deadline passes or after two minutes without coordinator contact.

### Storage through an R2 binding

The binding lets the Worker read, write, and clean up its bucket with Cloudflare-managed access. Gateway transfers work with just the binding. Direct transfers require separate S3 signing credentials. [Cloudflare R2 bindings and presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

Enable direct R2 transfers by setting `SPOOL_R2_ENDPOINT` to your account's R2 S3 API origin and `SPOOL_R2_BUCKET` to the bucket bound as `LAYERS`. Store `SPOOL_R2_ACCESS_KEY_ID` and `SPOOL_R2_SECRET_ACCESS_KEY` as Worker secrets with read and write access scoped to that bucket. The binding manages objects and multipart sessions. The signing key stays in the Worker. Layer uploads up to 32 MiB use a presigned PUT, larger layers use presigned multipart URLs, and artifact downloads use presigned GET. A Worker without signing credentials offers gateway PUT for layers up to 32 MiB and authenticated gateway downloads. Set `SPOOL_TRANSFER_ORIGINS` to allow the storage origin for direct transfers.

### Storage through the S3 API

Use the `/worker-s3` entry point for a private S3-compatible bucket. It uses the configured HTTPS S3 endpoint for layers, artifacts, cleanup, and transfer signing. This entry point uses the Workers Fetch and streaming APIs. The `LAYERS` binding is optional for apps using this entry point.

```js
import { createS3WorkerRunner } from "@3sln/spool-runner/worker-s3";
export { TenantRunner, GuestSlot } from "@3sln/spool-runner/worker-s3";
export default createS3WorkerRunner();
```

Set `SPOOL_S3_BUCKET` and `SPOOL_S3_REGION` (defaults to `us-east-1`). Set `SPOOL_S3_ENDPOINT` to the provider's HTTPS origin for non-AWS storage. The runner uses path-style bucket addressing. Store `SPOOL_S3_ACCESS_KEY_ID` and `SPOOL_S3_SECRET_ACCESS_KEY` as Worker secrets, with `SPOOL_S3_SESSION_TOKEN` when your credentials include a session token. The credentials need read, write, delete, and multipart access to that bucket. Allow the storage origin in the client to use presigned single PUT, multipart, and GET transfers.

## JetStream workers

The self-hosted coordinator publishes ready task IDs to a durable JetStream consumer. Agents pull one delivery per free execution slot. The coordinator holds task state, layer bytes and claim leases. Agents fetch input and submit results over a private HTTP API. A lost claimed execution expires and can be resubmitted with a new request ID. Spool does not automatically repeat a command after an ambiguous runner failure.

For a disposable single-machine trial, start a broker and install the optional NATS packages.

```sh
docker run --rm -p 127.0.0.1:4222:4222 nats:2.11-alpine -js
npm install
```

Build the guest on each agent host. Share the following settings across the coordinator and agents, with a worker token distinct from the public API token. Start the coordinator with `bb serve` and `SPOOL_TOKEN` set. Start each agent with `bb agent`. Set `SPOOL_CONCURRENCY` for more than one slot per agent.

```sh
export SPOOL_NATS_URL=nats://127.0.0.1:4222
export SPOOL_WORKER_TOKEN=<different-random-secret>
export SPOOL_COORDINATOR_URL=http://127.0.0.1:8787
```

Across hosts, use HTTPS for coordinator calls, a private authenticated TLS connection to NATS, and persistent broker storage. `SPOOL_NATS_URL` accepts comma-separated servers. Provide `SPOOL_NATS_TOKEN` or `SPOOL_NATS_USER` and `SPOOL_NATS_PASSWORD`. `SPOOL_NATS_STREAM` names the deployment's stream and `SPOOL_NATS_REPLICAS` controls replication at creation. Limit proxy access to `/internal/` to trusted agents. One coordinator owns each SQLite database. Replicated metadata and coordinator failover are future work.

## Contract and verification

- [JSON Schema](protocol/manifest.schema.json), [OpenAPI](protocol/openapi.yaml), and [wire semantics](protocol/README.md).
- The execution profile supports Linux/amd64 with a pinned Debian 12 base, a statically linked guest, and ordered USTAR or gzip changesets. Regular files, directories, the executable bit, workspace-contained relative symlinks, whiteouts, opaque directories, and the Git archive PAX commit comment are supported. Other PAX extensions, hardlinks, special files and extended attributes are outside the profile.
- The runner offers a one-hour advisory cache lease and retains task history and idempotency for 24 hours after completion. Declared outputs stream up to a combined 256 MiB per task by default. Set `SPOOL_MAX_ARTIFACT_MIB` to an integer from 0 to 1024 to adjust that budget. Use the JavaScript download response stream or Rust `download_to` to save large files. Full-root composition, warm reuse, and public multi-tenant hardening remain open.
- `bb test` checks the HTTP runner, client cache and SDK, stdio MCP, SQLite, JWT verification and native guest. `bb test-worker` exercises the Worker and SQLite Durable Object in workerd with fixture blob and execution bindings. Set `SPOOL_TOOL_MODULES` to the directory containing the installed workerd and esbuild packages if they are outside the global npm root. `bb worker-check` generates an ignored test config and runs Wrangler’s dry-run build with Docker.

## Development and release

Install Babashka and run `bb tasks` for development commands. Run `npm ci` to install dependencies, `bb test` for JavaScript and native guest tests, `bb test-rust` for the Rust SDK, and `bb test-oci` with a working Docker engine for the integration suite. Set `SPOOL_TEST_RUST=1` to include the Rust client against the same runner. The GitHub verification workflow also runs the Worker fixture, the JetStream worker pool, and tarball installation in a clean consumer.

Use `bb release-pack` for npm tarballs and `bb release-cli` for a standalone executable archive on the current platform. `SPOOL_RELEASE_CLI=1 bb release-build` verifies the local bundle in `dist/`. To include a locally built OCI guest image, also set `SPOOL_RELEASE_OCI=1`.

A version bump in `version.edn` on main builds and verifies all six executables, publishes `@3sln/spool-mcp` through npm trusted publishing, and attaches the assets to the matching GitHub release. Prereleases use npm's `next` tag. The npm client SDK and runner tarballs are GitHub release assets. See [release bootstrap](release/README.md), [development status](DEVLOG.md), [security scope](SECURITY.md), and the [MIT license](LICENSE).
