# Spool DEVLOG

The release tracker records decisions, verification and open gates. The [protocol](protocol/README.md) describes the wire contract. The [readme](README.md) describes how to use the product.

## Milestones

- [x] **P0 — Prototype.** The SDK, portable runner API, SQLite state and stdio MCP passed local tests. Kin-generated JavaScript and Rust replay policy passed common cases.
- [x] **P1 — Live filesystem probes.** Real Docker and Cloudflare guests applied ordered tar and gzip layers. A fixed Cloudflare diagnostic executed a dynamically linked shell from a composed root and failed after its composed libc was removed. A separate kernel OverlayFS mount/read succeeded. Four Docker jobs ran across two real JetStream agents. Initial failures exposed Docker mount ownership, the Cloudflare guest-port scheme, and JetStream provisioning error handling. The implementations were corrected.
- [~] **P2 — First distribution.** The MIT repository contains the npm SDK, runner package, stdio MCP CLI, Rust crate, and release pipeline. Clean consumers installed the three npm packages. The complete release bundle, including the Rust crate and OCI image, built locally. Both SDKs completed live Docker jobs. GitHub verification against the initial commit is the remaining gate.
- [!] **P3 — Hosted reliability.** Cloudflare accepted uploads and succeeded on some runs. Other runs failed before guest readiness with a placement error under both tested scheduling policies. Done when repeated workloads complete in live tests across cold starts, cache hits, and deployment changes.
- [ ] **P4 — Production full-root profile.** Implement the full-root adapter and test actual filesystem composition, containment, quotas, cleanup, and failure recovery. The fixed diagnostic is evidence of platform capability.

## Decisions

- **D001 — Portable HTTP, local MCP.** The runners implement the HTTP profile. Stdio MCP is a thin SDK consumer with access to the authoritative client cache.
- **D002 — Shared state without a resident process.** Separate stdio hosts can share a per-user cache through verified content-addressed files and atomic writes. Isolated mode creates a temporary directory. Custom mode uses the operator's path. Tasks stay durable at the runner.
- **D003 — Explicit release boundary.** The first distribution targets trusted workloads on self-hosted Docker. Cloudflare is a preview profile pending repeatable placement and an isolation review. Full-root execution remains a diagnostic result.
- **D004 — Reusable verification.** Pull requests and main run consumer, compatibility, runner and cross-language gates. Release builds use the same workflow and upload checksummed artifacts. An explicit dispatch input allows a prerelease draft to be staged from main.
