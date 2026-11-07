import { Router } from "express";
import {
  initiateRegisterController,
  verifyRegistrationOtpController,
  resendRegistrationOtpController,
  loginController,
  getCurrentUserController,
  getProfileController,
  updateProfileController,
  changePasswordController,
} from "./auth.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import {
  loginRateLimiter,
  registerRateLimiter,
} from "../../middlewares/rate-limiter.js";

const authRouter = Router();

// রেজিস্ট্রেশন স্টেপ ১: নাম, ইমেইল, ফোন, পাসওয়ার্ড দিয়ে OTP রিকোয়েস্ট
authRouter.post(
  "/register/request",
  registerRateLimiter,
  initiateRegisterController,
);

// রেজিস্ট্রেশন স্টেপ ২: OTP ম্যাচ করে একাউন্ট তৈরি এবং ৭ দিনের ট্রায়াল এক্টিভেশন
authRouter.post(
  "/register/verify-otp",
  registerRateLimiter,
  verifyRegistrationOtpController,
);

// OTP রিসেন্ড
authRouter.post(
  "/register/resend-otp",
  registerRateLimiter,
  resendRegistrationOtpController,
);

// লগইন (ট্রায়াল মেয়াদ যাচাইসহ)
authRouter.post("/login", loginRateLimiter, loginController);

// প্রোফাইল ও সিকিউরিটি রাউটস
authRouter.get("/me", authenticate, getCurrentUserController);
authRouter.get("/profile", authenticate, getProfileController);
authRouter.patch("/profile", authenticate, updateProfileController);
authRouter.put("/profile", authenticate, updateProfileController);
authRouter.post("/change-password", authenticate, changePasswordController);

export default authRouter;
