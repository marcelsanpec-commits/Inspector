/**
 * The shape of every inspection photo.
 *
 * Taken from the reports the company already sends: in both the LADWP
 * witnessing report and the Boardman to Hemingway field report, nearly every
 * photo sits on the page at the phone camera's native 4:3 - landscape when the
 * phone was held sideways, portrait (3:4) when it was held upright. Cropping every
 * capture to that same frame is what lets a report page tile photos two or
 * three across without odd gaps, and it means a 16:9 Android shot looks the
 * same in the report as an iPhone one.
 *
 * Orientation is preserved rather than forced: a pole section photographed
 * upright stays upright. Change these two numbers if the house style changes.
 */
export const PHOTO_ASPECT_LONG = 4;
export const PHOTO_ASPECT_SHORT = 3;

/** Long side over short side. */
export const PHOTO_ASPECT = PHOTO_ASPECT_LONG / PHOTO_ASPECT_SHORT;

/**
 * Whether a width/height pair is the report frame, in either orientation.
 * The 1% tolerance absorbs a client rounding to an odd pixel; it does not
 * admit 16:9 (1.78) or square (1.0) images.
 */
export function isReportAspect(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return Math.abs(ratio - PHOTO_ASPECT) < 0.01;
}

export interface ReportCrop {
  /** Source rectangle to cut out of the oriented original. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output size: exactly 4:3 or 3:4, long side capped at `maxLongSide`. */
  outWidth: number;
  outHeight: number;
}

/**
 * Where to cut the report frame out of a source image, and how large to make
 * the result.
 *
 * `offset` (0 to 1) slides the frame along whichever axis has spare pixels -
 * 0.5 is centred, 0 is top or left. That is all the "framing" control an
 * inspector needs: a 4:3 phone photo has nothing to trim, and a 16:9 one only
 * has a strip to lose at one end or the other.
 *
 * The output long side is rounded down to a multiple of 4 so the short side is
 * a whole number and the result is exactly 4:3, not 4:3-ish.
 */
export function reportPhotoCrop(
  srcWidth: number,
  srcHeight: number,
  { maxLongSide = 1600, offset = 0.5 }: { maxLongSide?: number; offset?: number } = {},
): ReportCrop {
  const landscape = srcWidth >= srcHeight;
  const target = landscape ? PHOTO_ASPECT : 1 / PHOTO_ASPECT;

  let sw = srcWidth;
  let sh = srcHeight;
  if (srcWidth / srcHeight > target) {
    sw = Math.min(srcWidth, Math.round(srcHeight * target));
  } else {
    sh = Math.min(srcHeight, Math.round(srcWidth / target));
  }

  const o = Math.min(1, Math.max(0, Number.isFinite(offset) ? offset : 0.5));
  const sx = Math.round((srcWidth - sw) * o);
  const sy = Math.round((srcHeight - sh) * o);

  const cropLong = Math.max(sw, sh);
  const capped = Math.min(maxLongSide, cropLong);
  const outLong = Math.max(PHOTO_ASPECT_LONG, capped - (capped % PHOTO_ASPECT_LONG));
  const outShort = (outLong / PHOTO_ASPECT_LONG) * PHOTO_ASPECT_SHORT;

  return {
    sx,
    sy,
    sw,
    sh,
    outWidth: landscape ? outLong : outShort,
    outHeight: landscape ? outShort : outLong,
  };
}
