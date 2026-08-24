import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';
import type { StorageAdapter } from './index.js';

/**
 * Cloudflare R2 (or MinIO, or AWS S3 - all speak the same protocol).
 *
 * Nothing here is exercised until R2 credentials exist. When they do, the only
 * change is STORAGE_DRIVER=s3 plus four environment variables.
 *
 * One R2-specific gotcha the local driver will not surface: browser PUTs to a
 * presigned R2 URL require CORS to be configured on the bucket in the
 * Cloudflare dashboard (allow PUT/GET from your portal origins, and expose
 * ETag). Without it uploads fail with an opaque network error.
 */
export function createS3Storage(): StorageAdapter {
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.s3Endpoint,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
  });
  const Bucket = env.R2_BUCKET;

  return {
    name: 's3',

    async createUploadUrl({ key, contentType, maxBytes, ttlSeconds = 900 }) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: maxBytes,
        }),
        { expiresIn: ttlSeconds },
      );
      return {
        uploadUrl: url,
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-length': String(maxBytes),
        },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },

    async createDownloadUrl({ key, ttlSeconds = 900 }) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },

    async putObject({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async statObject(key) {
      try {
        const res = await client.send(
          new HeadObjectCommand({ Bucket, Key: key }),
        );
        return { size: res.ContentLength ?? 0 };
      } catch {
        return null;
      }
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
