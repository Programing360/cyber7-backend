import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import InternalWebhookNonce from "../modules/whatsapp/internal-webhook-nonce.model.js";

export const ALLOWED_INTERNAL_ROUTES = new Set([
  "/api/whatsapp/webhook",
  "/api/whatsapp/internal/webhook-verified",
]);

const TIMESTAMP_REGEX = /^[1-9]\d{12}$/;
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIMESTAMP_DRIFT_MS = 300_000; // ±5 minutes (300,000 ms)

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Computes canonical internal HMAC signature.
 * Canonical payload: METHOD\nPATH\nTIMESTAMP\nNONCE\n followed by raw request body Buffer.
 */
export function computeCanonicalInternalHmac(
  method: string,
  pathname: string,
  timestampMs: string,
  nonce: string,
  rawBody: Buffer | undefined,
  secret: string,
): string {
  const canonicalPrefix = `${method.toUpperCase()}\n${pathname}\n${timestampMs}\n${nonce}\n`;
  const prefixBuf = Buffer.from(canonicalPrefix, "utf8");
  const bodyBuf = rawBody && rawBody.length > 0 ? rawBody : Buffer.alloc(0);
  const canonicalPayload = Buffer.concat([prefixBuf, bodyBuf]);

  const hash = createHmac("sha256", secret).update(canonicalPayload).digest("hex");
  return `sha256=${hash}`;
}

/**
 * Middleware enforcing Step 44D / 45A internal mutual HMAC authentication,
 * strict allowlisting, timestamp window verification, and atomic nonce replay prevention.
 */
export async function requireInternalIngressAuth(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. HTTP method must be POST.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      success: false,
      code: "DISALLOWED_METHOD",
      message: "Method not allowed. Internal endpoints accept POST only.",
    });
    return;
  }

  // 2. Exact internal route must be allowlisted.
  const rawPath = req.baseUrl
    ? `${req.baseUrl}${req.path}`
    : req.originalUrl.split("?")[0];
  const exactPath = (rawPath || "").replace(/\/+$/, "");

  if (!ALLOWED_INTERNAL_ROUTES.has(exactPath)) {
    res.status(404).json({
      success: false,
      code: "DISALLOWED_ROUTE",
      message: "Internal route not allowed or not found.",
    });
    return;
  }

  // 3. Timestamp header format: ^[1-9]\d{12}$
  const timestampHeader = req.headers["x-internal-timestamp"];
  if (
    !timestampHeader ||
    typeof timestampHeader !== "string" ||
    !TIMESTAMP_REGEX.test(timestampHeader)
  ) {
    res.status(401).json({
      success: false,
      code: "INVALID_TIMESTAMP",
      message: "Missing or invalid x-internal-timestamp header. Expected 13-digit decimal epoch ms.",
    });
    return;
  }

  // 4. Timestamp drift must not exceed ±300,000 milliseconds.
  const requestTime = Number(timestampHeader);
  const currentTime = Date.now();
  if (Math.abs(currentTime - requestTime) > MAX_TIMESTAMP_DRIFT_MS) {
    res.status(401).json({
      success: false,
      code: "EXPIRED_TIMESTAMP",
      message: "Timestamp drift exceeds maximum allowable window of ±300 seconds.",
    });
    return;
  }

  // 5. Nonce must be a valid RFC 4122 UUIDv4.
  const nonceHeader = req.headers["x-internal-nonce"];
  if (
    !nonceHeader ||
    typeof nonceHeader !== "string" ||
    !UUID_V4_REGEX.test(nonceHeader)
  ) {
    res.status(401).json({
      success: false,
      code: "INVALID_NONCE",
      message: "Missing or invalid x-internal-nonce header. Expected UUIDv4.",
    });
    return;
  }
  const nonce = nonceHeader.toLowerCase();

  // 6. Verify the internal HMAC using crypto.timingSafeEqual.
  const internalSecret =
    process.env.VEXCHAT_INTERNAL_WEBHOOK_SECRET?.trim() ||
    process.env.INTERNAL_WEBHOOK_SECRET?.trim();
  if (!internalSecret) {
    console.error("[requireInternalIngressAuth] INTERNAL_WEBHOOK_SECRET is not configured.");
    res.status(500).json({
      success: false,
      code: "CONFIGURATION_ERROR",
      message: "Server configuration error: missing internal webhook secret.",
    });
    return;
  }

  const signatureHeader = req.headers["x-internal-signature"];
  if (!signatureHeader || typeof signatureHeader !== "string") {
    res.status(401).json({
      success: false,
      code: "INVALID_INTERNAL_SIGNATURE",
      message: "Missing x-internal-signature header.",
    });
    return;
  }

  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const expectedSignature = computeCanonicalInternalHmac(
    req.method,
    exactPath,
    timestampHeader,
    nonce,
    rawBody,
    internalSecret,
  );

  const providedBuf = Buffer.from(signatureHeader, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");

  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    res.status(401).json({
      success: false,
      code: "INVALID_INTERNAL_SIGNATURE",
      message: "Invalid internal HMAC signature.",
    });
    return;
  }

  // 7. Atomically insert the nonce into MongoDB.
  try {
    await InternalWebhookNonce.collection.insertOne({
      _id: nonce as any,
      timestamp: new Date(requestTime),
      createdAt: new Date(),
    });
  } catch (err: any) {
    if (
      err &&
      (err.code === 11000 ||
        (typeof err.message === "string" && err.message.includes("E11000")))
    ) {
      res.status(409).json({
        success: false,
        code: "REPLAY_NONCE_DETECTED",
        message: "Duplicate request nonce detected. Replay rejected.",
      });
      return;
    }

    console.error("[requireInternalIngressAuth] Database failure inserting nonce:", err);
    res.status(500).json({
      success: false,
      code: "NONCE_STORAGE_FAILED",
      message: "Database failure recording security nonce.",
    });
    return;
  }

  next();
}
