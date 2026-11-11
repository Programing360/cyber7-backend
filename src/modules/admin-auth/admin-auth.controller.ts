import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  adminAuthService,
  verifyMfaChallengeToken,
} from "./admin-auth.service.js";
import { adminEmailOtpService } from "./admin-email-otp.service.js";
import { adminSessionService } from "./admin-session.service.js";
import type { AdminAuthenticatedRequest } from "../../middlewares/authenticate-admin-session.js";
import { clearAdminCookieOptions } from "./admin-cookie.util.js";
import { loadAdminSessionEnv } from "../../config/env.js";

// ==========================================
// STRICT REQUEST VALIDATION SCHEMAS
// ==========================================
const bootstrapSchema = z.object({
  email: z.string().trim().email("Invalid email address format"),
  bootstrapSecret: z
    .string()
    .min(16, "Bootstrap secret must be at least 16 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address format"),
  password: z.string().min(1, "Password is required"),
});

const verifyEmailOtpSchema = z.object({
  challengeToken: z.string().trim().min(10, "Invalid challenge token"),
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
});

const resendOtpSchema = z.object({
  challengeToken: z.string().trim().min(10, "Invalid challenge token"),
});

/**
 * Request Context Helpers
 */
function getRequestMetadata(req: Request) {
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp =
    typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.ip || req.socket.remoteAddress || undefined;

  const rawUserAgent = req.headers["user-agent"];
  const userAgent = typeof rawUserAgent === "string" ? rawUserAgent : undefined;

  return { clientIp, userAgent };
}

