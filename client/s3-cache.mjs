import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AwsClient } from "aws4fetch";
import { openLayerCache } from "./node.mjs";

export function openS3LayerCache(directory, storage, options) {
  return openLayerCache(directory, { ...options, backing: s3LayerStore(storage) });
}

export function s3LayerStore({
  bucket, region = "us-east-1", endpoint = `https://s3.${region}.amazonaws.com`,
  prefix = "spool/layers", credentials,
} = {}) {
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket ?? "")
    || typeof prefix !== "string" || (prefix && prefix.split("/").some((part) => !part || part === ".." || part === "."))) {
    throw new TypeError("Invalid S3 layer cache bucket, endpoint, or prefix");
  }
  const sdk = new S3Client({ region, endpoint, forcePathStyle: true, credentials });
  function key(digest) {
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new TypeError("Invalid layer digest");
    return (prefix ? prefix + "/" : "") + digest.slice(7);
  }
  async function send(Command, digest, extra, signal) {
    return sdk.send(new Command({ Bucket: bucket, Key: key(digest), ...extra }), { abortSignal: signal });
  }
  async function object(Command, digest, signal) {
    try { return await send(Command, digest, {}, signal); }
    catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }
  async function describe(digest, { signal } = {}) {
    const head = await object(HeadObjectCommand, digest, signal);
    if (!head) return undefined;
    if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength < 1
      || (head.Metadata?.["spool-sha256"] && head.Metadata["spool-sha256"] !== digest.slice(7))) {
      throw new Error(`Invalid S3 layer cache object for ${digest}`);
    }
    return { digest, size: head.ContentLength, media_type: head.ContentType };
  }
  async function has(descriptor, options) {
    const found = await describe(descriptor.digest, options);
    if (found && found.size !== descriptor.size) throw new Error(`S3 layer cache size mismatch for ${descriptor.digest}`);
    return Boolean(found);
  }
  return {
    describe, has,
    async read(digest, { signal } = {}) {
      const result = await object(GetObjectCommand, digest, signal);
      return result?.Body?.transformToWebStream();
    },
    async put(descriptor, blob, { signal } = {}) {
      if (await has(descriptor, { signal })) return;
      const { digest, size, media_type: mediaType } = descriptor;
      try {
        await send(PutObjectCommand, digest, {
          Body: Readable.fromWeb(blob.stream()), ContentLength: size, ContentType: mediaType,
          ChecksumSHA256: Buffer.from(digest.slice(7), "hex").toString("base64"),
          Metadata: { "spool-sha256": digest.slice(7) }, IfNoneMatch: "*",
        }, signal);
      } catch (error) {
        if (![409, 412].includes(error.$metadata?.httpStatusCode) || !await has(descriptor, { signal })) throw error;
      }
    },
    async plan(descriptor, { signal } = {}) {
      if (!await has(descriptor, { signal })) return undefined;
      const identity = await sdk.config.credentials();
      const ttl = Math.min(300, identity.expiration ? Math.floor((identity.expiration.getTime() - Date.now()) / 1000) : 300);
      if (ttl < 1) throw new Error("S3 cache signing credentials have expired");
      const url = new URL([bucket, ...key(descriptor.digest).split("/")].map(encodeURIComponent).join("/"), base);
      url.searchParams.set("X-Amz-Expires", String(ttl));
      const expires_at = new Date(Date.now() + ttl * 1000).toISOString();
      const signer = new AwsClient({ ...identity, region, service: "s3" });
      return { url: (await signer.sign(url, { method: "GET", aws: { signQuery: true } })).url, expires_at };
    },
  };
}
