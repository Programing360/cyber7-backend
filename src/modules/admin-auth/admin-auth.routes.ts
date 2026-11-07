import { Router } from "express";
import { adminAuthController } from "./admin-auth.controller.js";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import { authenticateAdminSession } from "../../middlewares/authenticate-admin-session.js";
import { createAdminRateLimiter } from "../../middlewares/admin-rate-limit.js";
import { redirectIfAdminAuthenticated } from "../../middlewares/redirect-if-admin-authenticated.js";

const router = Router();

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

export default router;
