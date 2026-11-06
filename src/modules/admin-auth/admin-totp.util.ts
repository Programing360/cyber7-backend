/**
 * VexChat Platform Admin TOTP Multi-Factor Authentication Utilities
 *
 * Implements:
 * 1. RFC 4648 Base32 encoding & decoding with strict validation.
 * 2. Cryptographically secure TOTP raw secret generation (160 bits / 20 bytes entropy).
 * 3. Authenticated AES-256-GCM encryption & decryption at rest with versioned envelope (v1).
 * 4. RFC 6238 TOTP computation (HMAC-SHA1, 30s step, 6 digits).
 * 5. Allowed clock drift validation and durable replay protection boundaries.
 * 6. Authenticator provisioning URI formatting (otpauth://totp/...).
 * 7. High-entropy single-use recovery code generation and cryptographic hashing.
 */

import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  BASE32_LOOKUP[BASE32_ALPHABET[i]] = i;
}

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpError";
  }
}

export class TotpDecryptionError extends TotpError {
  constructor(message: string) {
    super(message);
    this.name = "TotpDecryptionError";
  }
}

/* ==========================================================================
   1. RFC 4648 BASE32 ENCODING & DECODING
   ========================================================================== */

/**
 * Encodes a buffer to an unpadded RFC 4648 Base32 string.
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes an RFC 4648 Base32 string back to a Buffer.
 * Strips whitespace and hyphens. Throws TotpError on invalid characters.
 */
