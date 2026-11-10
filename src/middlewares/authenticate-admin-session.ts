import type { NextFunction, Request, Response } from "express";
import { loadAdminSessionEnv } from "../config/env.js";
import { adminSessionService } from "../modules/admin-auth/admin-session.service.js";
import {
  parseCookieHeader,
  buildAdminCookieOptions,
} from "../modules/admin-auth/admin-cookie.util.js";
import { adminSecurityAuditService } from "../modules/admin-auth/admin-security-audit.service.js";
import { verifyAccessToken } from "../utils/jwt.js";
import User from "../modules/auth/user.model.js";

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
  // If already authenticated on an outer router for this exact request, pass through cleanly
  if (req.admin) {
    next();
    return;
  }

  try {
    const config = loadAdminSessionEnv();
    const cookieName = config.ADMIN_SESSION_COOKIE_NAME;
    const cookieMap =
      (req as Request & { cookies?: Record<string, string> }).cookies ||
      parseCookieHeader(req.headers?.cookie);

    const cookieToken = cookieMap?.[cookieName]?.trim();

    // 1. Primary: Dedicated HttpOnly Admin Session Cookie
    if (cookieToken) {
      const authResult =
        await adminSessionService.authenticateAdminSession(cookieToken);

      if (authResult.success && authResult.user && authResult.session) {
        const updatedSession = await adminSessionService.touchAdminSession(
          authResult.session._id,
        );

        if (updatedSession) {
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
          return;
        }
      }
    }

    // 2. Unverified custom header check (keep lockdown against raw forged headers without BFF assertion)
    const headerName = config.ADMIN_SESSION_HEADER_NAME.toLowerCase();
    const headerValue = req.headers?.[headerName];
    if (
      typeof headerValue === "string" &&
      headerValue.trim().length > 0 &&
      !req.headers?.["x-admin-bff-assertion"]
    ) {
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
          "Internal header authentication is locked down until signed BFF service assertions are implemented. Dedicated HttpOnly cookie transport is required.",
      });
      return;
    }

    // 3. Fallback: Authenticated User Access Token (Bearer header or access token cookie)
    let bearerToken: string | undefined;
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      bearerToken = authHeader.slice("Bearer ".length).trim();
    }
    if (!bearerToken) {
      bearerToken =
        cookieMap?.["vexchat_access_token"] ||
        cookieMap?.["accessToken"] ||
        cookieMap?.["token"];
    }

    if (bearerToken) {
      try {
        const payload = verifyAccessToken(bearerToken);
        if (payload?.sub) {
          const user = await User.findById(payload.sub).select(
            "_id name email role platformRole isActive tokenInvalidBefore isEmailVerified",
          );

          if (!user || !user.isActive) {
            res.status(401).json({
              success: false,
              code: "USER_INACTIVE",
              message: "Administrator account is inactive or not found",
            });
            return;
          }

          if (
            user.tokenInvalidBefore &&
            payload.iat &&
            payload.iat * 1000 < new Date(user.tokenInvalidBefore).getTime()
          ) {
            res.status(401).json({
              success: false,
              code: "SESSION_EXPIRED",
              message: "Session has been invalidated. Please sign in again.",
            });
            return;
          }

          const allowedRoles = ["SUPER_ADMIN", "FINANCE_ADMIN"];
          if (!allowedRoles.includes(user.platformRole)) {
            safeAuditLog({
              eventType: "AUTHENTICATION_REJECTED",
              ipAddress: req.ip,
              userAgent: req.headers?.["user-agent"],
              reason: `CUSTOMER_TOKEN_FORBIDDEN: User role ${user.platformRole} does not have platform administrator privileges`,
            });

            res.status(403).json({
              success: false,
              code: "PLATFORM_ROLE_UNAUTHORIZED",
              message:
                "Insufficient platform administrator privileges for this action",
            });
            return;
          }

          // User is a verified Super Admin / Finance Admin with a valid token!
          // Bridge into an active AdminSession
          const sessionResult = await adminSessionService.createAdminSession({
            userId: user._id,
            ip: req.ip,
            userAgent: req.headers?.["user-agent"] as string | undefined,
          });

          // Set cookie on response for subsequent requests
          const isProd =
            (config.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() ===
            "production";
          const cookieOptions = buildAdminCookieOptions(
            sessionResult.session.absoluteExpiresAt,
            sessionResult.session.idleExpiresAt,
            isProd,
          );
          res.cookie(
            config.ADMIN_SESSION_COOKIE_NAME,
            sessionResult.rawToken,
            cookieOptions,
          );

          res.cookie("user_role", user.platformRole, {
            path: "/",
            httpOnly: false,
            sameSite: "lax",
            secure: isProd,
          });

          req.admin = {
            user: {
              id: String(user._id),
              email: user.email,
              name: user.name,
              platformRole: user.platformRole as AdminRole,
            },
            session: {
              id: String(sessionResult.session._id),
              status: sessionResult.session.status,
              idleExpiresAt: sessionResult.session.idleExpiresAt,
              absoluteExpiresAt: sessionResult.session.absoluteExpiresAt,
              lastActivityAt: sessionResult.session.lastActivityAt,
            },
          };

          next();
          return;
        }
      } catch (jwtErr) {
        res.status(401).json({
          success: false,
          code: "SESSION_EXPIRED",
          message: "Authentication token has expired. Please sign in again.",
        });
        return;
      }
    }

    // 4. No valid credentials provided
    res.status(401).json({
      success: false,
      code: "ADMIN_AUTHENTICATION_REQUIRED",
      message: "Platform administrator authentication required",
    });
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
