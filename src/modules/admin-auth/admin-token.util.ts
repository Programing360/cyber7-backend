import crypto from "node:crypto";

/**
 * Generates a cryptographically secure, high-entropy raw session token.
 * Yields 32 bytes (256 bits) of entropy formatted as a 64-character lowercase hex string.
 *
 * The raw token is returned to the authenticating platform administrator once
 * and is NEVER stored in the database.
 */
export function generateAdminRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Computes a deterministic SHA-256 cryptographic digest of a raw token.
 * This 64-character hex hash is the ONLY representation persisted in MongoDB.
 */
export function hashAdminToken(rawToken: string): string {
  if (typeof rawToken !== "string" || rawToken.trim().length === 0) {
    throw new Error("Cannot hash an empty or non-string token");
  }

  return crypto.createHash("sha256").update(rawToken.trim()).digest("hex");
}

/**
 * Compares two token hashes in constant time to prevent side-channel timing attacks.
 */
export function timingSafeTokenCompare(hashA: string, hashB: string): boolean {
  if (
    typeof hashA !== "string" ||
    typeof hashB !== "string" ||
    hashA.length === 0 ||
    hashB.length === 0
  ) {
    return false;
  }

  const bufA = Buffer.from(hashA, "utf8");
  const bufB = Buffer.from(hashB, "utf8");

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sanitizes and bounds a User-Agent string for audit recording.
 * Strips non-printable ASCII / control characters and limits length to 255 characters.
 */
export function sanitizeUserAgent(userAgent?: unknown): string | null {
  if (typeof userAgent !== "string" || userAgent.trim().length === 0) {
    return null;
  }

  // Remove control characters (0x00-0x1F, 0x7F) and normalize whitespace
  const sanitized = userAgent.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  if (sanitized.length === 0) {
    return null;
  }

  return sanitized.slice(0, 255);
}

/**
 * Sanitizes and bounds an IP address string for audit recording.
 * Strips non-printable characters and limits length to 45 characters (max IPv6 length).
 */
export function sanitizeIp(ip?: unknown): string | null {
  if (typeof ip !== "string" || ip.trim().length === 0) {
    return null;
  }

  const sanitized = ip.replace(/[\x00-\x1F\x7F\s]/g, "").trim();
  if (sanitized.length === 0) {
    return null;
  }

  return sanitized.slice(0, 45);
}

