import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const magic = Buffer.from([0xd6, 0xc3, 0xc4, 0, 0]);
const windowSize = 1024 * 1024;

function integer(value) {
  const bytes = [value % 128];
  for (value = Math.floor(value / 128); value !== 0; value = Math.floor(value / 128)) {
    bytes.unshift(128 + value % 128);
  }
  return Buffer.from(bytes);
}

function segments(base, target, alignedOffset) {
  if (base.subarray(alignedOffset, alignedOffset + target.length).equals(target)) {
    return [{ offset: alignedOffset, length: target.length }];
  }
  // Sample the source and search every byte of the target so insertions can shift alignment.
  const anchors = new Map();
  for (let offset = 0; offset + 8 <= base.length; offset += 32) {
    const key = base.readBigUInt64LE(offset);
    if (!anchors.has(key)) anchors.set(key, offset);
  }
  const result = [];
  let literal = 0;
  for (let at = 0; at + 8 <= target.length;) {
    const key = target.readBigUInt64LE(at);
    const aligned = alignedOffset + at;
    const offset = aligned + 8 <= base.length && base.readBigUInt64LE(aligned) === key ? aligned : anchors.get(key);
    if (offset === undefined) {
      at++;
      continue;
    }
    let length = 8;
    const max = Math.min(base.length - offset, target.length - at);
    while (length < max && base[offset + length] === target[at + length]) length++;
    if (at > literal) result.push({ data: target.subarray(literal, at) });
    result.push({ offset, length });
    at += length;
    literal = at;
  }
  if (literal < target.length) result.push({ data: target.subarray(literal) });
  return result;
}

function encodeWindow(base, target, sourceOffset, alignedOffset) {
  const data = [];
  const commands = [];
  const addresses = [];
  for (const instruction of segments(base, target, alignedOffset)) {
    if (instruction.data) {
      data.push(instruction.data);
      commands.push(Buffer.from([1]), integer(instruction.data.length));
    } else {
      commands.push(Buffer.from([19]), integer(instruction.length));
      addresses.push(integer(instruction.offset));
    }
  }
  const fields = [data, commands, addresses].map((field) => Buffer.concat(field));
  const delta = Buffer.concat([integer(target.length), Buffer.from([0]), ...fields.map((field) => integer(field.length)), ...fields]);
  const source = base.length ? [Buffer.from([1]), integer(base.length), integer(sourceOffset)] : [Buffer.from([0])];
  return Buffer.concat([...source, integer(delta.length), delta]);
}

async function writeDefaultPatch(output, base, current, limit, signal) {
  let written = magic.length;
  await output.writeFile(magic);
  for (let offset = 0; offset < current.size; offset += windowSize) {
    signal?.throwIfAborted();
    const sourceOffset = Math.min(base.size, Math.max(0, offset - windowSize));
    const [source, target] = await Promise.all([
      base.slice(sourceOffset, offset + 2 * windowSize).arrayBuffer(),
      current.slice(offset, offset + windowSize).arrayBuffer(),
    ]);
    const window = encodeWindow(Buffer.from(source), Buffer.from(target), sourceOffset, offset - sourceOffset);
    written += window.length;
    if (written > limit) return false;
    await output.writeFile(window);
  }
  return true;
}

async function treeFingerprint(root, signal) {
  const tree = createHash("sha256");
  async function visit(path) {
    signal?.throwIfAborted();
    const file = join(root, path);
    const stat = await lstat(file);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path ? path + "/" + name : name);
    } else if (stat.isSymbolicLink()) {
      tree.update(JSON.stringify([path, "symlink", await readlink(file)]));
    } else if (stat.isFile()) {
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
      tree.update(JSON.stringify([path, "file", Boolean(stat.mode & 0o111), digest.digest("hex")]));
    } else {
      throw new Error(`Unexpected entry after applying Git patch: ${path}`);
    }
  }
  await visit("");
  return tree.digest("hex");
}

