import { Router, type Request, type Response } from "express";
import { adminAuthController } from "./admin-auth.controller.js";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";
import { createAdminRateLimiter } from "../../middlewares/admin-rate-limit.js";
import { redirectIfAdminAuthenticated } from "../../middlewares/redirect-if-admin-authenticated.js";
import { adminSessionService } from "./admin-session.service.js";
import { parseCookieHeader } from "./admin-cookie.util.js";
import { loadAdminSessionEnv } from "../../config/env.js";

const router = Router();
// সেশন চেক করার জন্য লাইটওয়েট রাউট (কুকি থাকলে রোল রিটার্ন করবে, না থাকলে authenticated: false)
router.get("/session-check", async (req: Request, res: Response) => {
  try {
    console.log("[Admin Session Check] Incoming request:", {
      headers: req.headers,
      cookies: (req as Request & { cookies?: Record<string, string> }).cookies,
    });
    const config = loadAdminSessionEnv();

    console.log("[Admin Session Check] Loaded config:", config);

    const cookieName = config.ADMIN_SESSION_COOKIE_NAME;

    const cookieMap =
      (
        req as Request & {
          cookies?: Record<string, string>;
        }
      ).cookies || parseCookieHeader(req.headers?.cookie);
    console.log("[Admin Session Check] Parsed cookies:", cookieMap);

    const token = cookieMap?.[cookieName];

    if (!token) {
      res.status(200).json({
        success: true,
        authenticated: false,
        reason: "ADMIN_SESSION_COOKIE_MISSING",
      });
      return;
    }

    const result = await adminSessionService.authenticateAdminSession(token);

    console.log(result);

    if (!result.success) {
      res.status(200).json({
        success: true,
        authenticated: false,
        reason: result.code || "INVALID_SESSION",
      });
      return;
    }

    if (!result.user) {
      res.status(200).json({
        success: true,
        authenticated: false,
        reason: "INVALID_SESSION",
      });
      return;
    }

    const allowedRoles = ["SUPER_ADMIN", "FINANCE_ADMIN"];

    if (!allowedRoles.includes(result.user.platformRole)) {
      res.status(200).json({
        success: true,
        authenticated: false,
        reason: "ROLE_UNAUTHORIZED",
      });
      return;
    }

    res.status(200).json({
      success: true,
      authenticated: true,
      platformRole: result.user.platformRole,
      user: {
        id: String(result.user._id),
        email: result.user.email,
        name: result.user.name,
      },
    });
  } catch (error) {
    console.error("[Admin Session Check]", error);

    res.status(500).json({
      success: false,
      authenticated: false,
      message: "Failed to verify administrator session",
    });
  }
});

const authLimiter = createAdminRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});

const resendOtpLimiter = createAdminRateLimiter({
  maxAttempts: 3,
  windowMs: 5 * 60 * 1000,
});

// ১. SUPER_ADMIN বুটস্ট্র্যাপ
router.post(
  "/bootstrap",
  requireBffAssertion,
  authLimiter,
  adminAuthController.bootstrap,
);

// ২. অ্যাডমিন প্রাইমারি লগইন (সেশন চেক মিডলওয়্যার যুক্ত করা হয়েছে)
router.post(
  "/login",
  requireBffAssertion,
  redirectIfAdminAuthenticated, // <--- অলরেডি SUPER_ADMIN বা সেশন থাকলে রিডাইরেক্ট পাঠাবে
  authLimiter,
  adminAuthController.login,
);

// ৩. Email OTP ভেরিফিকেশন
router.post(
  "/mfa/verify",
  requireBffAssertion,
  authLimiter,
  adminAuthController.verifyEmailOtp,
);

// ৪. Resend OTP
router.post(
  "/resend-otp",
  requireBffAssertion,
  resendOtpLimiter,
  adminAuthController.resendEmailOtp,
);

// ৫. কারেন্ট অ্যাডমিন প্রোফাইল
router.get(
  "/me",
  requireBffAssertion,
  authenticateAdminSession,
  adminAuthController.getMe,
);

// ৬. অ্যাডমিন লগআউট
router.post(
  "/logout",
  requireBffAssertion,
  authenticateAdminSession,
  adminAuthController.logout,
);

// ৭. অ্যাডমিন সেশন পার্জ (SUPER_ADMIN only)
router.post(
  "/sessions/purge",
  requireBffAssertion,
  authenticateAdminSession,
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => (adminAuthController.purgeSessions as any)(req, res, next),
);

export default router;
