import type { NextFunction, Request, Response } from "express";
import { loadAdminSessionEnv } from "../config/env.js";
import { adminSessionService } from "../modules/admin-auth/admin-session.service.js";
import { parseCookieHeader } from "../modules/admin-auth/admin-cookie.util.js";
import { adminSecurityAuditService } from "../modules/admin-auth/admin-security-audit.service.js";

export type AdminRole = "SUPER_ADMIN" | "FINANCE_ADMIN";

export interface AdminUserContext {
  id: string;
  email: string;
  name: string;
  platformRole: AdminRole;
}

export interface AdminSessionContext {
  id: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastActivityAt: Date;
}

export interface AdminContext {
  user: AdminUserContext;
  session: AdminSessionContext;
}

export interface AdminAuthenticatedRequest extends Request {
  admin?: AdminContext;
}

/**
 * Lightweight helper to evaluate if a session creation timestamp is invalidated by tokenInvalidBefore.
 */
export function isSessionInvalidated(
  sessionCreatedAt: Date | string | number,
  tokenInvalidBefore?: Date | string | number | null,
): boolean {
  if (!tokenInvalidBefore) return false;
  const sessionTime = new Date(sessionCreatedAt).getTime();
  const invalidBeforeTime = new Date(tokenInvalidBefore).getTime();
  return sessionTime < invalidBeforeTime;
}

function extractAdminToken(req: Request): {
  token?: string;
  customerTokenDetected: boolean;
  unverifiedHeaderDetected: boolean;
} {
  const config = loadAdminSessionEnv();

  // 1. Explicit Customer JWT Isolation Gate
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return { customerTokenDetected: true, unverifiedHeaderDetected: false };
  }

  // 2. Primary Transport: HttpOnly Host-Only Cookie
  const cookieName = config.ADMIN_SESSION_COOKIE_NAME;
  const cookieMap =
    (req as Request & { cookies?: Record<string, string> }).cookies ||
    parseCookieHeader(req.headers?.cookie);

  const cookieToken = cookieMap?.[cookieName];
  if (typeof cookieToken === "string" && cookieToken.trim().length > 0) {
    return {
      token: cookieToken.trim(),
      customerTokenDetected: false,
      unverifiedHeaderDetected: false,
    };
  }

  // 3. BFF Ingress Lockdown: Unverified custom headers
  const headerName = config.ADMIN_SESSION_HEADER_NAME.toLowerCase();
  const headerValue = req.headers?.[headerName];
  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return { customerTokenDetected: false, unverifiedHeaderDetected: true };
  }

  return { customerTokenDetected: false, unverifiedHeaderDetected: false };
}

/**
 * সেফ অডিট লগ হেল্পার: অডিট লগ ফেইল করলেও যেন ক্লায়েন্ট রিকোয়েস্ট ক্র্যাশ না করে
 */
function safeAuditLog(
  event: Parameters<typeof adminSecurityAuditService.recordSecurityEvent>[0],
) {
  adminSecurityAuditService.recordSecurityEvent(event).catch((err) => {
    console.error("[AdminAudit] Failed to record security event:", err);
  });
}

export async function authenticateAdminSession(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token, customerTokenDetected, unverifiedHeaderDetected } =
      extractAdminToken(req);

    if (customerTokenDetected) {
      safeAuditLog({
        eventType: "AUTHENTICATION_REJECTED",
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
        reason: "CUSTOMER_TOKEN_FORBIDDEN: Bearer JWT rejected on admin route",
      });

      res.status(401).json({
        success: false,
        code: "CUSTOMER_TOKEN_FORBIDDEN",
        message:
          "Customer authentication tokens are strictly forbidden on platform admin endpoints",
      });
      return;
    }

    if (unverifiedHeaderDetected) {
      safeAuditLog({
        eventType: "AUTHENTICATION_REJECTED",
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
        reason:
          "BFF_ASSERTION_REQUIRED: Raw x-admin-session-token rejected without verified BFF assertion",
      });

      res.status(401).json({
        success: false,
        code: "BFF_ASSERTION_REQUIRED",
        message:
          "Internal header authentication is locked down until signed BFF service assertions are implemented (Phase 02B.5.4/5). Dedicated HttpOnly cookie transport is required.",
      });
      return;
    }

    if (!token) {
      res.status(401).json({
        success: false,
        code: "ADMIN_AUTHENTICATION_REQUIRED",
        message: "Platform administrator authentication required",
      });
      return;
    }

    // পরামর্শ: authenticateAndTouchSession মেথডে ভেরিফিকেশন ও লাস্ট-অ্যাক্টিভিটি আপডেট একসাথে করা উচিত
    const authResult =
      await adminSessionService.authenticateAdminSession(token);

    if (!authResult.success) {
      safeAuditLog({
        eventType: "AUTHENTICATION_REJECTED",
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
        reason: `${authResult.code}: ${authResult.message}`,
        sessionId: authResult.session?._id,
        adminUserId: authResult.session?.userId,
      });

      const statusCode = [
        "USER_INACTIVE",
        "ROLE_UNAUTHORIZED",
        "EMAIL_UNVERIFIED",
      ].includes(authResult.code)
        ? 403
        : 401;

      res.status(statusCode).json({
        success: false,
        code: authResult.code,
        message: authResult.message,
      });
      return;
    }

    // সেশন টাচ এবং কনকারেন্সি হ্যান্ডলিং
    const updatedSession = await adminSessionService.touchAdminSession(
      authResult.session._id,
    );

    if (!updatedSession) {
      safeAuditLog({
        eventType: "AUTHENTICATION_REJECTED",
        adminUserId: authResult.user._id,
        sessionId: authResult.session._id,
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
        reason: "CONCURRENT_SESSION_INVALIDATION: touch failed closed",
      });

      res.status(401).json({
        success: false,
        code: "SESSION_INACTIVE",
        message: "Administrator session is no longer active or has expired",
      });
      return;
    }

    req.admin = {
      user: {
        id: String(authResult.user._id),
        email: authResult.user.email,
        name: authResult.user.name,
        platformRole: authResult.user.platformRole as AdminRole,
      },
      session: {
        id: String(updatedSession._id),
        status: updatedSession.status,
        idleExpiresAt: updatedSession.idleExpiresAt,
        absoluteExpiresAt: updatedSession.absoluteExpiresAt,
        lastActivityAt: updatedSession.lastActivityAt,
      },
    };

    next();
  } catch (error) {
    console.error("[AdminAuthMiddleware] Unexpected internal error:", error);
    res.status(500).json({
      success: false,
      code: "ADMIN_AUTH_INTERNAL_ERROR",
      message: "An internal error occurred during administrator authentication",
    });
  }
}

export function requireAdminPlatformRole(...allowedRoles: AdminRole[]) {
  const targetRoles =
    allowedRoles.length > 0
      ? allowedRoles
      : (["SUPER_ADMIN", "FINANCE_ADMIN"] as AdminRole[]);

  return (
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.admin?.user) {
      res.status(401).json({
        success: false,
        code: "ADMIN_AUTHENTICATION_REQUIRED",
        message: "Platform administrator authentication required",
      });
      return;
    }

    if (!targetRoles.includes(req.admin.user.platformRole)) {
      res.status(403).json({
        success: false,
        code: "PLATFORM_ROLE_UNAUTHORIZED",
        message:
          "Insufficient platform administrator privileges for this action",
      });
      return;
    }

    next();
  };
}
