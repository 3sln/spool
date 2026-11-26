import { packages } from "./base-packages.mjs";

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
export const INLINE_ARTIFACT_BYTES = 512 * 1024;
const resourceFields = ["cpu", "memory_mib", "disk_mib"];
export const LIMITS = {
  max_layers: 16, max_layer_bytes: 512 * MIB, max_input_bytes: 2048 * MIB, workspace_mib: 4096,
  max_job_seconds: 604800, max_task_seconds: 604800, wait_seconds: 1800, start_budget_seconds: 600,
  max_logs_bytes: 128 * 1024, max_log_events: 1024, max_artifact_bytes_total: 256 * MIB,
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
    history_ttl_seconds: setting("SPOOL_HISTORY_TTL_SECONDS", LIMITS.history_ttl_seconds, 1, 2_147_483),
    max_artifact_bytes_total: setting("SPOOL_MAX_ARTIFACT_MIB", 256, 0, 1024) * MIB,
  };
}

function baseline(limits) {
  return { cpu: 1, memory_mib: 256, disk_mib: limits.workspace_mib };
}

function resourceProfiles(limits) {
  return limits.resource_profiles ?? [{ name: "fixed", ...baseline(limits) }];
}

export function capabilities(auth, execution, limits = LIMITS) {
  const { resource_profiles, default_resource_profile, artifact_layer_sources, artifact_presigned_get, ...publishedLimits } = limits;
  return {
    protocol_versions: ["0.1"], platforms: ["linux/amd64"], bases: [BASE],
    layer_media_types: MEDIA, transports: ["http+sse"],
    features: ["lazy-layers", "cancel", "artifact-download", "cache-retention", "deadline-extension", "live-logs", "task-shards",
      ...(artifact_layer_sources ? ["artifact-layer-source"] : [])],
    filesystem: "workspace-oci-tar-subset",
    base_packages: { [BASE.id]: packages },
    logs: { delivery: "live-sse-and-page", encoding: "utf-8", retention_s: limits.history_ttl_seconds ?? LIMITS.history_ttl_seconds },
    upload_transports: limits.uploads ?? ["http-put"],
    download_transports: ["http-get", ...(artifact_presigned_get ? ["presigned-get"] : [])],
    resource_profile: baseline(limits),
    resource_profiles: resourceProfiles(limits),
    default_resource_profile: default_resource_profile ?? "fixed",
    ...(resource_profiles && { pricing_url: "https://developers.cloudflare.com/containers/platform/pricing/" }),
    resource_enforcement: execution,
    auth, limits: publishedLimits,
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
  planManifest(value, limits);
  return value;
}

export function planManifest(value, limits = LIMITS) {
  shape(value, ["protocol_version", "client_request_id", "task_timeout_s", "platform", "environment", "command", "resources", "network"],
    ["outputs", "min_resources", "layer_sources", "shard"]);
  const { protocol_version, client_request_id, task_timeout_s, platform, environment, command, resources, network, outputs,
    min_resources: minimum } = value;
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

  const maxLayers = Math.min(LIMITS.max_layers, limits.max_layers ?? LIMITS.max_layers);
  if (!Array.isArray(environment.layers) || environment.layers.length > maxLayers) invalid("Invalid layer count");
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
  if (value.layer_sources !== undefined) {
    if (!limits.artifact_layer_sources) throw new Fault("UNSUPPORTED_PLATFORM", "Runner does not offer artifact layer sources");
    const sources = value.layer_sources;
    shape(sources, [], [...sizes.keys()]);
    for (const source of Object.values(sources)) {
      shape(source, ["task_id", "path"]);
      if (!string(source.task_id, 36) || !taskPattern.test(source.task_id)
        || !workspace(source.path) || source.path === "/workspace") invalid("Invalid artifact layer source");
    }
  }
  if (value.shard !== undefined) {
    shape(value.shard, ["index", "count"]);
    const { index, count } = value.shard;
    if (!Number.isInteger(count) || count < 2 || count > 64 || !Number.isInteger(index) || index < 0 || index >= count) {
      invalid("Invalid task shard index or count");
    }
  }
  if (total > limits.max_input_bytes) throw new Fault("RESOURCE_LIMIT", "Combined layer size exceeds the limit", 413);
  shape(command, ["argv", "cwd"]);
  if (!Array.isArray(command.argv) || !command.argv[0] || command.argv.length > 128
    || command.argv.some((argument) => !string(argument, 4096)) || !workspace(command.cwd)) invalid("Invalid command");
  shape(resources, ["cpu", "memory_mib", "disk_mib"], ["timeout_s"]);
  shape(network, ["mode"]);
  const standard = baseline(limits);
  if (resourceFields.some((field) => resources[field] !== standard[field]) || network.mode !== "none"
    || (resources.timeout_s !== undefined && (
      !Number.isSafeInteger(resources.timeout_s) || resources.timeout_s < 1 || resources.timeout_s > limits.max_job_seconds
    ))) {
    throw new Fault("RESOURCE_LIMIT", "Select the advertised resource and network profile");
  }
  if (outputs !== undefined) {
    shape(outputs, ["paths"]);
    const maxPaths = Math.min(LIMITS.max_output_paths, limits.max_output_paths ?? LIMITS.max_output_paths);
    if (!Array.isArray(outputs.paths) || outputs.paths.length > maxPaths
      || new Set(outputs.paths).size !== outputs.paths.length || outputs.paths.some((path) => !workspace(path) || path === "/workspace")) {
      invalid("Invalid output paths");
    }
  }
  const demand = { ...standard };
  if (minimum !== undefined) {
    shape(minimum, [], resourceFields);
    for (const field of resourceFields) {
      if (!Object.hasOwn(minimum, field)) continue;
      if (!Number.isSafeInteger(minimum[field]) || minimum[field] < 1) invalid(`Invalid min_resources.${field}`);
      demand[field] = Math.max(standard[field], minimum[field]);
    }
  }
  const offers = resourceProfiles(limits);
  const selected = !minimum || !Object.keys(minimum).length
    ? offers.find(({ name }) => name === (limits.default_resource_profile ?? "fixed"))
    : offers.find((offer) => resourceFields.every((field) => offer[field] >= demand[field]));
  if (!selected) throw new Fault("RESOURCE_LIMIT", "No enabled runner profile satisfies the task's minimum resources", 422);
  if (uncompressed > demand.disk_mib * MIB * 3 / 4) {
    throw new Fault("RESOURCE_LIMIT", "Uncompressed layers exceed the workspace input budget", 413);
  }
  return (minimum !== undefined || limits.resource_profiles) ? {
    name: selected.name, ...demand, cpu: selected.cpu, memory_mib: selected.memory_mib,
    ...(limits.resource_profiles && { capacity: selected }),
  } : undefined;
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
