import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` collapses scrypt's overloads to the three-argument form and drops
 * the options parameter, so the signature is restated here. Without the
 * options we could not set N/r/p, which is the entire point of using scrypt.
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt from Node's standard library - a real key-derivation function, no
 * dependency, and memory-hard in a way plain SHA-256 is not.
 *
 * Parameters are stored alongside the hash so they can be raised later without
 * invalidating existing passwords: verify with whatever the stored record says,
 * and re-hash on next successful login if it is below current strength.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(plain.normalize('NFKC'), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }

  let actual: Buffer;
  try {
    actual = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Burns roughly the same time as a real verification. Called when an email
 * matches no account, so response timing does not reveal which addresses are
 * registered.
 */
export async function fakeVerify(): Promise<void> {
  await scryptAsync('dummy', randomBytes(16), KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
}
