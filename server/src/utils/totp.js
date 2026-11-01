/**
 * RFC 6238 TOTP (SHA-1, 30-second step, 6 digits) — compatible with
 * Google Authenticator, Authy, 1Password, etc.
 *
 * Secrets are stored encrypted (AES-256-GCM) with a key derived from
 * TOTP_ENCRYPTION_KEY (or JWT_SECRET as a development fallback).
 */
import { createHmac, randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(randomBytes(20));
}

export function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export function totp(secret, time = Date.now()) {
  return hotp(secret, Math.floor(time / 30000));
}

/** Accepts the current step and one step either side to tolerate clock drift. */
export function verifyTotp(secret, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(time / 30000);
  for (const delta of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(secret, step + delta));
    if (timingSafeEqual(expected, Buffer.from(String(code)))) return true;
  }
  return false;
}

export function otpauthUri(secret, account, issuer = 'UMKM Saham') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function key() {
  const material = process.env.TOTP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  return createHash('sha256').update(String(material)).digest();
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored) {
  const [v, iv, tag, data] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
