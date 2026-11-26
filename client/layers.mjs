const encoder = new TextEncoder();

export const TAR = "application/vnd.oci.image.layer.v1.tar";
export const TAR_GZIP = `${TAR}+gzip`;
export const DEFAULT_LAYER_LIMIT = 4 * 1024 ** 2;

export async function layerDescriptor(bytes, media_type = TAR) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || ![TAR, TAR_GZIP].includes(media_type)) {
    throw new TypeError("Expected nonempty OCI layer bytes and a supported media type");
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { digest: `sha256:${Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")}`, size: bytes.length, media_type };
}

function parts(path) {
  if (typeof path !== "string" || !path.isWellFormed() || path.length > 1024) throw new TypeError("Invalid layer path");
  const names = path.split("/");
  if (names.length > 32 || names.some((name) => !name || name === "." || name === ".." || name.includes("\0") || name.startsWith(".wh."))) {
    throw new TypeError(`Invalid workspace-relative layer path: ${path}`);
  }
  return names;
}

function whiteout(name, opaque) {
  const names = name === "" && opaque ? [] : parts(name);
  if (opaque) names.push(".wh..wh..opq");
  else names.push(`.wh.${names.pop()}`);
  return names.join("/");
}

function headerFor(path, kind, size, executable, target) {
  const header = new Uint8Array(512);
  function write(offset, value, width) {
    const bytes = encoder.encode(value);
    if (bytes.length > width) throw new RangeError("Layer path exceeds the USTAR field limit");
    header.set(bytes, offset);
  }
  function octal(offset, value, width) { write(offset, value.toString(8).padStart(width - 1, "0") + "\0", width); }

  const name = path.split("/");
  while (encoder.encode(name.join("/")).length > 100 && name.length > 1) {
    const prefix = path.slice(0, path.length - name.join("/").length - 1);
    if (encoder.encode(prefix).length > 155) throw new RangeError("Layer path exceeds the USTAR prefix limit");
    name.shift();
  }
  const suffix = name.join("/");
  write(0, suffix, 100);
  if (suffix !== path) write(345, path.slice(0, path.length - suffix.length - 1), 155);
  octal(100, kind === "directory" || executable ? 0o755 : 0o644, 8);
  octal(108, 0, 8);
  octal(116, 0, 8);
  octal(124, size, 12);
  octal(136, 0, 12);
  header.fill(32, 148, 156);
  write(156, kind === "directory" ? "5" : kind === "symlink" ? "2" : "0", 1);
  if (target !== undefined) write(157, target, 100);
  write(257, "ustar\0" + "00", 8);
  write(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 8);
  return header;
}

// Build a deterministic workspace changeset from bytes or explicit whiteout entries.
export function buildLayer(entries, { maxBytes = DEFAULT_LAYER_LIMIT } = {}) {
  const prepared = new Map();
  let length = 1024;
  for (const entry of entries) {
    if (!["directory", "file", "symlink", "delete", "opaque"].includes(entry.kind)) throw new TypeError("Unknown layer entry kind");
    const marker = entry.kind === "delete" || entry.kind === "opaque";
    const path = marker ? whiteout(entry.path, entry.kind === "opaque") : parts(entry.path).join("/");
    if (prepared.has(path)) throw new TypeError(`Duplicate layer path: ${path}`);
    const data = entry.kind === "file" ? entry.bytes : new Uint8Array();
    const target = entry.kind === "symlink" ? entry.target : undefined;
    if (entry.kind === "symlink") {
      let depth = path.split("/").length - 1;
      let descending = false;
      if (typeof target !== "string" || !target || target.startsWith("/") || !target.isWellFormed() || target.includes("\0")
        || target.split("/").some((part) => {
          if (part === "..") return descending || --depth < 0;
          if (part && part !== ".") descending = true;
          return false;
        })) throw new TypeError(`Symlink target must stay inside the workspace with parent segments before named segments: ${path}`);
      if (encoder.encode(target).length > 100) throw new RangeError(`Symlink target exceeds the USTAR field limit: ${path}`);
    }
    if (!(data instanceof Uint8Array)) throw new TypeError("File entries require Uint8Array bytes");
    const blocks = Math.ceil(data.length / 512) * 512;
    length += 512 + blocks;
    if (length > maxBytes || prepared.size >= 4096) throw new RangeError("Layer exceeds the workspace profile limits");
    prepared.set(path, { data, blocks, kind: entry.kind, executable: entry.executable, target });
  }
  if (!Number.isSafeInteger(maxBytes) || length > maxBytes) throw new RangeError("Invalid or exceeded layer byte limit");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const path of [...prepared.keys()].sort()) {
    const { data, blocks, kind, executable, target } = prepared.get(path);
    bytes.set(headerFor(path, kind, data.length, executable, target), offset);
    offset += 512;
    bytes.set(data, offset);
    offset += blocks;
  }
  return bytes;
}
