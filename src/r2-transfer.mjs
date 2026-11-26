import { AwsClient } from "aws4fetch";
import { Fault } from "./contract.mjs";

const MIB = 1024 ** 2;
export const directSingleBytes = 32 * MIB;
const partBytes = 32 * MIB;

export function r2Transfers(env) {
  const { SPOOL_R2_ENDPOINT: endpoint, SPOOL_R2_BUCKET: bucket,
    SPOOL_R2_ACCESS_KEY_ID: accessKeyId, SPOOL_R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (![endpoint, bucket, accessKeyId, secretAccessKey].some(Boolean)) return undefined;
  if (![endpoint, bucket, accessKeyId, secretAccessKey].every(Boolean)) throw new Error("Incomplete R2 upload configuration");
  return directTransfers({ endpoint, bucket, accessKeyId, secretAccessKey, region: "auto", driver: env.LAYERS });
}

export function directTransfers({ endpoint, bucket, accessKeyId, secretAccessKey, credentials, region, driver, hash }) {
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || !/^[a-z0-9.-]+$/u.test(bucket)) throw new Error("Invalid object storage endpoint or bucket");
  const client = credentials ? undefined : new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3" });

  async function signed(key, size, expires, query = {}) {
    const url = new URL([bucket, ...key.split("/")].map(encodeURIComponent).join("/"), base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    // Uploads sign the expected content length. GETs carry no request body.
    const signer = client ?? new AwsClient({ ...await credentials(), region, service: "s3" });
    const remaining = Math.floor((expires - Date.now()) / 1000);
    if (size === undefined && remaining < 1) return undefined;
    url.searchParams.set("X-Amz-Expires", String(Math.max(1, remaining)));
    const request = await signer.sign(url, {
      method: size === undefined ? "GET" : "PUT",
      headers: size === undefined ? undefined : { "content-length": String(size) },
      aws: { signQuery: true, allHeaders: true },
    });
    return request.url;
  }

  return {
    download: (key, expires) => signed(key, undefined, expires),
    kind(size) { return size > directSingleBytes ? "presigned-multipart" : "presigned-put"; },
    async create({ storage, size }) {
      if (this.kind(size) !== "presigned-multipart") return {};
      const upload = await driver.createMultipartUpload(storage);
      return { uploadId: upload.uploadId };
    },
    async plan(stage, descriptor) {
      const { storage, uploadId, expires } = stage;
      const type = this.kind(descriptor.size);
      if (type === "presigned-put") {
        return { type, method: "PUT", authenticated: false, url: await signed(storage, descriptor.size, expires) };
      }
      const parts = [];
      for (let offset = 0, number = 1; offset < descriptor.size; offset += partBytes, number++) {
        const size = Math.min(partBytes, descriptor.size - offset);
        parts.push({ number, offset, size, url: await signed(storage, size, expires,
          { uploadId, partNumber: number }) });
      }
      return { type, method: "PUT", authenticated: false, parts, part_size: partBytes };
    },
    async confirm(stage, descriptor, parts) {
      if (stage.uploadId && !await driver.head(stage.storage)) {
        if (!Array.isArray(parts) || parts.length !== Math.ceil(descriptor.size / partBytes)
          || parts.some((part, index) => part?.number !== index + 1 || typeof part.etag !== "string"
            || !/^(?:[a-fA-F0-9]{32}|"[a-fA-F0-9]{32}")$/u.test(part.etag))) {
          throw new Fault("LAYER_INVALID", "Supply the ETag for each ordered multipart part", 422);
        }
        const upload = driver.resumeMultipartUpload(stage.storage, stage.uploadId);
        try { await upload.complete(parts.map(({ number, etag }) => ({ partNumber: number, etag: etag.replaceAll('"', "") }))); }
        catch { throw new Fault("LAYER_INVALID", "R2 has not accepted every part", 422); }
      }
      const object = await driver.get(stage.storage);
      if (!object) throw new Fault("LAYER_UNAVAILABLE", "Upload has not reached R2", 409);
      if (object.size !== descriptor.size) {
        await object.body.cancel();
        throw new Fault("LAYER_INVALID", "Uploaded object has the wrong size", 422);
      }
      let digest;
      if (hash) digest = await hash(object.body);
      else {
        const stream = new crypto.DigestStream("SHA-256");
        await Promise.all([object.body.pipeTo(stream), stream.digest]);
        digest = Array.from(new Uint8Array(await stream.digest), (part) => part.toString(16).padStart(2, "0")).join("");
      }
      if (`sha256:${digest}` !== descriptor.digest) {
        const error = new Fault("LAYER_INVALID", "Uploaded object failed SHA-256 verification", 422);
        error.replaceUpload = Boolean(stage.uploadId);
        throw error;
      }
      // Single PUT URLs can be replayed. Publish an immutable content-addressed copy.
      if (!stage.uploadId) {
        if (driver.publishVerified) {
          await driver.publishVerified(stage.storage, object.etag, digest);
          return stage.storage + "-verified";
        }
        const verified = await driver.get(stage.storage, { onlyIf: { etagMatches: object.etag } });
        if (!verified?.body) throw new Fault("LAYER_INVALID", "Uploaded object changed during verification", 422);
        await driver.put(stage.storage + "-verified", verified.body, { sha256: digest });
        return stage.storage + "-verified";
      }
      return stage.storage;
    },
    async discard(stage) {
      if (stage.keep === stage.storage) return;
      if (stage.uploadId) await driver.resumeMultipartUpload(stage.storage, stage.uploadId).abort().catch(() => {});
      await driver.delete(stage.storage);
      if (!stage.keep) await driver.delete(stage.storage + "-verified");
    },
  };
}
