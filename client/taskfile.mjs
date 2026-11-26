import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildKey, directorySelection, planDirectoryLayer } from "./node.mjs";
import { buildLayer, TAR, TAR_GZIP } from "./layers.mjs";
import { buildContainerLayer } from "./container-build.mjs";

const maxTemplateBytes = 128 * 1024;
const map = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string" && value.length > 0 && value.isWellFormed() && !value.includes("\0");
const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const resourceFields = ["cpu", "memory_mib", "disk_mib"];
const workspacePath = (path) => string(path) && (path === "/workspace" || (
  path.startsWith("/workspace/") && path.slice(11).split("/").every((part) => part && part !== "." && part !== "..")
));
const pathEscapes = (path) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);

function fields(value, allowed, subject) {
  if (!map(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`Invalid ${subject} fields`);
  }
}

async function scopedPath(root, directory, path) {
  if (!string(path) || isAbsolute(path)) throw new TypeError("Taskfile paths must be relative");
  const lexical = resolve(directory, path);
  if (pathEscapes(relative(root, lexical))) throw new Error(`Taskfile path is outside the context root: ${path}`);
  const canonical = await realpath(lexical);
  if (pathEscapes(relative(root, canonical))) throw new Error(`Taskfile path is outside the context root: ${path}`);
  return canonical;
}

async function regularFile(path, maximum) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maximum) throw new Error("Expected a regular file within the size limit");
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error("File exceeds the size limit");
  return bytes;
}

function mergeMinimums(target, minima, label = "requires.resources") {
  fields(minima, resourceFields, label);
  for (const [field, minimum] of Object.entries(minima)) {
    if (!Number.isSafeInteger(minimum) || minimum < 1) throw new TypeError(`Invalid ${label}.${field} minimum`);
    target[field] = Math.max(target[field] ?? 0, minimum);
  }
}

function requirements(target, requirements = {}) {
  fields(requirements, ["platform", "base", "features", "limits", "resources"], "requires");
  for (const key of ["platform", "base"]) {
    const value = requirements[key];
    if (value === undefined) continue;
    if (!string(value) || (target[key] && target[key] !== value)) throw new Error(`Conflicting or invalid requires.${key}`);
    target[key] = value;
  }
  if (requirements.features !== undefined) {
    if (!Array.isArray(requirements.features) || !requirements.features.every(string)) throw new TypeError("requires.features must contain strings");
    for (const feature of requirements.features) target.features.add(feature);
  }
  if (requirements.limits !== undefined) {
    if (!map(requirements.limits)) throw new TypeError("requires.limits must be an object");
    for (const [limit, minimum] of Object.entries(requirements.limits)) {
      if (!Number.isSafeInteger(minimum) || minimum < 0 || !name.test(limit)) throw new TypeError("Invalid requires.limits minimum");
      target.limits.set(limit, Math.max(target.limits.get(limit) ?? 0, minimum));
    }
  }
  if (requirements.resources !== undefined) mergeMinimums(target.resources, requirements.resources);
}

function selectRunner(runner, required) {
  const platform = required.platform ?? runner.platforms?.[0];
  const base = required.base === undefined ? runner.bases?.[0] : runner.bases?.find(({ id }) => id === required.base);
  if (!runner.protocol_versions?.includes("0.1") || !string(platform) || !runner.platforms.includes(platform) || !base) {
    throw new Error("Runner does not meet the Taskfile protocol, platform, or base requirements");
  }
  for (const feature of required.features) {
    if (!runner.features?.includes(feature)) throw new Error(`Runner is missing the required feature: ${feature}`);
  }
  for (const [limit, minimum] of required.limits) {
    if (typeof runner.limits?.[limit] !== "number" || runner.limits[limit] < minimum) {
      throw new Error(`Runner limit ${limit} must be at least ${minimum}`);
    }
  }
  const parts = platform.split("/");
  if (parts.length !== 2 || !parts.every(string) || !string(base.id) || !/^sha256:[a-f0-9]{64}$/u.test(base.digest)) {
    throw new Error("Runner advertised an invalid platform or base");
  }
  return { platform: { os: parts[0], arch: parts[1] }, base };
}

