import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Alphabet with every visually confusable character removed: no 0/O, 1/I/L,
 * or U/V. An inspecting company types these off a phone screen held by someone
 * standing in a parking lot, so transcription errors are the failure mode worth
 * designing against.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTWXYZ';

/** e.g. IO-7K3M9Q. Must stay in sync with `accountIdSchema` in shared. */
export function generateAccountId(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `IO-${out}`;
}

/** URL-safe org handle. A random suffix keeps it unique without a retry loop. */
export function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = randomBytes(3).toString('hex');
  return `${base || 'org'}-${suffix}`;
}

/**
 * Session and invite tokens. The raw value is returned to the caller exactly
 * once; only its SHA-256 is stored, so a database leak yields nothing
 * replayable. These are 256 bits of entropy from a CSPRNG, so a plain hash is
 * correct here - unlike passwords, there is nothing to brute-force.
 */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
