# Changelog

## 0.1.0

- Portable HTTP task protocol, reusable JSON Taskfiles, and content-addressed layer uploads.
- JavaScript and Rust client SDKs, including deterministic workspace layers and a durable local cache.
- Docker runner, optional JetStream execution agents, and a preview Cloudflare Workers adapter.
- Standalone stdio MCP adapter with shared, isolated or custom state, plus project config initialization.
- Shared Taskfile prefix builds with process-safe cache coordination.
- Submitter-supplied deadlines, live extensions, and paginated or streaming output across both runner implementations.
- Detached Cloudflare guest execution, a statically linked guest on Debian, and discoverable Babashka development and release tasks.
- Per-layer transfer plans, direct presigned R2 and optional S3 uploads with multipart, and streamed layer staging for larger offline workloads.