export function base32Decode(encoded: string): Buffer {
  if (typeof encoded !== "string" || encoded.trim().length === 0) {
    throw new TotpError("Base32 input must not be empty");
  }

  const cleaned = encoded.replace(/[\s\-=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const val = BASE32_LOOKUP[char];
    if (val === undefined) {
      throw new TotpError(`Invalid Base32 character encountered: '${char}'`);
    }

    value = (value << 5) | val;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/* ==========================================================================
   2. TOTP RAW SECRET GENERATION
   ========================================================================== */

/**
 * Generates a high-entropy cryptographically secure raw secret for TOTP.
 * Default length: 20 bytes (160 bits of entropy), standard for HMAC-SHA1.
 */
export function generateTotpRawSecret(byteLength: number = 20): string {
  if (byteLength < 16 || byteLength > 64) {
    throw new TotpError("TOTP secret byteLength must be between 16 and 64 bytes");
  }
  const randomBuf = crypto.randomBytes(byteLength);
  return base32Encode(randomBuf);
}

/* ==========================================================================
   3. AES-256-GCM ENCRYPTION & DECRYPTION AT REST
   ========================================================================== */

/**
 * Validates that an encryption key is a valid 64-character hex string (32 bytes / 256 bits).
 */
export function validateEncryptionKey(keyHex: string): Buffer {
  if (typeof keyHex !== "string" || keyHex.trim().length !== 64) {
    throw new TotpError(
      "ADMIN_MFA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes / 256 bits)",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex.trim())) {
    throw new TotpError(
      "ADMIN_MFA_ENCRYPTION_KEY contains non-hexadecimal characters",
    );
  }
  return Buffer.from(keyHex.trim(), "hex");
}

/**
 * Encrypts a TOTP secret using AES-256-GCM.
 * Output envelope format: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 *
 * - IV: 12 bytes cryptographically secure random bytes per operation.
 * - Auth Tag: 16 bytes GMAC authentication tag.
 */
export function encryptTotpSecret(secret: string, keyHex: string): string {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new TotpError("Cannot encrypt empty TOTP secret");
  }

  const key = validateEncryptionKey(keyHex);
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret.trim(), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypts a versioned AES-256-GCM encrypted TOTP secret.
 * Enforces tag verification. Throws TotpDecryptionError on tampering or wrong key.
 */
export function decryptTotpSecret(encryptedEnvelope: string, keyHex: string): string {
  if (!encryptedEnvelope || typeof encryptedEnvelope !== "string") {
    throw new TotpDecryptionError("Missing or invalid encrypted envelope");
  }

  const parts = encryptedEnvelope.split(":");
  if (parts.length !== 4) {
    throw new TotpDecryptionError(
      "Malformed encrypted envelope: expected v1:<iv>:<tag>:<ciphertext>",
    );
  }

  const [version, ivHex, tagHex, ciphertextHex] = parts;
  if (version !== "v1") {
    throw new TotpDecryptionError(
      `Unsupported ciphertext version '${version}'. Expected 'v1'.`,
    );
  }

  if (ivHex.length !== 24) {
    throw new TotpDecryptionError("Invalid IV length: expected 12 bytes (24 hex characters)");
  }
  if (tagHex.length !== 32) {
    throw new TotpDecryptionError("Invalid Auth Tag length: expected 16 bytes (32 hex characters)");
  }

  const key = validateEncryptionKey(keyHex);
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (err) {
    throw new TotpDecryptionError(
      "MFA secret decryption failed: authentication tag verification error or ciphertext tampered",
    );
  }
}

/* ==========================================================================
   4. RFC 6238 TOTP COMPUTATION & VERIFICATION
   ========================================================================== */

/**
 * Calculates the standard RFC 6238 / RFC 4226 OTP code for a specific time-step.
 */
export function calculateTotpCode(
  secretBase32: string,
  timeStep: number,
  digits: number = 6,
): string {
  if (timeStep < 0) {
    throw new TotpError("Time-step counter cannot be negative");
  }

  const keyBuffer = base32Decode(secretBase32);

  // 8-byte big-endian time-step buffer
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(timeStep), 0);

  const hmac = crypto.createHmac("sha1", keyBuffer).update(timeBuffer).digest();

  // Dynamic truncation (RFC 4226 Section 5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

export interface VerifyTotpParams {
  secretBase32: string;
  token: string;
  currentTimestampMs?: number;
  stepSeconds?: number;
  driftWindows?: number;
  lastUsedTimeStep?: number;
}

export interface VerifyTotpResult {
  valid: boolean;
  timeStep?: number;
  code?:
    | "INVALID_FORMAT"
    | "REPLAYED_CODE"
    | "CODE_MISMATCH"
    | "DECRYPTION_FAILED"
    | "SUCCESS";
  message?: string;
}

/**
 * Verifies a candidate TOTP code against the secret, clock drift, and replay state.
 *
 * Replay Protection:
 * Any verified timeStep MUST be strictly greater than lastUsedTimeStep.
 * If a matching code is found at a step <= lastUsedTimeStep, it is rejected as a REPLAYED_CODE.
 */
export function verifyTotpToken({
  secretBase32,
  token,
  currentTimestampMs = Date.now(),
  stepSeconds = 30,
  driftWindows = 1,
  lastUsedTimeStep = 0,
}: VerifyTotpParams): VerifyTotpResult {
  if (typeof token !== "string" || !/^\d{6}$/.test(token.trim())) {
    return {
      valid: false,
      code: "INVALID_FORMAT",
      message: "TOTP code must consist of exactly 6 numeric digits",
    };
  }

  const sanitizedToken = token.trim();
  const currentStep = Math.floor(currentTimestampMs / 1000 / stepSeconds);

  // Windows to check: [0, -1, +1, -2, +2, ...]
  const stepOffsets: number[] = [0];
  for (let w = 1; w <= driftWindows; w++) {
    stepOffsets.push(-w);
    stepOffsets.push(w);
  }

  for (const offset of stepOffsets) {
    const candidateStep = currentStep + offset;
    if (candidateStep < 0) continue;

    const expectedCode = calculateTotpCode(secretBase32, candidateStep, 6);

    // Constant-time comparison
    if (
      crypto.timingSafeEqual(
        Buffer.from(sanitizedToken),
        Buffer.from(expectedCode),
      )
    ) {
      // Replay check: Step must be strictly newer than the last consumed step
      if (candidateStep <= lastUsedTimeStep) {
        return {
          valid: false,
          timeStep: candidateStep,
          code: "REPLAYED_CODE",
          message:
            "This TOTP code has already been consumed or time window expired",
        };
      }

      return {
        valid: true,
        timeStep: candidateStep,
        code: "SUCCESS",
      };
    }
  }

  return {
    valid: false,
    code: "CODE_MISMATCH",
    message: "Invalid verification code",
  };
}

/* ==========================================================================
   5. PROVISIONING URI GENERATION
   ========================================================================== */

export interface ProvisioningUriParams {
  secretBase32: string;
  accountEmail: string;
  issuer?: string;
  digits?: number;
  period?: number;
}

/**
 * Builds standard RFC 6238 otpauth:// provisioning URI for authenticator applications.
 */
export function buildProvisioningUri({
  secretBase32,
  accountEmail,
  issuer = "VexChat Platform",
  digits = 6,
  period = 30,
}: ProvisioningUriParams): string {
  const cleanEmail = accountEmail.trim();
  const cleanIssuer = issuer.trim();
  const label = `${encodeURIComponent(cleanIssuer)}:${encodeURIComponent(cleanEmail)}`;

  const params = new URLSearchParams({
    secret: secretBase32.trim(),
    issuer: cleanIssuer,
    algorithm: "SHA1",
    digits: digits.toString(),
    period: period.toString(),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ==========================================================================
   6. RECOVERY CODE ARCHITECTURE
   ========================================================================== */

/**
 * Hashes a recovery code using SHA-256. Normalizes by stripping hyphens and lowercase.
 */
export function hashRecoveryCode(code: string): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new TotpError("Recovery code cannot be empty");
  }
  const normalized = code.replace(/[\s\-]/g, "").toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Generates high-entropy alphanumeric recovery codes and their corresponding SHA-256 hashes.
 * Format: 10 characters split with hyphen (e.g. "a1b2c-3d4e5") for readability.
 */
export function generateRecoveryCodes(
  count: number = 10,
): {
  rawCodes: string[];
  hashedCodes: Array<{ codeHash: string }>;
} {
  const rawCodes: string[] = [];
  const hashedCodes: Array<{ codeHash: string }> = [];

  for (let i = 0; i < count; i++) {
    // 8 random bytes = 16 hex chars
    const hex = crypto.randomBytes(5).toString("hex").toLowerCase();
    const formatted = `${hex.slice(0, 5)}-${hex.slice(5, 10)}`;
    rawCodes.push(formatted);
    hashedCodes.push({ codeHash: hashRecoveryCode(formatted) });
  }

  return { rawCodes, hashedCodes };
}

