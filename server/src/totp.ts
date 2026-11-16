import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) for the manager account.
 *
 * The manager can see every engineer's trail, delete accounts and read every collection. A
 * password alone protects all of that, and a password is the one thing that leaks from a shared
 * laptop, a screenshot or an old database. A six-digit code from any authenticator app costs the
 * owner ten seconds a day.
 *
 * No dependency: the whole algorithm is an HMAC over a counter, and adding a package for it would
 * be a supply-chain risk in exchange for forty lines.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Tolerant of what people paste: spaces, dashes, lowercase, and the `=` padding some apps add. */
export function base32Decode(secret: string): Buffer {
  const clean = String(secret).toUpperCase().replace(/[\s\-=]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('المفتاح السري مش base32 صحيح.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The six digits an authenticator app shows for this moment. */
export function totpCode(secret: string, at: number = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(at / 1000 / stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Accepts the current code and its two neighbours: phones drift, and a person who types the code
 * as it changes should not be told he is wrong. The window is deliberately one step, not ten.
 */
export function verifyTotp(secret: string, code: string, at: number = Date.now(), stepSeconds = 30): boolean {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  for (const offset of [-1, 0, 1]) {
    const expected = totpCode(secret, at + offset * stepSeconds * 1000, stepSeconds);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return true;
  }
  return false;
}

/** A fresh 160-bit secret, the size the RFC recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUrl(secret: string, account: string, issuer = 'الهلب جروب'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
