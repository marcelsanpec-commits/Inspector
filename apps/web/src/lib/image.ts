import exifr from 'exifr';

/**
 * Photo pipeline: read provenance, then shrink.
 *
 * A phone photo is ~4MB. Across five inspectors that is roughly 24GB a month;
 * resized to 1600px at JPEG quality 0.8 it is nearer 2GB. That single decision
 * is the difference between a free storage tier and a bill.
 *
 * Crucially, EXIF is read BEFORE the canvas resize, because drawing to a canvas
 * discards every tag. For inspection evidence, "photographed at this spot at
 * this time" is often the whole point, so it is captured into the database as
 * real columns rather than left inside a file we are about to rewrite.
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

export interface ProcessedPhoto extends CaptureProvenance {
  blob: Blob;
  width: number;
  height: number;
  originalBytes: number;
  bytes: number;
  previewUrl: string;
}

async function readExif(file: File): Promise<CaptureProvenance> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
      gps: true,
    });
    if (!tags) return { takenAt: null, gpsLat: null, gpsLng: null, gpsSource: null };

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
    return { takenAt: null, gpsLat: null, gpsLng: null, gpsSource: null };
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

export async function processPhoto(
  file: File,
  { useDeviceLocationFallback = true } = {},
): Promise<ProcessedPhoto> {
  const provenance = await readExif(file);

  if (
    useDeviceLocationFallback &&
    provenance.gpsLat === null &&
    provenance.gpsLng === null
  ) {
    const pos = await deviceLocation();
    if (pos) {
      provenance.gpsLat = pos.coords.latitude;
      provenance.gpsLng = pos.coords.longitude;
      provenance.gpsSource = 'device';
    }
  }

  // 'from-image' applies the EXIF orientation flag, so photos taken sideways
  // do not end up rotated in the report.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the image for upload');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not compress the image'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });

  return {
    ...provenance,
    // If the camera gave us no timestamp, the moment of capture is the best
    // available approximation - and far better than leaving it blank.
    takenAt: provenance.takenAt ?? new Date().toISOString(),
    blob,
    width,
    height,
    originalBytes: file.size,
    bytes: blob.size,
    previewUrl: URL.createObjectURL(blob),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
