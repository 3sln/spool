const utf8 = new TextEncoder();

export const BASE = {
  id: "spool-debian12-workspace",
  digest: "sha256:311f7a192fd9a92b165a86b32fa3aae9005b11849bfb1db2d4fd784559ee464f",
};
export const MEDIA = [
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
];
const MIB = 1024 ** 2;
export const LIMITS = {
  max_layers: 16, max_layer_bytes: 512 * MIB, max_input_bytes: 2048 * MIB, workspace_mib: 4096,
  max_job_seconds: 604800, max_task_seconds: 604800, wait_seconds: 1800, start_budget_seconds: 600,
  max_logs_bytes: 128 * 1024, max_log_events: 1024, max_artifact_bytes_total: 512 * 1024,
  max_manifest_bytes: 32 * 1024, max_active_tasks_per_tenant: 16,
  max_output_paths: 8, cache_ttl_seconds: 3600, history_ttl_seconds: 86400,
};
export const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]);
export const digestPattern = /^sha256:[a-f0-9]{64}$/u;
export const taskPattern = /^[0-9a-f-]{36}$/u;

export class Fault extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function configuredLimits(env, { layerCeiling = 2048, defaultLayer = 512, uploads = ["http-put"] } = {}) {
  function setting(name, fallback, minimum, maximum) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
  }
  const cap = setting("SPOOL_MAX_TASK_SECONDS", LIMITS.max_task_seconds, 1, 2_147_483);
  const layer = setting("SPOOL_MAX_LAYER_MIB", defaultLayer, 1, layerCeiling);
  return {
    ...LIMITS, max_job_seconds: cap, max_task_seconds: cap, uploads,
    max_layer_bytes: layer * MIB,
    max_input_bytes: setting("SPOOL_MAX_INPUT_MIB", Math.min(2048, 16 * layerCeiling), layer, 8192) * MIB,
    workspace_mib: setting("SPOOL_WORKSPACE_MIB", LIMITS.workspace_mib, 64, 8192),
    wait_seconds: setting("SPOOL_ADMISSION_SECONDS", LIMITS.wait_seconds, 1, 86400),
    start_budget_seconds: setting("SPOOL_STARTUP_SECONDS", LIMITS.start_budget_seconds, 1, 600),
  };
}

export function capabilities(auth, execution, limits = LIMITS) {
  return {
    protocol_versions: ["0.1"], platforms: ["linux/amd64"], bases: [BASE],
    layer_media_types: MEDIA, transports: ["http+sse"],
    features: ["lazy-layers", "cancel", "artifact-download", "cache-retention", "deadline-extension", "live-logs"],
    filesystem: "workspace-oci-tar-subset",
    logs: { delivery: "live-sse-and-page", encoding: "utf-8", retention_s: LIMITS.history_ttl_seconds },
    upload_transports: limits.uploads ?? ["http-put"],
    resource_profile: { cpu: 1, memory_mib: 256, disk_mib: limits.workspace_mib },
    resource_enforcement: execution,
    auth, limits,
  };
}

function invalid(message) { throw new Fault("INVALID_MANIFEST", message); }
function shape(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    invalid(`Expected fields ${required.join(", ")}${optional.length ? ` and optionally ${optional.join(", ")}` : ""}`);
  }
}
function string(value, limit) {
  return typeof value === "string" && value.length <= limit && !value.includes("\0") && value.isWellFormed();
}
function workspace(path) {
  return string(path, 1024) && (path === "/workspace" || (
    path.startsWith("/workspace/") && path.slice(11).split("/").every((part) => part && part !== "." && part !== "..")
  ));
}

