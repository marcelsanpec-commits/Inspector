import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { getStorage } from './index.js';

/**
 * `npm run storage:check` - proves photo storage works the way a phone will
 * use it, before a phone has to find out.
 *
 * It runs the real upload handshake against whatever STORAGE_DRIVER is
 * configured: sign an upload URL, send the browser's CORS preflight, PUT the
 * bytes, stat them, download them through a signed URL, and clean up. With R2
 * the preflight is the step that usually fails, and it is the one thing the
 * local driver can never surface - which is why this exists.
 *
 * Read-only apart from one tiny file under healthcheck/, which it deletes.
 */

// A genuine 1x1 JPEG: small enough to send anywhere, real enough to be served.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

let failures = 0;
const pass = (step: string) => console.log(`  ✓ ${step}`);
const fail = (step: string, detail: string) => {
  failures++;
  console.log(`  ✗ ${step}\n      ${detail}`);
};

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

async function main() {
  const storage = await getStorage();
  // The origin a phone uploads from: the deployed app when one is configured.
  const origin =
    env.corsOrigins.find((o) => o.startsWith('https://')) ??
    env.corsOrigins[0] ??
    env.PUBLIC_APP_URL;

  console.log(
    storage.name === 's3'
      ? `\nChecking bucket "${env.R2_BUCKET}" at ${env.s3Endpoint}`
      : `\nChecking local storage in ${env.LOCAL_STORAGE_DIR}\n(served by the API at ${env.PUBLIC_API_URL} - it must be running)`,
  );
  console.log(`Uploads will come from ${origin}\n`);

  const key = `healthcheck/${randomUUID()}.jpg`;
  const ticket = await storage.createUploadUrl({
    key,
    contentType: 'image/jpeg',
    maxBytes: TINY_JPEG.length,
  });
  pass('Signed an upload URL');

  // 1. What the browser asks before it is allowed to PUT cross-origin.
  try {
    const pre = await fetch(ticket.uploadUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const allowed = pre.headers.get('access-control-allow-origin');
    if (pre.ok && (allowed === origin || allowed === '*')) {
      pass(`Browsers at ${origin} may upload`);
    } else {
      fail(
        `Browsers at ${origin} may upload`,
        `The CORS preflight got HTTP ${pre.status}, allowing origin "${allowed ?? 'none'}". ` +
          `Add ${origin} to the bucket's CORS policy (README, "Photo storage (R2)").`,
      );
    }
  } catch (err) {
    fail('Reach the upload URL', describeError(err));
    if (storage.name === 'local') {
      console.log('\nThe local driver serves uploads from the API itself. Start it with `npm run dev`, then re-run this.');
    }
    process.exit(1);
  }

  // 2. The upload itself, exactly as the app sends it.
  const put = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: TINY_JPEG,
  });
  if (put.ok) {
    pass('Uploaded a test photo');
  } else {
    const text = (await put.text()).slice(0, 300);
    fail('Uploaded a test photo', `HTTP ${put.status}: ${text}`);
    process.exit(1);
  }

  // 3. What /api/photos/confirm relies on before a photo leaves `pending`.
  const stat = await storage.statObject(key);
  if (stat?.size === TINY_JPEG.length) {
    pass('Found it in storage, at the right size');
  } else {
    fail('Found it in storage', stat ? `Size ${stat.size}, expected ${TINY_JPEG.length}` : 'Not found');
  }

  // 4. What every gallery and inspection screen does to show it.
  const url = await storage.createDownloadUrl({ key });
  const get = await fetch(url);
  const bytes = Buffer.from(await get.arrayBuffer());
  if (get.ok && bytes.equals(TINY_JPEG)) {
    pass('Downloaded it through a signed URL');
  } else {
    fail('Downloaded it through a signed URL', `HTTP ${get.status}, ${bytes.length} bytes`);
  }

  await storage.deleteObject(key);
  if ((await storage.statObject(key)) === null) {
    pass('Deleted it again');
  } else {
    fail('Deleted it again', `${key} is still there - delete it by hand`);
  }

  console.log(
    failures
      ? `\n${failures} check(s) failed. Photos will not work until they pass.\n`
      : '\nStorage is ready for photos.\n',
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nStorage check could not run:', describeError(err));
  process.exit(1);
});
