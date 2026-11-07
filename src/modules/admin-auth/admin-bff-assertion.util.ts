import crypto from "node:crypto";
import {
  consumeBffAssertionJti,
  BffNonceStorageError,
} from "./admin-bff-nonce.model.js";

export interface BffAssertionPayload {
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  method: string;
  path: string;
  adminSessionId?: string;
}

export interface VerifyBffAssertionParams {
  token: string;
  expectedMethod: string;
  expectedPath: string;
  secret: string;
  allowedIssuer?: string;
  allowedAudience?: string;
  clockSkewSeconds?: number;
}

export interface VerifyBffAssertionResult {
  valid: boolean;
  payload?: BffAssertionPayload;
  code?:
  | "MISSING_ASSERTION"
  | "MALFORMED_ASSERTION"
  | "INVALID_SIGNATURE"
  | "EXPIRED_ASSERTION"
  | "WRONG_ISSUER"
  | "WRONG_AUDIENCE"
  | "METHOD_MISMATCH"
  | "PATH_MISMATCH"
  | "REPLAY_ASSERTION_DETECTED"
  | "REPLAY_PROTECTION_UNAVAILABLE"
  | "SUCCESS";
  message?: string;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64");
}

/**
 * Normalizes request paths for robust assertion path binding comparison.
 * Strips query strings, hashes, repeated slashes, and trailing slashes.
 */
export function normalizeCanonicalPath(path: string): string {
  if (!path || typeof path !== "string") {
    return "/";
  }
  const clean = path.split("?")[0].split("#")[0].trim().replace(/\/+/g, "/");
  if (clean === "/" || clean === "") {
    return "/";
  }
  return clean.replace(/\/+$/, "");
}

/**
 * Generates a signed Next.js BFF service assertion token.
 */
export function createBffAssertion({
  method,
  path,
  secret,
  issuer = "vexchat-bff",
  audience = "vexchat-backend",
  ttlSeconds = 60,
  adminSessionId,
  jti = crypto.randomUUID(),
  customIat,
}: {
  method: string;
  path: string;
  secret: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
  adminSessionId?: string;
  jti?: string;
  customIat?: number;
}): string {
  const iat = customIat !== undefined ? customIat : Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;

  const payload: BffAssertionPayload = {
    jti,
    iss: issuer.trim(),
    aud: audience.trim(),
    iat,
    exp,
    method: method.trim().toUpperCase(),
    path: normalizeCanonicalPath(path),
    adminSessionId,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = base64UrlEncode(Buffer.from(payloadJson, "utf8"));

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("hex");

  return `${payloadEncoded}.${signature}`;
}

/**
 * Strictly verifies a signed Next.js BFF service assertion.
 */
export async function verifyBffAssertion({
  token,
  expectedMethod,
  expectedPath,
  secret,
  allowedIssuer = "vexchat-bff",
  allowedAudience = "vexchat-backend",
  clockSkewSeconds = 10,
}: VerifyBffAssertionParams): Promise<VerifyBffAssertionResult> {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return {
      valid: false,
      code: "MISSING_ASSERTION",
      message: "Signed BFF assertion token is required",
    };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 2) {
    return {
      valid: false,
      code: "MALFORMED_ASSERTION",
      message: "Malformed BFF assertion format. Expected payload.signature",
    };
  }

  const [payloadEncoded, providedSigHex] = parts;

  // 1. Constant-time signature verification
  const expectedSigHex = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("hex");

  const expectedSigBuf = Buffer.from(expectedSigHex, "utf8");
  const providedSigBuf = Buffer.from(providedSigHex, "utf8");

  if (
    expectedSigBuf.length !== providedSigBuf.length ||
    !crypto.timingSafeEqual(expectedSigBuf, providedSigBuf)
  ) {
    return {
      valid: false,
      code: "INVALID_SIGNATURE",
      message: "BFF assertion cryptographic signature verification failed",
    };
  }

  // 2. Parse payload safely
  let payload: BffAssertionPayload;
  try {
    const jsonStr = base64UrlDecode(payloadEncoded).toString("utf8");
    payload = JSON.parse(jsonStr);
  } catch {
    return {
      valid: false,
      code: "MALFORMED_ASSERTION",
      message: "Failed to parse BFF assertion JSON payload",
    };
  }

  // 3. Issuer & Audience check
  if (payload.iss !== allowedIssuer) {
    return {
      valid: false,
      code: "WRONG_ISSUER",
      message: `Invalid assertion issuer '${payload.iss}'. Expected '${allowedIssuer}'.`,
    };
  }

  if (payload.aud !== allowedAudience) {
    return {
      valid: false,
      code: "WRONG_AUDIENCE",
      message: `Invalid assertion audience '${payload.aud}'. Expected '${allowedAudience}'.`,
    };
  }

  // 4. Expiration check with clock skew tolerance
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds > payload.exp + clockSkewSeconds) {
    return {
      valid: false,
      code: "EXPIRED_ASSERTION",
      message: "BFF assertion has expired",
    };
  }

  if (payload.iat > nowSeconds + clockSkewSeconds) {
    return {
      valid: false,
      code: "EXPIRED_ASSERTION",
      message: "BFF assertion issued in the future",
    };
  }

  // 5. Method binding
  if (payload.method.toUpperCase() !== expectedMethod.trim().toUpperCase()) {
    return {
      valid: false,
      code: "METHOD_MISMATCH",
      message: `BFF assertion method mismatch: assertion bound to '${payload.method}', request is '${expectedMethod}'.`,
    };
  }

  // 6. Path binding
  const normalizedExpected = normalizeCanonicalPath(expectedPath);
  const normalizedPayload = normalizeCanonicalPath(payload.path);
  if (normalizedPayload !== normalizedExpected) {
    return {
      valid: false,
      code: "PATH_MISMATCH",
      message: `BFF assertion path mismatch: assertion bound to '${normalizedPayload}', request is '${normalizedExpected}'.`,
    };
  }

  // 7. Durable single-use replay protection
  try {
    const consumed = await consumeBffAssertionJti(
      payload.jti,
      new Date(payload.exp * 1000),
    );

    if (!consumed) {
      return {
        valid: false,
        code: "REPLAY_ASSERTION_DETECTED",
        message:
          "This BFF assertion identifier has already been consumed (replay rejected)",
      };
    }
  } catch (err: unknown) {
    if (err instanceof BffNonceStorageError) {
      return {
        valid: false,
        code: "REPLAY_PROTECTION_UNAVAILABLE",
        message:
          "Durable assertion replay protection is temporarily unavailable. Please retry.",
      };
    }
    throw err;
  }

  return {
    valid: true,
    code: "SUCCESS",
    payload,
  };
}