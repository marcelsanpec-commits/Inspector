import { api } from './api.js';
import type { ReportPhoto } from './image.js';

interface UploadTicket {
  photoId: string;
  uploadUrl?: string;
  method?: 'PUT';
  headers?: Record<string, string>;
  alreadyUploaded?: boolean;
}

export interface UploadInput {
  jobId: string;
  objectId?: string | null;
  photo: ReportPhoto;
  caption?: string;
  voiceNote?: string;
  voiceNoteIsDictated?: boolean;
  includeInReport: boolean;
  /** A finding - the API refuses one that is not also in the report. */
  nonConforming?: boolean;
  /** The structure's ID plate; replaces any previous plate photo. */
  serialPlate?: boolean;
  /**
   * Stable across retries. Generated once when the photo is taken, so a
   * dropped signal mid-upload cannot produce two copies of the same shot.
   */
  clientRef: string;
}

/**
 * The three-step handshake.
 *
 * 1. Ask the API for a ticket, sending metadata only.
 * 2. PUT the bytes straight at the returned URL - the API never sees them.
 * 3. Confirm, so the server can verify the object landed before marking it
 *    ready.
 *
 * Locally that URL points back at the API's own /storage routes; in production
 * it points at Cloudflare R2. This function does not change either way.
 */
export async function uploadPhoto(input: UploadInput): Promise<string> {
  const ticket = await api<UploadTicket>('/api/photos/upload-url', {
    method: 'POST',
    body: {
      jobId: input.jobId,
      objectId: input.objectId ?? null,
      contentType: 'image/jpeg',
      byteSize: input.photo.bytes,
      width: input.photo.width,
      height: input.photo.height,
      takenAt: input.photo.takenAt,
      gpsLat: input.photo.gpsLat,
      gpsLng: input.photo.gpsLng,
      caption: input.caption || undefined,
      voiceNote: input.voiceNote || undefined,
      voiceNoteIsDictated: input.voiceNoteIsDictated ?? false,
      includeInReport: input.includeInReport,
      nonConforming: input.nonConforming ?? false,
      serialPlate: input.serialPlate ?? false,
      clientRef: input.clientRef,
    },
  });

  // A retry of something that already completed - nothing left to do.
  if (ticket.alreadyUploaded || !ticket.uploadUrl) return ticket.photoId;

  let put: Response;
  try {
    put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.headers ?? { 'content-type': 'image/jpeg' },
      body: input.photo.blob,
    });
  } catch {
    // fetch only throws when the request never completed: no signal, or
    // storage refusing the browser outright (a CORS problem with R2).
    throw new Error(
      "Couldn't reach photo storage. Check your signal and tap Save again - the photo stays here until it uploads.",
    );
  }

  if (!put.ok) {
    throw new Error(
      `Upload failed (${put.status}). The photo stays here - tap Save to try again.`,
    );
  }

  await api('/api/photos/confirm', {
    method: 'POST',
    body: { photoId: ticket.photoId },
  });

  return ticket.photoId;
}