async function gitPatch(temp, diff, commandSignal) {
  const patch = join(temp, "changes.patch");
  try {
    for (const name of ["base", "current"]) {
      await mkdir(join(temp, name), { mode: 0o700 });
      await exec("tar", ["-xf", name + ".tar", "-C", name], { cwd: temp, signal: commandSignal, maxBuffer: 64 * 1024 });
    }
    const [program, ...args] = diff.argv.map((arg) => arg === "{base}" ? "base" : arg === "{current}" ? "current" : arg);
    const output = await open(patch, "wx", 0o600);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(program, args, { cwd: temp, signal: commandSignal, stdio: ["ignore", output.fd, "ignore"] });
        child.once("error", reject);
        child.once("close", (code) => code === 0 || code === 1 ? resolve() : reject(new Error(`Git diff exited with status ${code}`)));
      });
    } finally {
      await output.close();
    }
    if ((await lstat(patch)).size) {
      await exec("git", ["-c", "core.symlinks=true", "apply", "--binary", "--whitespace=nowarn", `-p${diff.strip ?? 2}`, patch], {
        cwd: join(temp, "base"), signal: commandSignal, maxBuffer: 64 * 1024,
      });
    }
  } catch (error) {
    commandSignal.throwIfAborted();
    throw new Error(`Git patch command failed: ${String(error.stderr || error.message).trim().slice(0, 512)}`, { cause: error });
  }
  const [applied, expected] = await Promise.all(["base", "current"].map((name) => treeFingerprint(join(temp, name), commandSignal)));
  if (applied !== expected) throw new Error("Git patch does not recreate the source snapshot. Use a VCDIFF command for changes Git cannot represent.");
}

export async function writeSourcePatch(path, temp, before, after, target, { diff, directory, limit, signal }) {
  const envelope = Buffer.alloc(40);
  envelope.writeBigUInt64BE(BigInt(target.size));
  Buffer.from(target.digest.slice(7), "hex").copy(envelope, 8);
  const output = await open(path, "wx", 0o600);
  try {
    await output.writeFile(envelope);
    if (!diff) return await writeDefaultPatch(output, before, after, limit - envelope.length, signal);
    const inputs = { "{base}": join(temp, "base.tar"), "{current}": join(temp, "current.tar"), "{patch}": join(temp, "diff.vcdiff") };
    await Promise.all([[before, inputs["{base}"]], [after, inputs["{current}"]]].map(([blob, file]) =>
      pipeline(blob.stream(), createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal })));
    const timeout = AbortSignal.timeout(60_000);
    const commandSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (diff.format === "git") {
      await gitPatch(temp, diff, commandSignal);
      return await writeDefaultPatch(output, before, after, limit - envelope.length, signal);
    }
    const [program, ...args] = diff.argv.map((token) => Object.hasOwn(inputs, token) ? inputs[token] : token);
    try {
      await exec(program, args, { cwd: directory, signal: commandSignal, maxBuffer: 64 * 1024 });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`diff command failed: ${timeout.aborted ? "deadline exceeded" : String(error.stderr || error.message).trim().slice(0, 512)}`);
    }
    const patch = await open(inputs["{patch}"], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await patch.stat();
      const header = Buffer.alloc(magic.length);
      await patch.read(header, 0, header.length, 0);
      if (!info.isFile() || info.size <= magic.length || !header.equals(magic)) {
        throw new Error("diff command must write a VCDIFF patch with the default code table and no optional headers");
      }
      if (info.size + envelope.length > limit) return false;
      let length = 0;
      for await (const chunk of patch.createReadStream({ start: 0, autoClose: false })) {
        signal?.throwIfAborted();
        length += chunk.length;
        if (length > info.size) throw new Error("diff output changed while being read");
        await output.writeFile(chunk);
      }
      if (length !== info.size) throw new Error("diff output changed while being read");
      return true;
    } finally {
      await patch.close();
    }
  } finally {
    await output.close();
  }
}
