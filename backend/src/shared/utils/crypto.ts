/**
 * crypto.ts — AES-256-GCM encryption for secrets at rest (Zalo session cookies)
 * and SHA-256 hashing for API keys.
 * Key material is derived from ENCRYPTION_KEY with scrypt so any string works.
 */
import crypto from 'node:crypto';
import { config } from '../../config/index.js';

const ALGO = 'aes-256-gcm';
const KEY_SALT = 'zalo-crm:session:v1';
const KEY = crypto.scryptSync(config.encryptionKey, KEY_SALT, 32);

export interface EncryptedBlob {
  enc: 'v1';
  iv: string; // base64
  tag: string; // base64
  data: string; // base64 ciphertext
}

export function isEncryptedBlob(v: unknown): v is EncryptedBlob {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as any).enc === 'v1' &&
    typeof (v as any).iv === 'string' &&
    typeof (v as any).tag === 'string' &&
    typeof (v as any).data === 'string'
  );
}

export function encryptJson(value: unknown): EncryptedBlob {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    enc: 'v1',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptJson<T = unknown>(blob: EncryptedBlob): T {
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** SHA-256 hex digest — used to store API keys so a DB leak does not leak keys. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
