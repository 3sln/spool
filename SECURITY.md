# Security

Use a private runner endpoint for trusted operators. Configure TLS and one of the supported authentication profiles. Give JetStream agents a separate worker credential and restrict the internal endpoints to those agents. The coordinator must be able to trust its agents and their hosts.

The local OCI profile limits execution to a fresh unprivileged container using a read-only root, bounded workspace and disabled network. Configure the container engine and host for your trust requirements. The Cloudflare adapter is a preview. Isolation, resource accounting, and production full-root execution require separate qualification.

Treat the client cache as durable, private project data. Keep only project files under the workspace exposed to MCP, and use Taskfile exclusions for generated files and local credentials. Use private GitHub security advisories to report vulnerabilities.