async function builtinLayer(recipe, context) {
  const { root, directory, maxBytes, signal, buildResources, buildEngines } = context;
  if (recipe.kind === "directory") {
    fields(recipe, ["id", "kind", "path", "previous", "include", "exclude"], "directory layer");
    const paths = await Promise.all([scopedPath(root, directory, recipe.path),
      recipe.previous === undefined ? undefined : scopedPath(root, directory, recipe.previous)]);
    const prepared = await planDirectoryLayer(paths[0], {
      previous: paths[1], maxBytes, signal,
      ...directorySelection(recipe),
    });
    return { version: "1", fingerprint: () => prepared.fingerprint(), build: () => ({ bytes: prepared.build(), mediaType: TAR }) };
  }
  if (recipe.kind === "archive") {
    fields(recipe, ["id", "kind", "path", "media_type"], "archive layer");
    const path = await scopedPath(root, directory, recipe.path);
    const mediaType = recipe.media_type ?? TAR;
    return {
      import: typeof context.cache.importFile === "function"
        ? () => context.cache.importFile(path, mediaType, { maxBytes, signal }) : undefined,
      build: async () => ({ bytes: await regularFile(path, maxBytes), mediaType }),
    };
  }
  if (recipe.kind === "docker") {
    fields(recipe, ["id", "kind", "image", "argv", "path", "include", "exclude", "media_type", "build_resources", "build_timeout_s"],
      "container-built layer");
    if (!string(recipe.image) || !/^[a-z0-9][a-zA-Z0-9_.:/-]*@sha256:[a-f0-9]{64}$/u.test(recipe.image)) {
      throw new TypeError("Container build image must be pinned by SHA-256 digest");
    }
    if (!Array.isArray(recipe.argv) || !recipe.argv.length || recipe.argv.length > 128 || !string(recipe.argv[0])
      || recipe.argv.some((arg) => typeof arg !== "string" || arg.length > 4096 || !arg.isWellFormed() || arg.includes("\0"))) {
      throw new TypeError("Container build requires an argv array with an executable");
    }
    const timeout = recipe.build_timeout_s ?? 1800;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 604800) throw new TypeError("Invalid build_timeout_s");
    const mediaType = recipe.media_type ?? TAR;
    if (![TAR, TAR_GZIP].includes(mediaType)) throw new TypeError("Expected an OCI tar media type");
    if (recipe.path === undefined && (recipe.include !== undefined || recipe.exclude !== undefined)) {
      throw new TypeError("Container input filters require a path");
    }
    const snapshot = recipe.path === undefined ? undefined : await planDirectoryLayer(
      await scopedPath(root, directory, recipe.path), { ...directorySelection(recipe), maxBytes: 40 * 1024 ** 2, signal },
    );
    const importArchive = (archive, buildSignal) => context.cache.importFile(archive, mediaType, { maxBytes, signal: buildSignal });
    if (typeof context.cache.importFile !== "function") throw new TypeError("Container builds require a cache with importFile");
    const resources = Object.fromEntries(resourceFields.filter((field) => buildResources[field] !== undefined)
      .map((field) => [field, buildResources[field]]));
    return {
      version: "1",
      fingerprint: () => buildKey([recipe.image, recipe.argv, mediaType, resources, snapshot?.fingerprint() ?? null]),
      import: () => buildContainerLayer({ image: recipe.image, argv: recipe.argv, resources, timeout,
        input: snapshot?.build ?? (() => buildLayer([])), signal, engines: buildEngines }, importArchive),
    };
  }
  return undefined;
}

