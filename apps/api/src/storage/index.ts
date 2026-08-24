import { env } from '../env.js';

export interface UploadTicket {
  /** Named to match `photoUploadTicketSchema` in @inspectorone/shared - the route
   * spreads this straight onto its response, so the two must not drift. */
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * The seam that keeps Cloudflare R2 out of the local development loop.
 *
 * `local` writes to disk and signs its own URLs; `s3` talks to R2, MinIO, or
 * AWS. Both honour the same contract, so nothing above this interface knows or
 * cares which is running.
 */
export interface StorageAdapter {
  readonly name: 'local' | 's3';

  /** Grant the client a short-lived, single-object write. */
  createUploadUrl(args: {
    key: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds?: number;
  }): Promise<UploadTicket>;

  /** Grant a short-lived read, for showing a photo in a portal. */
  createDownloadUrl(args: { key: string; ttlSeconds?: number }): Promise<string>;

  /** Server-side write, used by the report worker for generated PDFs. */
  putObject(args: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;

  /** Confirms the bytes actually landed, before a photo leaves `pending`. */
  statObject(key: string): Promise<{ size: number } | null>;

  deleteObject(key: string): Promise<void>;
}

let adapter: StorageAdapter | null = null;

export async function getStorage(): Promise<StorageAdapter> {
  if (adapter) return adapter;

  if (env.STORAGE_DRIVER === 's3') {
    const { createS3Storage } = await import('./s3.js');
    adapter = createS3Storage();
  } else {
    const { createLocalStorage } = await import('./local.js');
    adapter = createLocalStorage();
  }

  return adapter;
}

/** Storage keys are namespaced by org so a bucket policy can be scoped later. */
export function photoKey(args: {
  orgId: string;
  jobId: string;
  photoId: string;
  contentType: string;
}): string {
  const ext =
    args.contentType === 'image/png'
      ? 'png'
      : args.contentType === 'image/webp'
        ? 'webp'
        : 'jpg';
  return `orgs/${args.orgId}/jobs/${args.jobId}/photos/${args.photoId}.${ext}`;
}

export function reportKey(args: {
  orgId: string;
  jobId: string;
  reportId: string;
  version: number;
}): string {
  return `orgs/${args.orgId}/jobs/${args.jobId}/reports/${args.reportId}-v${args.version}.pdf`;
}