export function validateManifest(value, limits = LIMITS) {
  shape(value, ["protocol_version", "client_request_id", "task_timeout_s", "platform", "environment", "command", "resources", "network"], ["outputs"]);
  const { protocol_version, client_request_id, task_timeout_s, platform, environment, command, resources, network, outputs } = value;
  if (protocol_version !== "0.1" || !string(client_request_id, 128) || !/^[A-Za-z0-9._:-]+$/u.test(client_request_id)) {
    invalid("Unsupported protocol version or invalid client_request_id");
  }
  if (!Number.isSafeInteger(task_timeout_s) || task_timeout_s < 1 || task_timeout_s > limits.max_task_seconds) {
    throw new Fault("RESOURCE_LIMIT", `task_timeout_s must be between 1 and ${limits.max_task_seconds}`);
  }
  shape(platform, ["os", "arch"]);
  shape(environment, ["base", "layers"]);
  shape(environment.base, ["id", "digest"]);
  if (platform.os !== "linux" || platform.arch !== "amd64"
    || environment.base.id !== BASE.id || environment.base.digest !== BASE.digest) {
    throw new Fault("UNSUPPORTED_PLATFORM", "Select an advertised platform and base");
  }

  if (!Array.isArray(environment.layers) || environment.layers.length > LIMITS.max_layers) invalid("Invalid layer count");
  let total = 0;
  let uncompressed = 0;
  const sizes = new Map();
  for (const layer of environment.layers) {
    shape(layer, ["digest", "media_type", "size"]);
    if (!string(layer.digest, 71) || !digestPattern.test(layer.digest) || !Number.isSafeInteger(layer.size)
      || layer.size < 1) invalid("Invalid layer descriptor");
    if (layer.size > limits.max_layer_bytes) throw new Fault("RESOURCE_LIMIT", "Layer size exceeds the runner limit", 413);
    if (!MEDIA.includes(layer.media_type)) throw new Fault("UNSUPPORTED_PLATFORM", "Select an advertised layer media type");
    const prior = sizes.get(layer.digest);
    if (prior && (prior.size !== layer.size || prior.media_type !== layer.media_type)) invalid("Conflicting layer descriptors");
    sizes.set(layer.digest, layer);
    total += layer.size;
    if (layer.media_type === MEDIA[0]) uncompressed += layer.size;
  }
  if (total > limits.max_input_bytes) throw new Fault("RESOURCE_LIMIT", "Combined layer size exceeds the limit", 413);
  if (uncompressed > limits.workspace_mib * MIB * 3 / 4) {
    throw new Fault("RESOURCE_LIMIT", "Uncompressed layers exceed the workspace input budget", 413);
  }
  shape(command, ["argv", "cwd"]);
  if (!Array.isArray(command.argv) || !command.argv[0] || command.argv.length > 128
    || command.argv.some((argument) => !string(argument, 4096)) || !workspace(command.cwd)) invalid("Invalid command");
  shape(resources, ["cpu", "memory_mib", "disk_mib"], ["timeout_s"]);
  shape(network, ["mode"]);
  if (resources.cpu !== 1 || resources.memory_mib !== 256 || resources.disk_mib !== limits.workspace_mib || network.mode !== "none"
    || (resources.timeout_s !== undefined && (
      !Number.isSafeInteger(resources.timeout_s) || resources.timeout_s < 1 || resources.timeout_s > limits.max_job_seconds
    ))) {
    throw new Fault("RESOURCE_LIMIT", "Select the advertised resource and network profile");
  }
  if (outputs !== undefined) {
    shape(outputs, ["paths"]);
    if (!Array.isArray(outputs.paths) || outputs.paths.length > LIMITS.max_output_paths
      || new Set(outputs.paths).size !== outputs.paths.length || outputs.paths.some((path) => !workspace(path) || path === "/workspace")) {
      invalid("Invalid output paths");
    }
  }
  return value;
}

// The manifest grammar admits only bounded integers, well-formed strings and plain JSON objects.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? utf8.encode(value) : value;
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (part) => part.toString(16).padStart(2, "0")).join("")}`;
}

export async function readBytes(request, limit) {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > limit) throw new Fault("RESOURCE_LIMIT", "Body too large", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        void reader.cancel().catch(() => {});
        throw new Fault("RESOURCE_LIMIT", "Body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function readJSON(request, limit = LIMITS.max_manifest_bytes) {
  const bytes = await readBytes(request, limit);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Fault("INVALID_MANIFEST", "Expected UTF-8 JSON"); }
}

export function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}
