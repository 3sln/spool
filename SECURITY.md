# Security

Use a private runner endpoint for trusted operators. Configure TLS and one of the supported authentication profiles. Give JetStream agents a separate worker credential and restrict the internal endpoints to those agents. The coordinator must be able to trust its agents and their hosts.

The local OCI profile runs tasks in a fresh unprivileged container using a read-only root and bounded workspace. Docker runs with an isolated network namespace containing loopback. The Cloudflare preview disables outbound Internet access without installing egress interceptors. The Cloudflare guest drops privileges before executing the command and scopes status polling to an internal claim credential. Configure the container engine and host for your trust requirements. Cloudflare isolation, resource accounting, and production full-root execution require separate qualification.

Treat the client cache as durable, private project data. Keep only project files under the workspace exposed to MCP, and use Taskfile exclusions for generated files and local credentials. Use private GitHub security advisories to report vulnerabilities.
