import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { directTransfers } from "./r2-transfer.mjs";

export async function s3Storage(env) {
  const bucket = env.SPOOL_S3_BUCKET;
  if (!bucket) return undefined;
  const region = env.SPOOL_S3_REGION ?? env.AWS_REGION ?? "us-east-1";
  const endpoint = env.SPOOL_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
  const client = new S3Client({ region, endpoint, forcePathStyle: true });
  const send = (Command, key, extra = {}, options) => client.send(new Command({ Bucket: bucket, Key: key, ...extra }), options);
  const headOrGet = async (Command, key, extra) => {
    try { return await send(Command, key, extra); }
    catch (error) {
      if ([404, 412].includes(error.$metadata?.httpStatusCode)) return undefined;
      throw error;
    }
  };
  const driver = {
    head(key) { return headOrGet(HeadObjectCommand, key); },
    async get(key, options) {
      const object = await headOrGet(GetObjectCommand, key, { IfMatch: options?.onlyIf?.etagMatches });
      if (!object) return undefined;
      return { size: object.ContentLength, etag: object.ETag, body: object.Body.transformToWebStream() };
    },
    delete(key) { return send(DeleteObjectCommand, key); },
    async createMultipartUpload(key) {
      return { uploadId: (await send(CreateMultipartUploadCommand, key)).UploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        abort: () => send(AbortMultipartUploadCommand, key, { UploadId: uploadId }),
        complete: (parts) => send(CompleteMultipartUploadCommand, key, {
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: '"' + etag + '"' })) },
        }),
      };
    },
    async publishVerified(key, etag, digest) {
      const source = [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
      await send(CopyObjectCommand, key + "-verified", { CopySource: source, CopySourceIfMatch: etag });
      const verified = await driver.get(key + "-verified");
      if (!verified || await hash(verified.body) !== digest) throw new Error("S3 object changed during verification");
    },
  };
  const hash = async (body) => {
    const digest = createHash("sha256");
    for await (const part of body) digest.update(part);
    return digest.digest("hex");
  };
  const transfers = directTransfers({ endpoint, bucket, credentials: client.config.credentials, region, driver, hash });
  return {
    transfers,
    blobs: {
      has: async (key) => Boolean(await driver.head(key)),
      open: async (key) => (await driver.get(key))?.body,
      delete: (key) => driver.delete(key),
      async putVerified(key, request, { size, digest }) {
        await send(PutObjectCommand, key, {
          Body: request.body ? Readable.fromWeb(request.body) : undefined, ContentLength: size,
          ChecksumSHA256: Buffer.from(digest.slice(7), "hex").toString("base64"),
        }, { abortSignal: request.signal });
      },
    },
  };
}
