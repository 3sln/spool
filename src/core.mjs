import { publicEndpoint, taskEndpoint } from "./api.mjs";
import { INLINE_ARTIFACT_BYTES, LIMITS } from "./contract.mjs";
import { TaskService } from "./service.mjs";
import { configuredLayerPull } from "./layer-pull.mjs";

export { BASE, MEDIA, PATCH_MEDIA, LIMITS, Fault, configuredLimits, sha256 } from "./contract.mjs";
export { configuredAuth, jwtVerifier } from "./auth.mjs";
export { taskEndpoint as dispatchTaskRequest } from "./api.mjs";

const uploadKinds = new Set(["http-put", "presigned-put", "presigned-multipart"]);
const minimumZero = new Set(["max_layers", "max_logs_bytes", "max_log_events", "max_output_paths",
  "max_artifact_bytes_total"]);
const ceilings = { ...LIMITS, max_layer_bytes: 2048 * 1024 ** 2, max_input_bytes: 8192 * 1024 ** 2,
  workspace_mib: 8192, max_job_seconds: 2_147_483, max_task_seconds: 2_147_483, wait_seconds: 86400,
  max_artifact_bytes_total: 1024 ** 3, history_ttl_seconds: 2_147_483 };

function methods(provider, name, required) {
  for (const method of required) {
    if (typeof provider?.[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function providerLimits(options, transfers, artifacts) {
  const artifactCeiling = artifacts ? ceilings.max_artifact_bytes_total : INLINE_ARTIFACT_BYTES;
  for (const [key, value] of Object.entries(options)) {
    if (key === "uploads") continue;
    if (key === "patch_layers") {
      if (typeof value !== "boolean") throw new TypeError("patch_layers must be a boolean");
      continue;
    }
    if (!Object.hasOwn(ceilings, key)) throw new TypeError(`Unknown runner limit ${key}`);
    const ceiling = key === "max_artifact_bytes_total" ? artifactCeiling : ceilings[key];
    if (!Number.isSafeInteger(value) || value < (minimumZero.has(key) ? 0 : 1) || value > ceiling) {
      throw new RangeError(`Invalid runner limit ${key}`);
    }
  }
  const uploads = options.uploads ?? (transfers ? ["presigned-put", "presigned-multipart"] : ["http-put"]);
  if (!Array.isArray(uploads) || !uploads.length || new Set(uploads).size !== uploads.length
    || uploads.some((kind) => !uploadKinds.has(kind) || (!transfers && kind !== "http-put"))) {
    throw new TypeError("Invalid advertised upload transports");
  }
  return Object.freeze({
    ...LIMITS, max_artifact_bytes_total: Math.min(LIMITS.max_artifact_bytes_total, artifactCeiling),
    ...options, uploads: Object.freeze([...uploads]),
  });
}

// Use this when an authenticated front end needs to dispatch to another coordinator.
export function createRunnerHandler({ auth, execution, limits, origins = [], dispatch }) {
  methods(auth, "auth", ["authenticate"]);
  if (typeof auth.profile !== "string" || !auth.profile) throw new TypeError("auth.profile must be a nonempty string");
  const enforcement = {};
  for (const resource of ["network", "cpu", "memory", "disk"]) {
    if (typeof execution?.[resource] !== "string" || !execution[resource]) {
      throw new TypeError(`execution.${resource} must describe the executor's enforcement`);
    }
    enforcement[resource] = execution[resource];
  }
  if (typeof dispatch !== "function") throw new TypeError("dispatch must be a function");
  return publicEndpoint(auth, origins, enforcement, dispatch, limits);
}

export function createRunnerCore({
  auth, execution, store, layers, artifacts, transfers, limits = {}, origins, concurrency = 1, wake, stop,
  layerPullOrigins = [], layerPullTimeoutSeconds, pullFetch,
}) {
  const layerPull = configuredLayerPull({
    SPOOL_LAYER_PULL_ORIGINS: layerPullOrigins.join(","), SPOOL_LAYER_PULL_TIMEOUT_SECONDS: layerPullTimeoutSeconds,
  }, layers);
  const policy = Object.freeze({ ...providerLimits(limits, transfers, artifacts),
    artifact_layer_sources: Boolean(artifacts && typeof layers?.putVerified === "function"),
    artifact_presigned_get: typeof artifacts?.presignDownload === "function", layer_pull: layerPull.origins.size > 0 });
  methods(store, "store", ["get", "list", "commit"]);
  methods(layers, "layers", ["has", "delete"]);
  methods(layers, "layers", [typeof layers.open === "function" ? "open" : "get"]);
  if (policy.uploads.includes("http-put")) methods(layers, "layers", [typeof layers.putVerified === "function" ? "putVerified" : "put"]);
  if (artifacts) methods(artifacts, "artifacts", ["open", "putVerified", "delete"]);
  if (transfers) methods(transfers, "transfers", ["kind", "create", "plan", "confirm", "discard"]);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  if (wake !== undefined && typeof wake !== "function") throw new TypeError("wake must be a function");
  if (stop !== undefined && typeof stop !== "function") throw new TypeError("stop must be a function");
  const service = new TaskService(store, layers, {
    artifactStorage: artifacts, transfers, limits: policy, concurrency, wake, stop, layerPull, pullFetch,
  });
  const fetch = createRunnerHandler({
    auth, execution, limits: service.limits, origins, dispatch: (request, tenant) => taskEndpoint(request, tenant, service),
  });
  return { fetch, service };
}
