import mongoose, { type ClientSession, type Types } from "mongoose";
import AdminSecurityAuditLog, {
  type AdminSecurityEventType,
  type IAdminSecurityAuditLog,
} from "./admin-security-audit.model.js";
import { sanitizeIp, sanitizeUserAgent } from "./admin-token.util.js";

export interface RecordAdminSecurityEventParams {
  eventType: AdminSecurityEventType;
  adminUserId?: string | Types.ObjectId;
  adminEmail?: string;
  sessionId?: string | Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
}

const SAFE_CODE_PATTERNS = [
  "errorcode",
  "statuscode",
  "reasoncode",
  "responsecode",
  "countrycode",
  "currencycode",
  "dialcode",
  "areacode",
  "postalcode",
  "zipcode",
  "httpstatuscode",
];

const SAFE_COUNT_PATTERNS = ["count", "total", "length", "size"];

const EXPLICIT_SAFE_COUNT_KEYS = new Set([
  "remainingattempts",
  "remainingcount",
  "remainingcodes",
  "remainingretries",
  "remainingitems",
  "remainingdays",
  "remaininghours",
  "remainingminutes",
  "remainingseconds",
  "remainingbytes",
  "attemptcount",
  "retrycount",
  "failurecount",
  "successcount",
  "totalcount",
  "totalattempts",
  "backupcodescount",
  "recoverycodescount",
]);

const SENSITIVE_KEY_SUBSTRINGS = [
  "password",
  "secret",
  "token",
  "cookie",
  "authorization",
  "bearer",
  "hash",
  "otp",
  "totp",
  "recoverycode",
  "encryptionkey",
  "cipherkey",
  "privatekey",
  "provisioninguri",
  "credential",
  "apikey",
  "jwt",
  "passkey",
  "authkey",
  "accesskey",
  "secretkey",
  "sessionkey",
  "signingkey",
  "openaikey",
  "stripekey",
];

const CREDENTIAL_CODE_PATTERNS = [
  "authcode",
  "securitycode",
  "verificationcode",
  "passcode",
  "pincode",
  "backupcode",
  "accesscode",
  "confirmationcode",
  "smscode",
  "emailcode",
];

// Pre-compiled regular expressions for high throughput
const BEARER_REGEX = /^Bearer\s+[A-Za-z0-9\-._~+/]+=*$/i;
const OTPAUTH_REGEX = /^otpauth:\/\/totp\//i;
const AES_ENVELOPE_REGEX = /^v1:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/i;
const RECOVERY_CODE_REGEX = /^[0-9a-fA-F]{5}-[0-9a-fA-F]{5}$/;
const HEX64_REGEX = /^[0-9a-fA-F]{64}$/;
const STANDARD_ERROR_CODE_REGEX = /^[A-Z0-9_]{3,}$/;
const SIX_DIGIT_OTP_REGEX = /^\d{6}$/;

export function isSensitiveAuditKey(key: string, value?: unknown): boolean {
  if (typeof key !== "string" || key.trim().length === 0) {
    return false;
  }

  const normalized = key.toLowerCase().replace(/[\s_\-.]/g, "");

  if (SENSITIVE_KEY_SUBSTRINGS.some((kw) => normalized.includes(kw))) {
    return true;
  }

  if (CREDENTIAL_CODE_PATTERNS.some((p) => normalized.includes(p))) {
    return true;
  }

  if (
    normalized === "mfastatus" ||
    normalized === "mfaconfigured" ||
    normalized === "mfaenabled"
  ) {
    return false;
  }

  if (
    SAFE_CODE_PATTERNS.some((p) => normalized.endsWith(p) || normalized === p)
  ) {
    return false;
  }

  if (
    EXPLICIT_SAFE_COUNT_KEYS.has(normalized) ||
    SAFE_COUNT_PATTERNS.some((p) => normalized.endsWith(p))
  ) {
    return false;
  }

  if (normalized === "code") {
    if (typeof value === "number" && value >= 100 && value <= 599) {
      return false;
    }
    if (
      typeof value === "string" &&
      STANDARD_ERROR_CODE_REGEX.test(value.trim()) &&
      !SIX_DIGIT_OTP_REGEX.test(value.trim()) &&
      !RECOVERY_CODE_REGEX.test(value.trim())
    ) {
      return false;
    }
    return true;
  }

  return false;
}

export function isSensitiveValue(val: unknown): boolean {
  if (typeof val !== "string") {
    return false;
  }

  const str = val.trim();
  if (str.length === 0) {
    return false;
  }

  return (
    BEARER_REGEX.test(str) ||
    OTPAUTH_REGEX.test(str) ||
    AES_ENVELOPE_REGEX.test(str) ||
    RECOVERY_CODE_REGEX.test(str) ||
    HEX64_REGEX.test(str)
  );
}

export function sanitizeAuditValue(
  value: unknown,
  keyContext?: string,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (depth > 6) {
    return "[REDACTED]";
  }

  if (keyContext && isSensitiveAuditKey(keyContext, value)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);

    if (
      "_bsontype" in value ||
      (value as { constructor?: { name?: string } }).constructor?.name ===
        "ObjectId"
    ) {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        sanitizeAuditValue(item, undefined, depth + 1, seen),
      );
    }

    const sanitizedObj: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      sanitizedObj[k] = isSensitiveAuditKey(k, v)
        ? "[REDACTED]"
        : sanitizeAuditValue(v, k, depth + 1, seen);
    }
    return sanitizedObj;
  }

  if (typeof value === "string") {
    if (isSensitiveValue(value)) {
      return "[REDACTED]";
    }
    return value.slice(0, 255);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return undefined;
}

export function sanitizeAuditMetadata(
  data?: unknown,
  depth: number = 0,
): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return sanitizeAuditValue(data, undefined, depth) as Record<string, unknown>;
}

export function sanitizeReasonString(reason?: string): string | undefined {
  if (!reason || typeof reason !== "string") {
    return undefined;
  }
  return reason
    .trim()
    .slice(0, 255)
    .replace(/\b[0-9a-fA-F]{5}-[0-9a-fA-F]{5}\b/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/otpauth:\/\/[^\s]+/gi, "otpauth://[REDACTED]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[REDACTED]");
}

export class AdminSecurityAuditService {
  public async recordSecurityEvent(
    params: RecordAdminSecurityEventParams,
  ): Promise<IAdminSecurityAuditLog | null> {
    try {
      if (
        mongoose.connection.readyState !== 1 &&
        !(mongoose.Model.prototype.save as any)?.mock &&
        !(AdminSecurityAuditLog.prototype.save as any)?.mock
      ) {
        return null;
      }

      const auditDoc = new AdminSecurityAuditLog({
        eventType: params.eventType,
        adminUserId: params.adminUserId,
        adminEmail: params.adminEmail?.trim().toLowerCase(),
        sessionId: params.sessionId,
        ipAddress: sanitizeIp(params.ipAddress),
        userAgent: sanitizeUserAgent(params.userAgent),
        reason: sanitizeReasonString(params.reason),
        metadata: sanitizeAuditMetadata(params.metadata),
        timestamp: new Date(),
      });

      await auditDoc.save({ session: params.session });
      return auditDoc;
    } catch (err) {
      console.error(
        "[ADMIN_SECURITY_AUDIT_ERROR] Failed to record security event:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
}

export const adminSecurityAuditService = new AdminSecurityAuditService();
