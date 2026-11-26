# spool-mcp feedback (from nome, Claude Code coordinator)

Running notes from trying spool-mcp to offload nome's CPU-heavy gates and benchmarks (Go, Rust, Java and .NET builds, PDF render inventories). Newest entries are at the bottom.

## 2026-11-26: setup

- **Good:** `spool-mcp --help` and `auth list` were clear. `init --profile spool-dev --workspace .` wrote `.mcp.json` in one step and printed the path and `changed: true`.
- **Friction: the project-scoped server needs approval.** `init` writes the project `.mcp.json`, and Claude Code treats that as an unapproved project server. `claude mcp list` shows `spool: ... - ⏸ Pending approval (run \`claude\` to approve)`. Until the user approves it in the interactive UI, `/mcp` reconnect doesn't help and the tools never reach the agent. Neither `init`'s output nor the README mentions this.
  - **Suggestion:** print a hint after `init --client claude|project` ("Claude Code: approve the project server via /mcp or restart; or use `--config ~/.claude.json` / `claude mcp add --scope user`").
  - **Suggestion:** offer `init --scope user` for Claude Code, which skips project approval.
- **Unclear:** whether a `.mcp.json` written into the repo should be committed. It contains an absolute `--workspace` path and a profile name, both machine-specific. Suggest documenting "don't commit; it's machine-specific", or writing a relative `--workspace .` when the config sits at the workspace root.
- **Note for heavy workloads:** the Taskfile guide says tasks run offline, so every toolchain has to come from the base image or uploaded layers. For a polyglot repo (Go, Rust, JDK and .NET, about 1–2 GB of toolchains), the 512 MiB per-layer and 2 GiB-per-task defaults matter. It would help to show the managed (Cloudflare) runner's actual limits and base images before any setup. `capabilities` is only reachable after MCP is connected, and a `spool-mcp capabilities --profile X` CLI subcommand would allow planning before setup.

## 2026-11-26: first real workload (nome render corpus, 73 docs, 4 shards)

### What worked well
- **Fast round trip.** After approval, `capabilities` → `submit_template` → `wait_task` → `task_events` → `read_artifact` all worked first time. The `layer.required` → `layer.available` events made the upload flow easy to follow.
- **Quick uploads and start-up.** 22 MB and 10 MB layers uploaded in about 6–8 s. The task went from queued to started in under a second, and four shards ran concurrently.
- **Dedup across tasks.** Four shards sharing the same layer digests uploaded once (the first `wait_task`). Later tasks found the layers already available.
- **The workload was correct.** 73/73 PDFs rendered at 17–695 ms each, and all spot-checked outputs were byte-identical to local macOS renders.
- **`wait_task` with `wait_s: 120` returned as soon as the task finished.** No extra polling was needed.

### Blockers and sharp edges (most important first)
1. **Go binaries can't run at all.** With `memory: "per-process-address-space"` at 256 MiB, every static Go binary dies at start-up with `fatal error: failed to reserve page summary memory`. Go reserves far more than 256 MiB of virtual address space before allocating anything; the JVM, .NET and V8/Node do too. An `RLIMIT_AS` cap rules out most language runtimes regardless of their real RSS.
   - **Suggestion:** enforce memory by RSS or cgroup (`memory.max`) instead of address space. At minimum, put "address-space limit: Go/JVM/.NET/Node won't start" in `capabilities` or the guide.
   - **Workaround I used:** a statically linked Rust (musl) binary, which ran fine.
2. **Symlinks are rejected with an unhelpful error.** `submit_template` failed with `Unsupported workspace entry: docs/test/chromediff/fonts`, a relative symlink inside the repo.
   - **Suggestion:** say *why* in the error ("symlinks aren't supported in directory layers"). Better still, add an option to dereference symlinks that resolve inside the workspace, or to store them as tar symlink entries (OCI layers support them).
3. **Toolchains can't fit.** The 32 MiB per-layer and 256 MiB memory limits make it impossible to build in the sandbox: Go, rustc, the JDK and .NET all exceed one or both. So spool only suits shipping prebuilt binaries plus data. That's fine, but worth stating.
   - Building a Linux binary on macOS needed cross-compiling. Zig was broken on this host; rustup's `rust-lld` needed `DYLD_FALLBACK_LIBRARY_PATH` set to find `libLLVM.dylib`; the musl target had to be added. A documented "how to produce a Linux binary for spool from macOS" recipe, or a prebuilt-toolchain base, would remove most of this friction.
4. **Directory layers must live inside the workspace.** Recipes must resolve inside the project workspace, so I staged in a gitignored `.cache/spool/`. That's reasonable, but `build_layer` or `submit_template` accepting an `include`/`exclude` glob relative to the repo root would avoid copying 10 MB of inputs into a staging dir.
5. **One vCPU per task.** Parallelism comes only from fanning out tasks, up to 16 per tenant. A Taskfile matrix or `shards: N` field, with the shard index in an env var, would replace my four near-identical `shardN.json` files.
6. **Getting artifacts back is awkward.** `read_artifact` returns base64 JSON, so for an agent client getting text results back means decoding by hand. A `text`/`utf-8` encoding option for small text artifacts, or including stdout tails in `wait_task`, would help. In practice I read results from `task_events` stdout, which was already UTF-8.
7. **Layer reuse depends on mutable staging.** Editing `run.sh` changed the docs layer's digest and forced a 10 MB re-upload. That's correct, but a layer-per-concern pattern (scripts separate from data) deserves a line in the guide.

### Verdict for nome
- **Good fit:** fanning out deterministic render, inventory and benchmark shards with a prebuilt Rust binary.
- **Poor fit:** compiling, Go/JVM/.NET hosts, and anything needing more than 256 MiB.
- **Lifting the address-space limit** (or switching to RSS limits) and adding symlink support would make spool usable for most of nome's gates.

### Small: workspace pollution
- spool-mcp creates `.spool-leases/` at the workspace root, in nome's git checkout, where it shows up as untracked. Suggestion: keep lease state in the state dir (`SPOOL_STATE_DIR` / the per-user cache), or document adding `.spool-leases/` to `.gitignore`. `init` could offer to add it.
