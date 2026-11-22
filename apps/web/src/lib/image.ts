import { isReportAspect, reportPhotoCrop } from '@inspectorone/shared';
import exifr from 'exifr';

/**
 * Photo pipeline: read provenance, crop to the report frame, then shrink.
 *
 * A phone photo is ~4MB. Across five inspectors that is roughly 24GB a month;
 * resized to 1600px at JPEG quality 0.8 it is nearer 2GB. That single decision
 * is the difference between a free storage tier and a bill.
 *
 * Crucially, EXIF is read BEFORE the canvas work, because drawing to a canvas
 * discards every tag. For inspection evidence, "photographed at this spot at
 * this time" is often the whole point, so it is captured into the database as
 * real columns rather than left inside a file we are about to rewrite.
 *
 * Every photo leaves here cropped to 4:3 (or 3:4 when the phone was upright) -
 * the frame the company's reports use. See `reportPhotoCrop` in shared.
 */

export const MAX_DIMENSION = 1600;
export const JPEG_QUALITY = 0.8;

export interface CaptureProvenance {
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  /** Where the location came from, so the UI can be honest about it. */
  gpsSource: 'exif' | 'device' | null;
}

/** A photo straight off the camera: not yet cropped, compressed or uploaded. */
export interface CapturedPhoto {
  file: File;
  /** Size of the original, upright. */
  width: number;
  height: number;
  /** Shows the original; the crop is previewed with CSS until it is rendered. */
  previewUrl: string;
  /** Already 4:3, so there is nothing for the inspector to reframe. */
  fitsFrame: boolean;
  /**
   * EXIF and, failing that, the device's own location. Started immediately but
   * not awaited, so the review screen appears at once instead of after a GPS
   * fix; the save waits for it. Never rejects.
   */
  provenance: Promise<CaptureProvenance>;
  /** The moment the photo reached the app - the fallback capture time. */
  capturedAt: string;
  /** Stable across every retry of this one shot - see upload.ts. */
  clientRef: string;
}

/** The cropped, compressed JPEG that is actually uploaded. */
export interface ReportPhoto extends CaptureProvenance {
  blob: Blob;
  width: number;
  height: number;
  originalBytes: number;
  bytes: number;
}

const NO_PROVENANCE: CaptureProvenance = {
  takenAt: null,
  gpsLat: null,
  gpsLng: null,
  gpsSource: null,
};

async function readExif(file: File): Promise<CaptureProvenance> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
      gps: true,
    });
    if (!tags) return { ...NO_PROVENANCE };

    const when: unknown = tags.DateTimeOriginal ?? tags.CreateDate;
    const lat = typeof tags.latitude === 'number' ? tags.latitude : null;
    const lng = typeof tags.longitude === 'number' ? tags.longitude : null;

    return {
      takenAt: when instanceof Date && !Number.isNaN(when.valueOf())
        ? when.toISOString()
        : null,
      gpsLat: lat,
      gpsLng: lng,
      gpsSource: lat !== null && lng !== null ? 'exif' : null,
    };
  } catch {
    // A photo with unreadable metadata is still a usable photo.
    return { ...NO_PROVENANCE };
  }
}

/**
 * Many phones omit GPS from EXIF unless the camera app has location permission,
 * so the browser's own geolocation is a genuinely useful fallback rather than a
 * belt-and-braces flourish.
 */
function deviceLocation(timeoutMs = 8000): Promise<GeolocationPosition | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

async function readProvenance(file: File): Promise<CaptureProvenance> {
  try {
    const exif = await readExif(file);
    if (exif.gpsLat !== null && exif.gpsLng !== null) return exif;
    const pos = await deviceLocation();
    if (!pos) return exif;
    return {
      ...exif,
      gpsLat: pos.coords.latitude,
      gpsLng: pos.coords.longitude,
      gpsSource: 'device',
    };
  } catch {
    return { ...NO_PROVENANCE };
  }
}

/**
 * Upload idempotency key. `crypto.randomUUID` exists only on secure origins,
 * and testing on a phone over the local network (http://192.168...) is not
 * one - so fall back to `getRandomValues`, which works everywhere.
 */
export function newClientRef(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    // 'from-image' applies the EXIF orientation flag, so photos taken sideways
    // do not end up rotated in the report.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(
      "This photo couldn't be opened. Try taking it with the camera instead of choosing a saved file.",
    );
  }
}

/** Accept a photo from the camera or library and get it ready for review. */
export async function capturePhoto(file: File): Promise<CapturedPhoto> {
  const bitmap = await decode(file);
  const { width, height } = bitmap;
  bitmap.close();

  return {
    file,
    width,
    height,
    previewUrl: URL.createObjectURL(file),
    fitsFrame: isReportAspect(width, height),
    provenance: readProvenance(file),
    capturedAt: new Date().toISOString(),
    clientRef: newClientRef(),
  };
}

/** A preview blob URL is a real allocation; release it when the photo goes. */
export function releasePhoto(photo: CapturedPhoto | null | undefined) {
  if (photo) URL.revokeObjectURL(photo.previewUrl);
}

/**
 * Which way the report frame can slide over this photo, if at all - the same
 * arithmetic the final crop uses, so the preview never lies about the result.
 */
export function frameSlack(photo: Pick<CapturedPhoto, 'width' | 'height'>): 'x' | 'y' | null {
  const crop = reportPhotoCrop(photo.width, photo.height);
  if (crop.sw < photo.width) return 'x';
  if (crop.sh < photo.height) return 'y';
  return null;
}

/**
 * Crop to the report frame at the chosen position, shrink, and compress.
 * Re-decodes the original rather than holding a full-size bitmap in memory
 * while the inspector reviews the shot.
 */
export async function renderReportPhoto(
  photo: CapturedPhoto,
  offset = 0.5,
): Promise<ReportPhoto> {
  const bitmap = await decode(photo.file);
  const crop = reportPhotoCrop(bitmap.width, bitmap.height, {
    maxLongSide: MAX_DIMENSION,
    offset,
  });

  const canvas = document.createElement('canvas');
  canvas.width = crop.outWidth;
  canvas.height = crop.outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Could not prepare the image for upload');
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    bitmap,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    crop.outWidth,
    crop.outHeight,
  );
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not compress the image'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });

  const provenance = await photo.provenance;
  return {
    ...provenance,
    // If the camera gave us no timestamp, the moment the photo reached the app
    // is the best available approximation - and far better than blank.
    takenAt: provenance.takenAt ?? photo.capturedAt,
    blob,
    width: crop.outWidth,
    height: crop.outHeight,
    originalBytes: photo.file.size,
    bytes: blob.size,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