export async function prepareTaskFile(file, {
  contextRoot = dirname(resolve(file)), runner, client, cache, layerBuilders = {}, buildEngines, requestId = crypto.randomUUID(), signal,
} = {}) {
  if (!cache || typeof cache.put !== "function") throw new TypeError("A writable layer cache is required");
  if (!string(requestId) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) throw new TypeError("Invalid task request ID");
  const root = await realpath(contextRoot);
  if (!cache.leasePath && typeof cache.forWorkspace === "function") cache = await cache.forWorkspace(root);
  const entry = await scopedPath(root, root, relative(resolve(contextRoot), resolve(file)));
  const required = { features: new Set(), limits: new Map(), resources: {} };
  const done = new Set();
  const visiting = new Set();
  const recipes = new Map();
  let command = {};
  let resources = {};
  let outputs;
  let taskTimeout;

  async function visit(path, isRoot = false) {
    signal?.throwIfAborted();
    if (visiting.has(path)) throw new Error("Taskfile inheritance cycle");
    if (done.has(path)) return;
    if (visiting.size + done.size >= 32) throw new RangeError("Taskfile inheritance exceeds 32 files");
    visiting.add(path);
    const recipe = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, maxTemplateBytes)));
    fields(recipe, ["version", "kind", "extends", "requires", "layers", "command", "resources", "task_timeout_s", "outputs", "metadata"], "Taskfile");
    if (recipe.version !== "0.1" || recipe.kind !== (isRoot ? "task" : "base")) {
      throw new Error(isRoot ? "Expected a 0.1 Taskfile task" : "Only 0.1 Taskfile bases can be extended");
    }
    if (recipe.metadata !== undefined && !map(recipe.metadata)) throw new TypeError("Taskfile metadata must be an object");
    const directory = dirname(path);
    const parents = recipe.extends ?? [];
    if (!Array.isArray(parents) || parents.length > 16) throw new TypeError("extends must be an array of at most 16 Taskfile paths");
    for (const parent of parents) await visit(await scopedPath(root, directory, parent));
    requirements(required, recipe.requires);
    const layers = recipe.layers ?? [];
    if (!Array.isArray(layers) || layers.length > 16) throw new TypeError("layers must contain at most 16 recipes per Taskfile");
    for (const layer of layers) {
      if (!map(layer) || typeof layer.id !== "string" || !name.test(layer.id) || !string(layer.kind)) throw new TypeError("Invalid layer ID or recipe kind");
      if (recipes.has(layer.id)) throw new Error(`Duplicate Taskfile layer ID: ${layer.id}`);
      recipes.set(layer.id, { recipe: layer, directory });
    }
    if (recipe.command !== undefined) {
      fields(recipe.command, ["argv", "cwd"], "command");
      command = { ...command, ...recipe.command };
    }
    if (recipe.resources !== undefined) {
      fields(recipe.resources, ["cpu", "memory_mib", "disk_mib", "timeout_s"], "resources");
      resources = { ...resources, ...recipe.resources };
    }
    if (recipe.task_timeout_s !== undefined) {
      if (!Number.isSafeInteger(recipe.task_timeout_s) || recipe.task_timeout_s < 1) throw new TypeError("Invalid task_timeout_s");
      taskTimeout = recipe.task_timeout_s;
    }
    if (recipe.outputs !== undefined) {
      fields(recipe.outputs, ["paths"], "outputs");
      if (!Array.isArray(recipe.outputs.paths) || recipe.outputs.paths.some((path) => !workspacePath(path) || path === "/workspace")) {
        throw new TypeError("outputs.paths must contain workspace files");
      }
      outputs = recipe.outputs;
    }
    visiting.delete(path);
    done.add(path);
  }

  await visit(entry, true);
  const discovery = runner ?? await client?.capabilities({ signal });
  if (!discovery) throw new TypeError("Runner capabilities or a client are required");
  const selected = selectRunner(discovery, required);
  if (!Array.isArray(command.argv) || !command.argv.length || !string(command.argv[0])
    || command.argv.some((argument) => typeof argument !== "string" || !argument.isWellFormed() || argument.includes("\0"))) {
    throw new TypeError("A task command must supply an argv array with an executable");
  }
  command.cwd ??= "/workspace";
  if (!workspacePath(command.cwd)) {
    throw new TypeError("Command cwd must be inside /workspace");
  }
  const limits = discovery.limits ?? {};
  if (taskTimeout === undefined) throw new TypeError("The Taskfile or a base must supply task_timeout_s");
  if (taskTimeout > (limits.max_task_seconds ?? Infinity)) throw new RangeError("Task timeout exceeds the runner limit");
  resources = { ...discovery.resource_profile, ...resources };
  for (const field of resourceFields) {
    if (!Number.isInteger(resources[field]) || resources[field] <= 0) throw new TypeError(`Invalid resource request: ${field}`);
    if (discovery.resource_profile?.[field] !== undefined && resources[field] !== discovery.resource_profile[field]) throw new Error(`Runner does not offer requested resources.${field}`);
  }
  const minimum = Object.entries(required.resources);
  const available = discovery.resource_profiles ?? [resources];
  if (minimum.length && !available.some((offer) => minimum.every(([field, amount]) => offer[field] >= amount))) {
    throw new RangeError(`No advertised runner profile satisfies requires.resources ${JSON.stringify(required.resources)}`);
  }
  if (resources.timeout_s !== undefined && (!Number.isSafeInteger(resources.timeout_s) || resources.timeout_s < 1
    || resources.timeout_s > (limits.max_job_seconds ?? Infinity))) throw new Error("Command timeout is outside the runner limits");
  if (recipes.size > (limits.max_layers ?? 16)) throw new RangeError("Taskfile contains too many layers");
  const evaluated = [];
  const layerSources = {};
  let total = 0;
  const maxBytes = limits.max_layer_bytes ?? 4 * 1024 ** 2;
  function addLayer(id, descriptor) {
    total += descriptor.size;
    evaluated.push({ id, descriptor });
  }
  for (const [id, { recipe, directory }] of recipes) {
    signal?.throwIfAborted();
    const validate = (size, mediaType) => {
      if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || total + size > (limits.max_input_bytes ?? Infinity)) {
        throw new RangeError("Layers exceed the runner byte limits");
      }
      if (!discovery.layer_media_types?.includes(mediaType)) throw new Error(`Runner does not support layer media type ${mediaType}`);
    };
    if (recipe.kind === "artifact") {
      fields(recipe, ["id", "kind", "task_id", "path", "media_type"], "artifact layer");
      if (!client || !discovery.features?.includes("artifact-layer-source")) throw new Error("Artifact layers need a client and a supporting runner");
      if (!/^[0-9a-f-]{36}$/u.test(recipe.task_id) || !workspacePath(recipe.path) || recipe.path === "/workspace") {
        throw new TypeError("An artifact layer requires a producer task ID and an absolute workspace artifact path");
      }
      const media_type = recipe.media_type ?? TAR;
      if (![TAR, TAR_GZIP].includes(media_type)) throw new TypeError("Expected an OCI tar media type");
      const { artifacts } = await client.artifacts(recipe.task_id, { signal });
      const artifact = artifacts.find(({ path }) => path === recipe.path);
      if (!artifact || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)) throw new Error(`No artifact at ${recipe.path}`);
      validate(artifact.size, media_type);
      const descriptor = { digest: artifact.digest, size: artifact.size, media_type };
      layerSources[descriptor.digest] = { task_id: recipe.task_id, path: recipe.path };
      addLayer(id, descriptor);
      continue;
    }
    const plugin = Object.hasOwn(layerBuilders, recipe.kind) ? layerBuilders[recipe.kind] : undefined;
    const buildResources = {};
    if (recipe.build_resources !== undefined) mergeMinimums(buildResources, recipe.build_resources, "build_resources");
    const context = { root, directory, maxBytes, signal, cache, buildResources, buildEngines };
    const parents = evaluated.map(({ descriptor }) => ({ ...descriptor }));
    const buildContext = {
      ...selected, parents, runner: discovery, signal, maxBytes, buildResources,
      resolvePath: (path) => scopedPath(root, directory, path),
    };
    const plan = await builtinLayer(recipe, context)
      ?? (typeof plugin === "function" ? { build: () => plugin(recipe, buildContext) }
        : plugin && string(plugin.version) && typeof plugin.fingerprint === "function" && typeof plugin.build === "function"
          ? { version: plugin.version, fingerprint: () => plugin.fingerprint(recipe, buildContext),
            build: () => plugin.build(recipe, buildContext) }
          : undefined);
    if (!plan) throw new Error(`Unsupported layer recipe: ${recipe.kind}`);
    const build = async () => {
      const result = await plan.build();
      if (!result || !(result.bytes instanceof Uint8Array) || !result.bytes.length) throw new Error(`Empty layer recipe: ${recipe.kind}`);
      validate(result.bytes.length, result.mediaType);
      return result;
    };
    let descriptor;
    if (plan.fingerprint && (plan.import ? typeof cache.resolveBuildDescriptor === "function" : typeof cache.resolveBuild === "function")) {
      const inputs = await plan.fingerprint();
      if (!string(inputs)) throw new Error(`Layer fingerprint must be a nonempty string: ${recipe.kind}`);
      const key = buildKey(["taskfile-layer", 1, recipe.kind, plan.version, selected.platform.os, selected.platform.arch,
        selected.base.id, selected.base.digest, parents.map((layer) => [layer.digest, layer.size, layer.media_type]), inputs]);
      descriptor = plan.import ? await cache.resolveBuildDescriptor(key, plan.import, { signal })
        : await cache.resolveBuild(key, build, { signal });
    } else if (plan.import) {
      descriptor = await plan.import();
    } else {
      const result = await build();
      descriptor = await cache.put(result.bytes, result.mediaType);
    }
    validate(descriptor.size, descriptor.media_type);
    addLayer(id, descriptor);
  }
  const manifest = {
    protocol_version: "0.1", client_request_id: requestId, task_timeout_s: taskTimeout, platform: selected.platform,
    environment: { base: selected.base, layers: evaluated.map(({ descriptor }) => descriptor) },
    command, resources, ...(minimum.length && discovery.resource_profiles && { min_resources: required.resources }),
    ...(Object.keys(layerSources).length && { layer_sources: layerSources }),
    network: { mode: "none" }, ...(outputs ? { outputs } : {}),
  };
  return { manifest, layers: evaluated };
}

export async function runTaskFile(file, { client, cache, onAccepted, signal, ...options } = {}) {
  if (!client || typeof cache?.source !== "function") throw new TypeError("A runner client and readable layer cache are required");
  if (!cache.leasePath && typeof cache.forWorkspace === "function") {
    cache = await cache.forWorkspace(options.contextRoot ?? dirname(resolve(file)));
  }
  const prepared = await prepareTaskFile(file, { ...options, client, cache, signal });
  const task = await client.submit(prepared.manifest, { signal });
  await onAccepted?.(task);
  const outcome = await client.wait(task.task_id, { source: cache.open ?? cache.source, signal });
  return { ...prepared, task: outcome };
}
