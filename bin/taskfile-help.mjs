import taskfileSchema from "../protocol/taskfile.schema.json" with { type: "json" };
import manifestSchema from "../protocol/manifest.schema.json" with { type: "json" };
import example from "../protocol/taskfile-example.json" with { type: "json" };

const guide = `# Spool Taskfiles

A Taskfile is a UTF-8 JSON recipe. It describes what to build locally and what to
run in the remote workspace. Query the runner's capabilities for its platforms,
base images, features, byte limits, and resource profile.

## Author a task

- Use "version": "0.1" and "kind": "task" in the file you submit.
- Supply command.argv as an argument array. Use ["sh", "-ec", "…"] if you need
  shell syntax. command.cwd defaults to /workspace.
- Supply task_timeout_s in the task or a base. It covers uploads, queueing,
  startup, and execution. resources.timeout_s separately caps command runtime.
  The CPU, memory, and disk values default to the runner's resource profile.
  An explicit value must match that profile.
- List files to retrieve in outputs.paths using absolute paths under /workspace.
  Only declared output files are collected.
- Commands run without external network access. Include dependencies and
  input data in the selected base or prepared layers.

## Layers and paths

- A directory recipe has id, kind "directory", and path. It snapshots the
  directory's contents into the workspace root. Optional previous produces a
  delta. include and exclude accept paths and globs relative to the layer
  directory. A pattern matching a directory applies to its subtree.
- An archive recipe has id, kind "archive", and path to a prepared OCI layer.
  media_type defaults to application/vnd.oci.image.layer.v1.tar. Set
  application/vnd.oci.image.layer.v1.tar+gzip for a gzip layer.
- A sources recipe declares one or more source mappings. Each has a path
  relative to its Taskfile, an absolute /workspace destination, and optional
  include and exclude globs. Each mapping replaces its destination tree.
  The client builds deterministic archives and reuses cached bases with byte
  patches for small edits. Git metadata and helper scripts are optional.
- A docker recipe builds a layer on the client with Docker or Podman. Supply
  a digest-pinned image and argv. The selected input directory is available as
  /inputs.tar. Write the output archive to /build/layer.tar. Each recipe can set
  build_resources with minimum cpu, memory_mib, and disk_mib. These select the
  client's build engine independently of the task's runner profile.
- An artifact recipe references a producer task_id and its archive path.
  The same runner can use it as a verified layer without a client upload.
- Paths in extends and layer recipes are relative to the Taskfile that declares
  them and must resolve inside the project workspace. Guest command and output
  paths refer to the assembled /workspace. The host checkout isn't mounted.
- Layers apply in order. Later layers can replace files from earlier ones.
  Layer IDs must be unique across the task and its bases. The client builds
  content digests and uploads only layers the runner requests.
- Keep frequently edited scripts separate from stable inputs to reuse the
  stable layer when a script changes.

## Inheritance and requirements

- Use "kind": "base" for reusable files. extends visits bases in listed order,
  ancestors first, and includes shared ancestors once. Cycles are rejected.
- Layers append. Later files override command and resources field by field.
  Later task_timeout_s and outputs replace their inherited values.
- requires.platform and requires.base must agree across all inherited files.
  requires.features is the union. requires.limits takes the highest minimum for
  each named runner limit. requires.resources takes the highest inherited
  minimum for each of cpu, memory_mib, and disk_mib. For example,
  "requires": { "resources": { "cpu": 2, "memory_mib": 4096 } }.
  Check resource_profiles in capabilities and the selected resource_profile in
  task status. If a platform or base is omitted, the client selects the first
  advertised choice.
- metadata can hold local annotations. JavaScript SDK users can add recipe
  kinds and read buildResources from their local builder context.

## Run through MCP

1. Configure the local project root with spool-mcp init --profile NAME --workspace .
2. Call capabilities to confirm the runner's limits.
3. Call submit_template with the relative Taskfile path. Save its task_id.
   Optional shards runs independent copies with SPOOL_SHARD_INDEX and
   SPOOL_SHARD_COUNT. Wait on every returned task ID.
4. Call wait_task with that ID. It uploads requested layers from the local cache
   and returns the task state. Use wait_s of at most 100 for each call and
   call again when the task state is still nonterminal.
5. Use task_events to page through logs. Pass next_cursor from the previous page
   as cursor to continue. Use task_artifacts and read_artifact for outputs.
   read_artifact reads files up to 512 KiB and supports UTF-8 text.
   Use download_artifact to save larger files under the workspace.

To submit directly, run spool-mcp run Taskfile.json --profile NAME.
Allow sibling sources with --source-root DIR. Optional local diff commands
require --allow-source-diff-command. See the README for Git and VCDIFF examples.

Run spool-mcp taskfile example or call taskfile_help with topic "example" for
the three files of a runnable example. Use topic "schema" for the JSON schemas.
`;

const schemas = { "taskfile.schema.json": taskfileSchema, "manifest.schema.json": manifestSchema };
const asJSON = (value) => JSON.stringify(value, null, 2);
export const taskfileTopics = ["guide", "schema", "example"];

export function taskfileHelp(topic) {
  switch (topic) {
    case "guide": return { topic, markdown: guide };
    case "schema": return { topic, schemas };
    case "example": return { topic, files: example };
    default: throw new TypeError("Choose guide, schema, or example");
  }
}

const resource = (path, name, description, text, mimeType = "application/json") =>
  ({ uri: "spool://taskfile/" + path, name, description, mimeType, text });

export const taskfileResources = [
  resource("guide", "Taskfile guide", "Syntax, inheritance, layer semantics, and the MCP workflow", guide, "text/markdown"),
  resource("taskfile.schema.json", "Taskfile schema", "JSON Schema for task and base recipes", asJSON(taskfileSchema)),
  resource("manifest.schema.json", "Manifest schema", "Workspace paths, outputs, and the resolved submission format", asJSON(manifestSchema)),
  resource("example", "Runnable Taskfile example", "Map of project-relative filenames to file contents", asJSON(example)),
];
