/**
 * Symmetric encryption for refresh tokens.
 *
 * Algorithm:           AES-256-GCM
 * Key:                 32 random bytes, supplied via TOKEN_ENCRYPTION_KEY
 *                      env var as a base64 string. Generate with:
 *
 *                        openssl rand -base64 32
 *
 * Storage format:      `${iv_b64}.${ciphertext_b64}.${tag_b64}`
 *                      Three base64 segments separated by '.'.
 *                      The whole string fits in a single text column.
 *
 * Threat model:
 *   - Refresh tokens are encrypted at rest. A Supabase dump alone is not
 *     enough to compromise them; the attacker also needs the env var.
 *   - Access tokens are NEVER stored — minted from the refresh token
 *     at request time and held only in memory for the duration of the
 *     Graph call.
 *   - Key rotation is out of scope for the pilot. When it lands, store
 *     a key version prefix on each ciphertext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM canonical nonce length
const TAG_BYTES = 16;

export class TokenCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoConfigError";
  }
}

export class TokenCryptoDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoDecryptError";
  }
}

function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new TokenCryptoConfigError(
      "TOKEN_ENCRYPTION_KEY is not set. Generate with `openssl rand -base64 32`.",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new TokenCryptoConfigError(
      "TOKEN_ENCRYPTION_KEY is not valid base64",
    );
  }
  if (buf.length !== KEY_BYTES) {
    throw new TokenCryptoConfigError(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${buf.length}`,
    );
  }
  return buf;
}

/**
 * Encrypt a plaintext token. Returns `${iv}.${ciphertext}.${tag}`,
 * each segment base64-encoded.
 */
export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TokenCryptoConfigError("encryptToken: plaintext must be a non-empty string");
  }
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${ct.toString("base64")}.${tag.toString("base64")}`;
}

/**
 * Decrypt a token produced by encryptToken. Throws TokenCryptoDecryptError
 * on malformed input or auth-tag mismatch (i.e. tampered ciphertext or
 * wrong key).
 */
export function decryptToken(envelope: string): string {
  if (typeof envelope !== "string" || envelope.length === 0) {
    throw new TokenCryptoDecryptError("decryptToken: envelope must be a non-empty string");
  }
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    throw new TokenCryptoDecryptError(
      `decryptToken: envelope must have 3 dot-separated parts, got ${parts.length}`,
    );
  }
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new TokenCryptoDecryptError(
      `decryptToken: iv must be ${IV_BYTES} bytes, got ${iv.length}`,
    );
  }
  if (tag.length !== TAG_BYTES) {
    throw new TokenCryptoDecryptError(
      `decryptToken: auth tag must be ${TAG_BYTES} bytes, got ${tag.length}`,
    );
  }

  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    // GCM auth tag mismatch surfaces as "Unsupported state or unable to
    // authenticate data". We never propagate the underlying message
    // because it can leak whether the key or the ciphertext is wrong.
    throw new TokenCryptoDecryptError(
      "decryptToken: ciphertext failed authentication",
    );
  }
}
