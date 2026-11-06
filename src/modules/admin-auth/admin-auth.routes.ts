import { Router } from "express";
import { adminAuthController } from "./admin-auth.controller.js";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import { authenticateAdminSession } from "../../middlewares/authenticate-admin-session.js";
import { createAdminRateLimiter } from "../../middlewares/admin-rate-limit.js";

const router = Router();

// সেনসিটিভ অথেন্টিকেশন চেষ্টার জন্য স্ট্রিক্ট রেট লিমিটার (১৫ মিনিটে ৫টি ব্যর্থ চেষ্টা)
const authLimiter = createAdminRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});

// ইমেইল স্প্যামিং রোধে Resend OTP এর জন্য আলাদা রেট লিমিটার (৫ মিনিটে ৩টি রিকোয়েস্ট)
const resendOtpLimiter = createAdminRateLimiter({
  maxAttempts: 3,
  windowMs: 5 * 60 * 1000,
});

// ১. ইনিশিয়াল SUPER_ADMIN বুটস্ট্র্যাপ
router.post(
  "/bootstrap",
  requireBffAssertion,
  authLimiter,
  adminAuthController.bootstrap,
);

// ২. অ্যাডমিন প্রাইমারি লগইন (পাসওয়ার্ড ভেরিফিকেশন ও Email OTP প্রেরণ)
router.post(
  "/login",
  requireBffAssertion,
  authLimiter,
  adminAuthController.login,
);

// ৩. Email OTP ভেরিফিকেশন এবং সেশন কুকি প্রদান
router.post(
  "/mfa/verify",
  requireBffAssertion,
  authLimiter,
  adminAuthController.verifyEmailOtp,
);

// ৪. নতুন Email OTP প্রেরণের রিকোয়েস্ট (Resend)
router.post(
  "/resend-otp",
  requireBffAssertion,
  resendOtpLimiter,
  adminAuthController.resendEmailOtp,
);

// ৫. কারেন্ট অ্যাডমিন প্রোফাইল ও সেশন স্ট্যাটাস
router.get(
  "/me",
  requireBffAssertion,
  authenticateAdminSession,
  adminAuthController.getMe,
);

// ৬. অ্যাডমিন লগআউট ও সেশন রিভোকেশন
router.post(
  "/logout",
  requireBffAssertion,
  authenticateAdminSession,
  adminAuthController.logout,
);

export default router;
