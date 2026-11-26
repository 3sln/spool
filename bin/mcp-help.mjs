const runnerOptions = `  --profile NAME      Local auth profile. Defaults to SPOOL_PROFILE.
  --runner URL        Runner origin. Defaults to SPOOL_URL, the selected profile,
                      or http://127.0.0.1:8787. A profile and URL must agree.
  --workspace PATH    Local project root. Defaults to SPOOL_WORKSPACE_ROOT.
                      Set it to enable Taskfile and layer-building tools.
  --source-root PATH  Also allow sources recipes to read this directory. Repeat as needed.
  --allow-source-diff-command
                      Allow trusted Taskfiles to run their optional local diff command.
  --state-mode MODE   shared (default), isolated (temporary), or custom.
  --state-dir PATH    Custom state root. Providing it selects custom mode
                      unless an explicit mode overrides it.`;

const help = {
  "": `Usage: spool-mcp [serve] [options]
       spool-mcp <command> --help
       spool-mcp help [command [subcommand]]

Commands
  serve       Start the stdio MCP server. This is the default.
  run         Submit a local Taskfile, supply layers, and wait for completion.
  init        Add Spool to a project's MCP configuration.
  capabilities  Query a runner's profiles and limits without MCP setup.
  auth        Sign in, list local credentials, or remove a profile.
  cache-gc    Reclaim layers with no live workspace lease.
  taskfile    Read the Taskfile guide, schemas, and runnable example.
  --version   Print the installed version.

Quick start
  1. Run spool-mcp auth list to find your runner profile.
  2. Run spool-mcp init --profile NAME --workspace . in your project.
  3. Reload your MCP host. Discover the tools with tools/list.
  4. Call taskfile_help, then capabilities, submit_template, and wait_task.

Run spool-mcp taskfile for Taskfile syntax and behavior.`,
  run: `Usage: spool-mcp run PATH [options]

Submit a Taskfile and print terminal status. The workspace defaults to the Taskfile directory.

Options
${runnerOptions}
  --request-id ID     Reuse an ID to retry the same compiled manifest.

Example
  spool-mcp run Taskfile.json --profile NAME --source-root ../shared`,
  serve: `Usage: spool-mcp [serve] [options]

Serve newline-delimited MCP JSON-RPC on stdin/stdout. Usually launched by an MCP host.

Options
${runnerOptions}

Environment
  SPOOL_TOKEN                 Bearer token when no profile is selected.
  SPOOL_STATE_MODE            State mode when --state-mode is omitted.
  SPOOL_STATE_DIR             State root when --state-dir is omitted.
  SPOOL_BLOB_DIR              Override the layer directory for shared or custom state.
  SPOOL_AUTH_DIR              Override the location of saved credentials.
  SPOOL_CACHE_LEASE_SECONDS   Override the default seven-day workspace lease.
  SPOOL_TRANSFER_ORIGINS      Comma-separated HTTPS origins for direct transfers.
  SPOOL_BUILD_ENGINES         Ordered local build engines. Defaults to docker,podman.
  SPOOL_BUILD_TMPDIR          Scratch directory shared with the build engine.

Call taskfile_help or browse the Taskfile MCP resources for examples and schemas.`,
  init: `Usage: spool-mcp init [options]

Add a server entry with startup arguments. Existing unrelated entries are preserved.

Options
  --client project|claude|cursor  Choose the default config path.
                                  project and claude use .mcp.json.
                                  cursor uses .cursor/mcp.json.
  --config PATH                   Override the default config path.
  --scope user                    With --client claude, use ~/.claude.json.
  --name NAME                     Server name in the config. Defaults to spool.
  --dry-run                       Print the proposed entry without writing.
  --force                         Replace a conflicting entry of the same name.
${runnerOptions}

Example
  spool-mcp init --profile NAME --workspace .
  spool-mcp init --client claude --scope user --profile NAME

Reload the MCP host after saving the config. Claude Code asks you to approve
project-scoped servers. Add .spool-leases/ to your project's ignore file.
Generated entries can contain machine-specific paths and profile names.`,
  capabilities: `Usage: spool-mcp capabilities [--profile NAME] [--runner URL]

Print the live runner's bases, upload limits, and resource profiles as JSON.
Select a saved profile with --profile or SPOOL_PROFILE, or supply a runner URL.`,
  auth: `Usage: spool-mcp auth <login|list|logout> [options]

Profiles bind credentials to one runner origin. Select a profile with --profile
or SPOOL_PROFILE when starting the MCP server.

  login    Verify credentials with a runner and save a local profile.
  list     List profile names, runner origins, and schemes.
  logout   Remove a local profile.

Run spool-mcp auth login --help for bearer and OAuth examples.`,
  "auth login": `Usage: spool-mcp auth login --profile NAME --runner URL [options]

Verify the credential with the runner and save it in the local profile.
Use HTTPS for remote runners. HTTP is supported for loopback development.

Options
  --profile NAME      Profile to save. Defaults to SPOOL_PROFILE.
  --runner URL        Runner origin. Defaults to SPOOL_URL.
  --scheme TYPE       bearer or oauth. Defaults to the runner's advertised scheme.
  --token-stdin       Read a bearer token from stdin. Otherwise use SPOOL_TOKEN.
  --client-id ID      Registered public OAuth client ID. Defaults to SPOOL_OAUTH_CLIENT_ID.
  --issuer URL        Select an advertised OAuth issuer if there are several.
  --scope SCOPE       Override the scopes advertised by the runner.
  --redirect-port N   Use a fixed loopback callback port for browser OAuth.

Examples
  spool-mcp auth login --profile dev --runner https://runner.example --token-stdin < token.txt
  spool-mcp auth login --profile team --runner https://runner.example --client-id my-cli

OAuth uses device authorization when offered, or a browser code flow with PKCE.`,
  "auth list": `Usage: spool-mcp auth list

Print saved profile names, runner origins, auth schemes, and known expiry.
Credential values are omitted. SPOOL_AUTH_DIR can select a different profile directory.`,
  "auth logout": `Usage: spool-mcp auth logout --profile NAME

Remove the local credentials for NAME. The profile defaults to SPOOL_PROFILE.
Use the issuer or runner to revoke credentials remotely.`,
  "cache-gc": `Usage: spool-mcp cache-gc [--state-dir PATH]

Remove layers with no unexpired workspace lease. A missing lease marker also
makes a layer eligible if no other workspace holds it.

Options
  --state-dir PATH    Collect from a custom state root. Defaults to SPOOL_STATE_DIR.

The command uses the same SPOOL_STATE_MODE and SPOOL_BLOB_DIR settings as serve.
It reports the removed digests and lease count. Rebuild collected layers if needed.`,
  taskfile: `Usage: spool-mcp taskfile [guide|schema|example]

  guide     Explain Taskfile syntax, inheritance, layers, and execution. Default.
  schema    Print JSON containing the Taskfile schema and its manifest dependency.
  example   Print a runnable example as a map of relative filenames to file contents.

MCP clients can call taskfile_help with one of the same topics.`,
  "taskfile guide": `Usage: spool-mcp taskfile guide

Print the Taskfile guide as Markdown, including the MCP submission workflow.`,
  "taskfile schema": `Usage: spool-mcp taskfile schema

Print the Taskfile and manifest JSON schemas under taskfile.schema.json and
manifest.schema.json. The Taskfile schema references the manifest schema
for workspace paths and output declarations.`,
  "taskfile example": `Usage: spool-mcp taskfile example

Print a map of relative filenames to file contents. Save each entry inside the
same project workspace, then submit Taskfile.json with the submit_template MCP
tool and call wait_task with the returned task_id.`,
};

export function helpFor(topic) {
  if (!Object.hasOwn(help, topic)) throw new TypeError(`Unknown help topic: ${topic}`);
  return help[topic];
}
