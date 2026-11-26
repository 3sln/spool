import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { helpFor } from "./mcp-help.mjs";
import { taskfileTopics } from "./taskfile-help.mjs";

const defaults = {
  project: ".mcp.json",
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
};
const modes = new Set(["shared", "isolated", "custom"]);
const serveFlags = ["runner", "profile", "workspace", "state-mode", "state-dir", "source-root", "allow-source-diff-command",
  "s3-cache-bucket", "s3-cache-endpoint", "s3-cache-region", "s3-cache-prefix"];
const booleanFlags = new Set(["force", "dry-run", "token-stdin", "allow-source-diff-command"]);
const initFlags = [...serveFlags, "client", "scope", "config", "name", "force", "dry-run"];

export function validRunner(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("Runner URL must be an HTTP or HTTPS origin without credentials, query, or fragment");
  }
  return url.origin;
}

function normalizeState(mode, directory) {
  if (mode === undefined) mode = directory ? "custom" : "shared";
  if (!modes.has(mode)) throw new TypeError("State mode must be shared, isolated, or custom");
  if (mode === "custom" && !directory) throw new TypeError("Custom state mode requires --state-dir");
  if (mode === "isolated" && directory) throw new TypeError("Isolated state creates its own temporary directory");
  return { mode, directory };
}

export function parseCli(args) {
  const result = { command: "serve" };
  const showHelp = (topic) => ({ command: "help", text: helpFor(topic) });
  const isHelp = (arg) => arg === "--help" || arg === "-h";
  if (args[0] === "--version") return { command: "version" };
  if (args[0] === "help") return showHelp(isHelp(args[1]) ? "" : args.slice(1).join(" "));
  let topic = "";
  if (["init", "serve", "run", "capabilities", "cache-gc", "auth", "taskfile"].includes(args[0])) {
    result.command = args.shift();
    topic = result.command;
  }
  if (isHelp(args[0])) return showHelp(topic);
  let allowed = serveFlags;
  if (result.command === "run") {
    if (args.some(isHelp)) return showHelp(topic);
    if (!args[0] || args[0].startsWith("--")) throw new TypeError("Supply the Taskfile path as the first argument to run");
    result.taskfile = args.shift();
    allowed = [...serveFlags, "request-id"];
  }
  if (result.command === "init") allowed = initFlags;
  if (result.command === "capabilities") allowed = ["runner", "profile"];
  if (result.command === "cache-gc") allowed = ["state-dir"];
  if (result.command === "auth") {
    if (!args.length) return showHelp(topic);
    result.action = args.shift();
    const authFlags = {
      login: ["runner", "profile", "scheme", "token-stdin", "issuer", "client-id", "scope", "redirect-port"],
      logout: ["profile"],
      list: [],
    };
    if (!Object.hasOwn(authFlags, result.action)) throw new TypeError("Use auth login, auth list, or auth logout");
    topic += " " + result.action;
    allowed = authFlags[result.action];
  }
  if (result.command === "taskfile") {
    result.action = args.shift() ?? "guide";
    if (!taskfileTopics.includes(result.action)) throw new TypeError("Use taskfile guide, taskfile schema, or taskfile example");
    topic += " " + result.action;
    allowed = [];
  }
  if (args.some(isHelp)) return showHelp(topic);
  while (args.length) {
    const flag = args.shift();
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.includes(key) || (key !== "source-root" && Object.hasOwn(result, key))) throw new TypeError(`Unexpected or repeated option: ${flag}`);
    if (booleanFlags.has(key)) result[key] = true;
    else {
      if (!args[0] || args[0].startsWith("--")) throw new TypeError(`Option ${flag} requires a value`);
      if (key === "source-root") (result[key] ??= []).push(args.shift());
      else result[key] = args.shift();
    }
  }
  result.runner = validRunner(result.runner);
  return result;
}

export function stateHome(env) {
  if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME;
  if (process.platform === "win32") return env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".local", "state");
}

export async function cliState(options, env) {
  const state = normalizeState(
    options["state-mode"] ?? env.SPOOL_STATE_MODE,
    options["state-dir"] ?? env.SPOOL_STATE_DIR,
  );
  if (state.mode === "isolated") {
    if (env.SPOOL_BLOB_DIR) throw new TypeError("SPOOL_BLOB_DIR cannot be used in isolated mode");
    const directory = await mkdtemp(join(tmpdir(), "spool-mcp-"));
    return { isolated: true, blobs: join(directory, "layers"), close: () => rm(directory, { recursive: true, force: true }) };
  }
  const directory = resolve(state.directory ?? join(stateHome(env), "spool"));
  return { blobs: resolve(env.SPOOL_BLOB_DIR ?? join(directory, "layers")), close: async () => {} };
}

function configEntry(options) {
  const args = ["serve"];
  for (const key of serveFlags) {
    if (options[key] === undefined) continue;
    if (key === "source-root") for (const path of options[key]) args.push("--source-root", resolve(path));
    else if (booleanFlags.has(key)) args.push(`--${key}`);
    else args.push(`--${key}`, options[key]);
  }
  return { command: "spool-mcp", args };
}

async function existingConfig(path) {
  const stats = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return { config: {}, mode: 0o600 };
  if (!stats.isFile() || stats.size > 1024 ** 2) throw new Error("MCP config must be a regular JSON file within the size limit");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("MCP config must contain a JSON object");
  return { config, mode: stats.mode & 0o777 };
}

function updatedConfig(config, name, entry, force) {
  const servers = Object.hasOwn(config, "mcpServers") ? config.mcpServers : {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new TypeError("mcpServers must be a JSON object");
  if (Object.hasOwn(servers, name)) {
    const present = servers[name];
    if (JSON.stringify(present) === JSON.stringify(entry)) return null;
    if (!force) throw new Error(`MCP server "${name}" already exists. Use --force to replace that entry.`);
  }
  return { ...config, mcpServers: { ...servers, [name]: entry } };
}

export async function initializeCli(options) {
  const client = options.client ?? "project";
  if (!Object.hasOwn(defaults, client)) throw new TypeError("Client must be project, claude, or cursor");
  const scope = options.scope ?? "project";
  if (!["project", "user"].includes(scope) || (scope === "user" && client !== "claude")) {
    throw new TypeError("Use --client claude with --scope user");
  }
  normalizeState(options["state-mode"], options["state-dir"]);
  const path = resolve(options.config ?? (scope === "user" ? join(homedir(), ".claude.json") : defaults[client]));
  const name = options.name ?? "spool";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name)) throw new TypeError("Invalid MCP server name");
  const entry = configEntry({
    ...options,
    workspace: options.workspace ? resolve(options.workspace) : undefined,
    "state-dir": options["state-dir"] ? resolve(options["state-dir"]) : undefined,
  });
  if (options["dry-run"]) {
    const { config } = await existingConfig(path);
    return { path, name, entry, changed: updatedConfig(config, name, entry, options.force) !== null };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.spool-lock`;
  const handle = await open(lock, "wx", 0o600);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const { config, mode } = await existingConfig(path);
    const updated = updatedConfig(config, name, entry, options.force);
    if (!updated) return { path, changed: false };
    await writeFile(temporary, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode });
    await rename(temporary, path);
    return { path, changed: true };
  } finally {
    await handle.close();
    await Promise.all([rm(lock, { force: true }), rm(temporary, { force: true })]);
  }
}
