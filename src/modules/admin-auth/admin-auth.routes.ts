import { Router, type Request, type Response } from "express";
import { adminAuthController } from "./admin-auth.controller.js";
import { adminAuthService } from "./admin-auth.service.js";
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
import { verifyAccessToken } from "../../utils/jwt.js";
import User from "../auth/user.model.js";

const router = Router();
// সেশন চেক করার জন্য লাইটওয়েট রাউট (কুকি থাকলে রোল রিটার্ন করবে, না থাকলে authenticated: false)
router.get("/session-check", async (req: Request, res: Response) => {
  try {
    const config = loadAdminSessionEnv();
    const cookieName = config.ADMIN_SESSION_COOKIE_NAME;

    const cookieMap =
      (
        req as Request & {
          cookies?: Record<string, string>;
        }
      ).cookies || parseCookieHeader(req.headers?.cookie);

    const token = cookieMap?.[cookieName];

    // ১. ডেডিকেটেড অ্যাডমিন সেশন কুকি চেক
    if (token) {
      const result = await adminSessionService.authenticateAdminSession(token);

      if (result.success && result.user) {
        const allowedRoles = ["SUPER_ADMIN", "FINANCE_ADMIN"];

        if (allowedRoles.includes(result.user.platformRole)) {
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
          return;
        }
      }
    }

    // ২. ফলব্যাক: অলরেডি লগইন করা SUPER_ADMIN / FINANCE_ADMIN ইউজার কিনা যাচাই (Bearer টোকেন বা অ্যাক্সেস কুকি)
    let accessToken: string | undefined;
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      accessToken = authHeader.slice("Bearer ".length).trim();
    }
    if (!accessToken) {
      accessToken =
        cookieMap?.["vexchat_access_token"] ||
        cookieMap?.["accessToken"] ||
        cookieMap?.["token"];
    }

    if (accessToken) {
      try {
        const payload = verifyAccessToken(accessToken);
        if (payload?.sub) {
          const user = await User.findById(payload.sub).select(
            "_id name email role platformRole isActive tokenInvalidBefore isEmailVerified",
          );

          const isInvalid =
            !user ||
            !user.isActive ||
            Boolean(
              user.tokenInvalidBefore &&
                payload.iat &&
                payload.iat * 1000 <
                  new Date(user.tokenInvalidBefore).getTime(),
            );

          const allowedRoles = ["SUPER_ADMIN", "FINANCE_ADMIN"];
          if (user && !isInvalid && allowedRoles.includes(user.platformRole)) {
            // ইউজার অলরেডি ভেরিফাইড প্ল্যাটফর্ম অ্যাডমিন; স্বয়ংক্রিয়ভাবে অ্যাডমিন সেশন তৈরি ও কুকি সেট
            const forwarded = req.headers["x-forwarded-for"];
            const clientIp =
              typeof forwarded === "string"
                ? forwarded.split(",")[0].trim()
                : req.ip || undefined;
            const userAgent =
              typeof req.headers["user-agent"] === "string"
                ? req.headers["user-agent"]
                : undefined;

            const authResult = await adminAuthService.completeChallengeSession({
              userId: user._id,
              ipAddress: clientIp,
              userAgent,
            });

            if (
              authResult.success &&
              authResult.cookieOptions &&
              authResult.rawToken
            ) {
              res.cookie(
                authResult.cookieOptions.name,
                authResult.rawToken,
                authResult.cookieOptions.options,
              );
            }

            res.cookie("user_role", user.platformRole, {
              path: "/",
              httpOnly: false,
              sameSite: "lax",
              secure: process.env.NODE_ENV === "production",
            });

            res.status(200).json({
              success: true,
              authenticated: true,
              platformRole: user.platformRole,
              user: {
                id: String(user._id),
                email: user.email,
                name: user.name,
              },
            });
            return;
          }
        }
      } catch (tokenErr) {
        console.warn(
          "[Admin Session Check] Access token verification failed:",
          tokenErr,
        );
      }
    }

    // কুকি বা ভ্যালিড প্ল্যাটফর্ম অ্যাডমিন টোকেন কোনোটিই না থাকলে
    res.status(200).json({
      success: true,
      authenticated: false,
      reason: "ADMIN_SESSION_COOKIE_MISSING",
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
