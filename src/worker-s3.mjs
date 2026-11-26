import { AwsClient } from "aws4fetch";
// The CommonJS entry provides the pure JavaScript XML parser for workerd.
import { parseXML } from "@aws-sdk/xml-builder/dist-cjs/index.js";
import { directTransfers, hashWorkerStream, objectURLFor } from "./r2-transfer.mjs";
import { readBytes } from "./contract.mjs";
import { createWorkerRunner, TenantRunner as WorkerTenantRunner } from "./worker.mjs";
export { GuestSlot } from "./worker.mjs";

export function workerS3Storage(env) {
  const { SPOOL_S3_ACCESS_KEY_ID: accessKeyId, SPOOL_S3_SECRET_ACCESS_KEY: secretAccessKey,
    SPOOL_S3_SESSION_TOKEN: sessionToken, SPOOL_S3_BUCKET: bucket, SPOOL_S3_REGION: region = "us-east-1",
    SPOOL_S3_ENDPOINT: endpoint = `https://s3.${region}.amazonaws.com` } = env;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 storage requires SPOOL_S3_BUCKET, SPOOL_S3_ACCESS_KEY_ID, and SPOOL_S3_SECRET_ACCESS_KEY");
  }
  const objectURL = objectURLFor(endpoint, bucket);
  const credentials = { accessKeyId, secretAccessKey, sessionToken };
  const client = new AwsClient({ ...credentials, region, service: "s3" });

  async function request(method, key, { query, headers, body, signal, missing = false } = {}) {
    const url = objectURL(key);
    if (query) url.search = new URLSearchParams(query);
    const signed = await client.sign(url, { method, headers, body, signal, redirect: "manual" });
    const response = await fetch(signed);
    if (response.ok) return response;
    await response.body?.cancel();
    if (missing && [404, 412].includes(response.status)) return undefined;
    throw new Error(`S3 ${method} returned HTTP ${response.status}`);
  }

  async function xmlResult(response, tag) {
    const result = parseXML(new TextDecoder().decode(await readBytes(response, 128 * 1024)));
    if (!Object.hasOwn(result, tag)) throw new Error(`S3 did not return ${tag}`);
    return result[tag];
  }

  const driver = {
    head: (key) => request("HEAD", key, { missing: true }),
    async get(key) {
      const response = await request("GET", key, { missing: true });
      if (response) return {
        body: response.body, size: Number(response.headers.get("content-length")), etag: response.headers.get("etag"),
      };
    },
    async delete(key) {
      const response = await request("DELETE", key, { missing: true });
      await response?.body?.cancel();
    },
    async createMultipartUpload(key) {
      const result = await xmlResult(await request("POST", key, { query: { uploads: "" } }), "InitiateMultipartUploadResult");
      if (typeof result.UploadId !== "string" || !result.UploadId) throw new Error("S3 did not return a multipart upload ID");
      return { uploadId: result.UploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        async abort() {
          const response = await request("DELETE", key, { query: { uploadId }, missing: true });
          await response?.body?.cancel();
        },
        async complete(parts) {
          const body = "<CompleteMultipartUpload>" + parts.map(({ partNumber, etag }) =>
            `<Part><PartNumber>${partNumber}</PartNumber><ETag>"${etag}"</ETag></Part>`).join("") + "</CompleteMultipartUpload>";
          await xmlResult(await request("POST", key, { query: { uploadId }, body,
            headers: { "content-type": "application/xml" } }), "CompleteMultipartUploadResult");
        },
      };
    },
    async publishVerified(key, etag, digest) {
      if (!etag) throw new Error("S3 did not return an ETag");
      const verifiedKey = key + "-verified";
      await xmlResult(await request("PUT", verifiedKey, { headers: {
        "x-amz-copy-source": objectURL(key).pathname, "x-amz-copy-source-if-match": etag,
      } }), "CopyObjectResult");
      const object = await driver.get(verifiedKey);
      if (!object || await hashWorkerStream(object.body) !== digest) throw new Error("S3 object changed during verification");
    },
  };
  const layers = {
    has: async (key) => Boolean(await driver.head(key)),
    open: async (key) => (await driver.get(key))?.body,
    delete: driver.delete,
    async putVerified(key, input, { size, digest }) {
      const stream = new FixedLengthStream(size);
      const hex = digest.slice(7);
      const checksum = btoa(String.fromCharCode(...hex.match(/../gu).map((pair) => parseInt(pair, 16))));
      const signal = input.signal;
      await Promise.all([
        (input.body ?? new Response(new Uint8Array()).body).pipeTo(stream.writable, { signal }),
        request("PUT", key, { body: stream.readable, signal, headers: {
          "x-amz-content-sha256": hex, "x-amz-checksum-sha256": checksum,
        } }).then((response) => response.body?.cancel()),
      ]);
    },
  };
  const transfers = directTransfers({ endpoint, bucket, region, credentials: () => credentials, driver });
  return { layers, transfers, artifacts: {
    open: layers.open, delete: layers.delete, putVerified: layers.putVerified, presignDownload: transfers.download,
  } };
}

export class TenantRunner extends WorkerTenantRunner {
  static storage = workerS3Storage;
}

export function createS3WorkerRunner(options = {}) {
  return createWorkerRunner({ ...options, storage: workerS3Storage });
}

export default createS3WorkerRunner();
