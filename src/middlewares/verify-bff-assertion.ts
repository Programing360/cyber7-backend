import type { NextFunction, Request, Response } from "express";
import { loadAdminBffEnv } from "../config/env.js";
import {
  verifyBffAssertion,
  type BffAssertionPayload,
} from "../modules/admin-auth/admin-bff-assertion.util.js";
import { adminSecurityAuditService } from "../modules/admin-auth/admin-security-audit.service.js";

export interface BffAssertionRequest extends Request {
  bffAssertion?: BffAssertionPayload;
}

/**
 * সেফ অডিট লগ হেল্পার: অডিট লগ ফেইল করলেও রিকোয়েস্ট ফ্লো যেন আটকে না থাকে
 */
function safeAuditLog(
  event: Parameters<typeof adminSecurityAuditService.recordSecurityEvent>[0],
) {
  adminSecurityAuditService.recordSecurityEvent(event).catch((err) => {
    console.error("[BffAudit] Failed to record assertion security event:", err);
  });
}

/**
 * Express Middleware: Signed Next.js BFF Service Assertion Verification.
 *
 * Supports both `x-bff-assertion` and `x-admin-bff-assertion` headers for maximum
 * proxy reliability and forward compatibility.
 */
export async function requireBffAssertion(
  req: BffAssertionRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // If already verified on an outer router for this exact request, pass through cleanly
  if (req.bffAssertion) {
    next();
    return;
  }

  // উভয় স্ট্যান্ডার্ড হেডার চেক করা



  const rawToken =
    req.headers["x-bff-assertion"] || req.headers["x-admin-bff-assertion"];

  const token =
    typeof rawToken === "string"
      ? rawToken.trim()
      : Array.isArray(rawToken)
        ? rawToken[0]?.trim()
        : "";


  if (!token) {
    safeAuditLog({
      eventType: "AUTHENTICATION_REJECTED",
      ipAddress: req.ip,
      userAgent: req.headers?.["user-agent"],
      reason: "BFF_ASSERTION_REQUIRED: Missing x-bff-assertion header",
    });

    res.status(401).json({
      success: false,
      code: "BFF_ASSERTION_REQUIRED",
      message:
        "Signed Next.js BFF service assertion is required on platform administrator endpoints",
    });
    return;
  }

  const bffEnv = loadAdminBffEnv();

  // পাথ নরমালাইজেশন: কুয়েরি স্ট্রিং ও ডুপ্লিকেট স্ল্যাশ ক্লিন করা
  const rawPath = req.originalUrl ? req.originalUrl.split("?")[0] : req.path;
  const targetPath = rawPath.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";

  const result = await verifyBffAssertion({
    token,
    expectedMethod: req.method,
    expectedPath: targetPath,
    secret: bffEnv.ADMIN_BFF_SECRET,
    allowedIssuer: bffEnv.ADMIN_BFF_ISSUER,
    allowedAudience: bffEnv.ADMIN_BFF_AUDIENCE,
  });

  if (!result.valid) {
    safeAuditLog({
      eventType: "AUTHENTICATION_REJECTED",
      ipAddress: req.ip,
      userAgent: req.headers?.["user-agent"],
      reason: `${result.code}: ${result.message}`,
    });

    const statusCode =
      result.code === "REPLAY_PROTECTION_UNAVAILABLE" ? 503 : 401;

    res.status(statusCode).json({
      success: false,
      code: result.code || "INVALID_BFF_ASSERTION",
      message: result.message || "Invalid BFF service assertion",
    });
    return;
  }

  req.bffAssertion = result.payload;
  next();
}
