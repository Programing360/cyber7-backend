import { Router } from "express";
import {
  getCurrentUserController,
  getProfileController,
  updateProfileController,
  changePasswordController,
  loginController,
  registerController,
  sendSignupOtpController,
  verifySignupOtpController,
} from "./auth.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import {
  loginRateLimiter,
  registerRateLimiter,
} from "../../middlewares/rate-limiter.js";

const authRouter = Router();

authRouter.post("/send-signup-otp", registerRateLimiter, sendSignupOtpController);
authRouter.post("/verify-signup-otp", registerRateLimiter, verifySignupOtpController);
authRouter.post("/register", registerRateLimiter, registerController);
authRouter.post("/login", loginRateLimiter, loginController);
authRouter.get("/me", authenticate, getCurrentUserController);
authRouter.get("/profile", authenticate, getProfileController);
authRouter.patch("/profile", authenticate, updateProfileController);
authRouter.put("/profile", authenticate, updateProfileController);
authRouter.post("/change-password", authenticate, changePasswordController);

export default authRouter;
