import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Fault } from "./contract.mjs";

export function fileBlobs(root, legacy) {
  const path = (key) => join(root, key);
  return {
    async has(key) {
      return access(path(key)).then(() => true, (error) => {
        if (error.code === "ENOENT") return legacy.has(key);
        throw error;
      });
    },
    async open(key) {
      try {
        await access(path(key));
        return Readable.toWeb(createReadStream(path(key)));
      } catch (error) {
        if (error.code === "ENOENT") return legacy.get(key);
        throw error;
      }
    },
    async putVerified(key, request, descriptor) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = target + "." + crypto.randomUUID();
      const hash = createHash("sha256");
      let size = 0;
      const verify = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          if (size > descriptor.size) return done(new Fault("LAYER_INVALID", "Layer exceeds its declared size", 422));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        const input = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
        await pipeline(input, verify, createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
          { signal: request.signal });
        if (size !== descriptor.size || `sha256:${hash.digest("hex")}` !== descriptor.digest) {
          throw new Fault("LAYER_INVALID", "Layer length or digest does not match the descriptor", 422);
        }
        const written = await open(temporary, "r");
        try { await written.sync(); } finally { await written.close(); }
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async delete(key) {
      await rm(path(key), { force: true });
      legacy.delete(key);
    },
  };
}
