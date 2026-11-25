import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildDirectoryLayer } from "./node.mjs";
import { TAR } from "./layers.mjs";

const maxTemplateBytes = 128 * 1024;
const map = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string" && value.length > 0 && value.isWellFormed() && !value.includes("\0");
const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
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

function requirements(target, requirements = {}) {
  fields(requirements, ["platform", "base", "features", "limits"], "requires");
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
  const { root, directory, maxBytes, signal } = context;
  if (recipe.kind === "directory") {
    fields(recipe, ["id", "kind", "path", "previous", "exclude"], "directory layer");
    const paths = await Promise.all([scopedPath(root, directory, recipe.path),
      recipe.previous === undefined ? undefined : scopedPath(root, directory, recipe.previous)]);
    const exclude = recipe.exclude ?? [];
    if (!Array.isArray(exclude) || exclude.some((item) => !string(item)
      || item.split("/").some((component) => !component || component === "." || component === ".."))) {
      throw new TypeError("exclude must contain workspace-relative paths");
    }
    return { bytes: await buildDirectoryLayer(paths[0], {
      previous: paths[1], maxBytes, signal,
      include: (path) => !exclude.some((excluded) => path === excluded || path.startsWith(`${excluded}/`)),
    }), mediaType: TAR };
  }
  if (recipe.kind === "archive") {
    fields(recipe, ["id", "kind", "path", "media_type"], "archive layer");
    return { bytes: await regularFile(await scopedPath(root, directory, recipe.path), maxBytes), mediaType: recipe.media_type ?? TAR };
  }
  return undefined;
}

export async function prepareTaskFile(file, {
  contextRoot = dirname(resolve(file)), runner, client, cache, layerBuilders = {}, requestId = crypto.randomUUID(), signal,
} = {}) {
  if (!cache || typeof cache.put !== "function") throw new TypeError("A writable layer cache is required");
  if (!string(requestId) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) throw new TypeError("Invalid task request ID");
  const root = await realpath(contextRoot);
  const entry = await scopedPath(root, root, relative(resolve(contextRoot), resolve(file)));
  const required = { features: new Set(), limits: new Map() };
  const done = new Set();
  const visiting = new Set();
  const recipes = new Map();
  let command = {};
  let resources = {};
  let outputs;

  async function visit(path, isRoot = false) {
    signal?.throwIfAborted();
    if (visiting.has(path)) throw new Error("Taskfile inheritance cycle");
    if (done.has(path)) return;
    if (visiting.size + done.size >= 32) throw new RangeError("Taskfile inheritance exceeds 32 files");
    visiting.add(path);
    const recipe = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, maxTemplateBytes)));
    fields(recipe, ["version", "kind", "extends", "requires", "layers", "command", "resources", "outputs", "metadata"], "Taskfile");
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
  resources = { ...discovery.resource_profile, timeout_s: Math.min(60, limits.max_job_seconds ?? 60), ...resources };
  for (const field of ["cpu", "memory_mib", "disk_mib", "timeout_s"]) {
    if (!Number.isInteger(resources[field]) || resources[field] <= 0) throw new TypeError(`Invalid resource request: ${field}`);
    if (field !== "timeout_s" && discovery.resource_profile?.[field] !== undefined
      && resources[field] !== discovery.resource_profile[field]) throw new Error(`Runner does not offer requested resources.${field}`);
  }
  if (resources.timeout_s > (limits.max_job_seconds ?? Infinity)) throw new Error("Task timeout exceeds the runner limit");
  if (recipes.size > (limits.max_layers ?? 16)) throw new RangeError("Taskfile contains too many layers");
  const evaluated = [];
  let total = 0;
  const maxBytes = limits.max_layer_bytes ?? 4 * 1024 ** 2;
  for (const [id, { recipe, directory }] of recipes) {
    signal?.throwIfAborted();
    const context = { root, directory, maxBytes, signal };
    const result = await builtinLayer(recipe, context) ?? (
      Object.hasOwn(layerBuilders, recipe.kind)
        ? await layerBuilders[recipe.kind](recipe, {
          ...selected, runner: discovery, signal, maxBytes,
          resolvePath: (path) => scopedPath(root, directory, path),
        })
        : undefined
    );
    if (!result || !(result.bytes instanceof Uint8Array) || !result.bytes.length) throw new Error(`Unsupported or empty layer recipe: ${recipe.kind}`);
    total += result.bytes.length;
    if (result.bytes.length > maxBytes || total > (limits.max_input_bytes ?? Infinity)) throw new RangeError("Layers exceed the runner byte limits");
    if (!discovery.layer_media_types?.includes(result.mediaType)) throw new Error(`Runner does not support layer media type ${result.mediaType}`);
    evaluated.push({ id, descriptor: await cache.put(result.bytes, result.mediaType) });
  }
  const manifest = {
    protocol_version: "0.1", client_request_id: requestId, platform: selected.platform,
    environment: { base: selected.base, layers: evaluated.map(({ descriptor }) => descriptor) },
    command, resources, network: { mode: "none" }, ...(outputs ? { outputs } : {}),
  };
  return { manifest, layers: evaluated };
}

export async function runTaskFile(file, { client, cache, onAccepted, signal, ...options } = {}) {
  if (!client || typeof cache?.source !== "function") throw new TypeError("A runner client and readable layer cache are required");
  const prepared = await prepareTaskFile(file, { ...options, client, cache, signal });
  const task = await client.submit(prepared.manifest, { signal });
  await onAccepted?.(task);
  const outcome = await client.wait(task.task_id, { source: cache.source, signal });
  return { ...prepared, task: outcome };
}