export class AdminAuthController {
  /**
   * POST /api/platform-admin/auth/bootstrap
   */
  public bootstrap = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const parsed = bootstrapSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          message: "Invalid bootstrap request format",
          errors: parsed.error.issues,
        });
        return;
      }

      const { clientIp, userAgent } = getRequestMetadata(req);

      const result = await adminAuthService.bootstrapPlatformAdmin({
        email: parsed.data.email,
        bootstrapSecret: parsed.data.bootstrapSecret,
        ipAddress: clientIp,
        userAgent,
      });

      if (!result.success) {
        const statusCode =
          result.code === "BOOTSTRAP_DISABLED" ||
          result.code === "BOOTSTRAP_ALREADY_COMPLETED"
            ? 403
            : result.code === "UNAUTHORIZED_BOOTSTRAP"
              ? 401
              : 400;

        res.status(statusCode).json(result);
        return;
      }

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/platform-admin/auth/login
   * ভ্যালিডেশন শেষে সরাসরি অ্যাডমিনের ইমেইলে ৬-ডিজিট কোড সেন্ড করবে
   */
  public login = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          message: "Invalid login credentials format",
          errors: parsed.error.issues,
        });
        return;
      }

      const { clientIp, userAgent } = getRequestMetadata(req);

      // ১. ক্রেডেনশিয়াল ও প্ল্যাটফর্ম রোল অথেনটিকেশন চেক
      const result = await adminAuthService.validateAdminCredentials({
        email: parsed.data.email,
        password: parsed.data.password,
        ipAddress: clientIp,
        userAgent,
      });

      if (!result.success || !result.adminUser) {
        const statusCode = [
          "UNAUTHORIZED_ADMIN_ROLE",
          "USER_INACTIVE",
          "EMAIL_NOT_VERIFIED",
        ].includes(result.code || "")
          ? 403
          : 401;

        res.status(statusCode).json(result);
        return;
      }

      // ২. ইমেইলে OTP তৈরি এবং প্রেরণ
      const otpSendResult = await adminEmailOtpService.generateAndSendOtp(
        result.adminUser._id.toString(),
      );

      if (!otpSendResult.success) {
        res.status(500).json({
          success: false,
          code: "EMAIL_DISPATCH_FAILED",
          message:
            otpSendResult.message ||
            "Failed to dispatch verification code to email",
        });
        return;
      }

      // ৩. ক্লায়েন্টকে ওটিপি স্ক্রিন প্রদর্শনের জন্য চ্যালেঞ্জ টোকেন প্রদান
      res.status(200).json({
        success: true,
        code: "EMAIL_OTP_REQUIRED",
        message: `A 6-digit login verification code has been dispatched to ${result.adminUser.email}`,
        data: {
          challengeToken: result.challengeToken,
          email: result.adminUser.email,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/platform-admin/auth/mfa/verify
   * অথবা POST /api/platform-admin/auth/verify-otp
   * ইমেইল কোড ভেরিফিকেশন এবং সেশন এস্টাবলিশমেন্ট
   */
  public verifyEmailOtp = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const parsed = verifyEmailOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          message: "Invalid OTP parameters",
          errors: parsed.error.issues,
        });
        return;
      }

      // চ্যালেঞ্জ টোকেন থেকে userId রিট্রাইভ
      const challenge = verifyMfaChallengeToken(parsed.data.challengeToken);
      if (!challenge.valid || !challenge.userId) {
        res.status(401).json({
          success: false,
          code: "INVALID_CHALLENGE_TOKEN",
          message: "Login session expired or invalid. Please login again.",
        });
        return;
      }

      // ওটিপি যাচাই
      const otpVerifyResult = await adminEmailOtpService.verifyOtp(
        challenge.userId,
        parsed.data.otp,
      );

      if (!otpVerifyResult.success) {
        res.status(400).json({
          success: false,
          code: otpVerifyResult.code || "OTP_VERIFICATION_FAILED",
          message: otpVerifyResult.message || "Invalid verification code",
        });
        return;
      }

      const { clientIp, userAgent } = getRequestMetadata(req);

      // সফল ভেরিফিকেশনের পর অথেনটিকেটেড সেশন কুকি তৈরি
      const authResult = await adminAuthService.completeChallengeSession({
        userId: challenge.userId,
        ipAddress: clientIp,
        userAgent,
      });

      if (
        !authResult.success ||
        !authResult.cookieOptions ||
        !authResult.rawToken
      ) {
        res.status(500).json({
          success: false,
          code: authResult.code || "SESSION_ESTABLISHMENT_FAILED",
          message: authResult.message || "Failed to establish admin session",
        });
        return;
      }

      const { name, options } = authResult.cookieOptions;
      res.cookie(name, authResult.rawToken, options);

      res.status(200).json({
        success: true,
        message: "Platform administrator verified successfully",
        data: authResult.data,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/platform-admin/auth/resend-otp
   * কোড পুনরায় পাঠানোর রুট
   */
  public resendEmailOtp = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const parsed = resendOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          message: "Challenge token required",
        });
        return;
      }

      const challenge = verifyMfaChallengeToken(parsed.data.challengeToken);
      if (!challenge.valid || !challenge.userId) {
        res.status(401).json({
          success: false,
          code: "INVALID_CHALLENGE_TOKEN",
          message: "Login session has expired. Please sign in again.",
        });
        return;
      }

      const otpSendResult = await adminEmailOtpService.generateAndSendOtp(
        challenge.userId,
      );

      if (!otpSendResult.success) {
        res.status(500).json({
          success: false,
          code: "EMAIL_DISPATCH_FAILED",
          message: otpSendResult.message || "Failed to dispatch email",
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "New verification code has been dispatched to your email",
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/platform-admin/auth/logout
   */
  public logout = async (
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const sessionId = req.admin?.session?.id;
      const sessionEnv = loadAdminSessionEnv();
      const { clientIp, userAgent } = getRequestMetadata(req);

      if (sessionId) {
        await adminAuthService.logout({
          sessionId,
          ipAddress: clientIp,
          userAgent,
        });
      }

      res.clearCookie(
        sessionEnv.ADMIN_SESSION_COOKIE_NAME,
        clearAdminCookieOptions(),
      );

      res.status(200).json({
        success: true,
        message: "Logged out successfully",
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/platform-admin/auth/me
   */
  /**
   * GET /api/platform-admin/auth/me
   */
  /**
   * GET /api/platform-admin/auth/me
   */
  public getMe = async (
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {

      if (!req.admin?.user || !req.admin?.session) {
        res.status(401).json({
          success: false,
          code: "UNAUTHORIZED",
          message: "No active platform administrator session",
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: String(req.admin.user.id),
            email: req.admin.user.email,
            name: req.admin.user.name,
            platformRole: req.admin.user.platformRole,
          },
          session: {
            id: String(req.admin.session.id),
            status: req.admin.session.status || "ACTIVE",
            idleExpiresAt: req.admin.session.idleExpiresAt,
            absoluteExpiresAt: req.admin.session.absoluteExpiresAt,
            lastActivityAt:
              req.admin.session.lastActivityAt || new Date().toISOString(),
          },
          mfa: {
            configured: true,
            enrolledAt: new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
            remainingRecoveryCodes: 0,
          },
        },
      });
    } catch (err) {
      console.error("[AdminAuthController.getMe Error]:", err);
      next(err);
    }
  };

  /**
   * POST /api/platform-admin/auth/sessions/purge
   */
  public purgeSessions = async (
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const actor = {
        adminUserId: req.admin?.user?.id,
        adminEmail: req.admin?.user?.email,
        sessionId: req.admin?.session?.id,
        ipAddress:
          req.ip || (req.headers["x-forwarded-for"] as string) || "127.0.0.1",
        userAgent: req.headers["user-agent"] || "unknown",
      };

      const purgedCount = await adminSessionService.purgeSessions(actor);

      res.status(200).json({
        success: true,
        message: "Expired and revoked sessions purged successfully.",
        purgedCount,
      });
    } catch (err) {
      console.error("[AdminAuthController.purgeSessions Error]:", err);
      next(err);
    }
  };
}

export const adminAuthController = new AdminAuthController();
