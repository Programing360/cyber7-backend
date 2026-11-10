import crypto from "node:crypto";
import User from "./user.model.js";
import SignupOtp from "./signup-otp.model.js";
import { comparePassword, hashPassword } from "../../utils/password.js";
import type {
  InitiateRegisterInput,
  VerifyRegistrationOtpInput,
  ResendOtpInput,
  LoginInput,
  UpdateProfileInput,
  ChangePasswordInput,
} from "./auth.validation.js";
import { generateAccessToken } from "../../utils/jwt.js";
import { sendEmail } from "../../services/mail.service.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string, // ফ্রন্টএন্ডে স্পেসিফিক অ্যাকশন নেওয়ার জন্য কোড (যেমন: SUBSCRIPTION_EXPIRED)
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// ধাপ ১: ইউজার সব ইনফো দিয়ে সাবমিট করবে, OTP জেনারেট হয়ে মেইলে যাবে
export const initiateRegistration = async (input: InitiateRegisterInput) => {
  const existingUser = await User.findOne({ email: input.email });
  if (existingUser) {
    throw new AuthError("An account with this email already exists", 409);
  }

  const existingPhone = await User.findOne({ phoneNumber: input.phoneNumber });
  if (existingPhone) {
    throw new AuthError(
      "This phone number is already registered with another account",
      409,
    );
  }

  const rawOtp = crypto.randomInt(100000, 999999).toString();
  const codeHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // ১০ মিনিট মেয়াদ

  const hashedPassword = await hashPassword(input.password);

  await SignupOtp.findOneAndUpdate(
    { email: input.email },
    {
      codeHash,
      tempRegistrationData: {
        name: input.name,
        phoneNumber: input.phoneNumber,
        passwordHash: hashedPassword,
      },
      expiresAt,
      attempts: 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0b0f19; color: #ffffff; padding: 40px 20px; border-radius: 16px; max-width: 480px; margin: auto;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 26px; font-weight: 800; color: #10b981;">VexChat</span>
      </div>
      <h2 style="color: #ffffff; font-size: 20px; text-align: center;">Verify Your Email</h2>
      <p style="color: #94a3b8; font-size: 14px; text-align: center; line-height: 1.6;">
        Welcome to VexChat! Use this OTP to activate your account and start your <strong>7-Day Free Trial</strong>:
      </p>
      <div style="background-color: #1e293b; border: 1px solid #334155; padding: 18px; border-radius: 12px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #10b981; font-family: monospace;">
          ${rawOtp}
        </span>
      </div>
      <p style="color: #64748b; font-size: 12px; text-align: center;">
        Valid for 10 minutes. If you did not create an account, ignore this email.
      </p>
    </div>
  `;

  await sendEmail({
    to: input.email,
    subject: `[VexChat] Verification Code: ${rawOtp}`,
    html: htmlContent,
  });

  return {
    success: true,
    message: "A 6-digit verification code has been sent to your email.",
  };
};

// ধাপ ২: OTP ভেরিফাই করে পার্মানেন্ট ইউজার তৈরি ও ৭ দিনের ট্রায়াল সেট
export const verifyRegistrationOtp = async (
  input: VerifyRegistrationOtpInput,
) => {
  const existingUser = await User.findOne({ email: input.email });
  if (existingUser) {
    throw new AuthError("An account with this email already exists", 409);
  }

  const otpRecord = await SignupOtp.findOne({ email: input.email });
  if (!otpRecord) {
    throw new AuthError(
      "No registration request found or session expired. Please sign up again.",
      400,
    );
  }

  if (otpRecord.attempts >= 5) {
    await SignupOtp.deleteOne({ email: input.email });
    throw new AuthError(
      "Too many incorrect attempts. Please sign up again.",
      429,
    );
  }

  if (Date.now() > new Date(otpRecord.expiresAt).getTime()) {
    await SignupOtp.deleteOne({ email: input.email });
    throw new AuthError(
      "Verification code has expired. Please request a new one.",
      400,
    );
  }

  const inputHash = crypto
    .createHash("sha256")
    .update(input.otp.trim())
    .digest("hex");

  if (inputHash !== otpRecord.codeHash) {
    otpRecord.attempts = (otpRecord.attempts || 0) + 1;
    await otpRecord.save();
    throw new AuthError(
      "Invalid verification code. Please check and try again.",
      400,
    );
  }

  const { name, phoneNumber, passwordHash } = otpRecord.tempRegistrationData;

  const now = new Date();
  const trialEndDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // ৭ দিন ফ্রি অ্যাক্সেস

  const user = await User.create({
    name,
    email: input.email,
    phoneNumber,
    password: passwordHash,
    role: "user",
    platformRole: "USER",
    isEmailVerified: true,
    subscriptionStatus: "trial",
    trialStartDate: now,
    trialEndDate,
    isPaid: false,
    isActive: true,
  });

  // ওটিপি ডাটা ক্লিন
  await SignupOtp.deleteOne({ email: input.email });

  const accessToken = generateAccessToken(user._id.toString());

  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "7d",
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      role: user.role,
      subscriptionStatus: user.subscriptionStatus,
      trialStartDate: user.trialStartDate,
      trialEndDate: user.trialEndDate,
      isPaid: user.isPaid,
    },
  };
};

// ধাপ ৩: ওটিপি রিসেন্ড করার জন্য
export const resendRegistrationOtp = async (input: ResendOtpInput) => {
  const otpRecord = await SignupOtp.findOne({ email: input.email });
  if (!otpRecord) {
    throw new AuthError("No pending registration found for this email.", 404);
  }

  const rawOtp = crypto.randomInt(100000, 999999).toString();
  otpRecord.codeHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
  otpRecord.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  otpRecord.attempts = 0;
  await otpRecord.save();

  await sendEmail({
    to: input.email,
    subject: `[VexChat] New Verification Code: ${rawOtp}`,
    html: `<p>Your new verification code is: <strong>${rawOtp}</strong>. Valid for 10 minutes.</p>`,
  });

  return {
    success: true,
    message: "A new verification code has been sent to your email.",
  };
};

// ধাপ ৪: লগইন এবং ৭ দিন পার হলে সাবস্ক্রিপশন ব্লক চেক
export const loginUser = async (input: LoginInput) => {
  const user = await User.findOne({ email: input.email }).select("+password");
  if (!user) {
    throw new AuthError("Invalid email or password", 401);
  }

  const isPasswordValid = await comparePassword(input.password, user.password);
  if (!isPasswordValid) {
    throw new AuthError("Invalid email or password", 401);
  }

  if (!user.isActive) {
    throw new AuthError("This account is suspended or inactive.", 403);
  }

  // const isPasswordValid = await comparePassword(input.password, user.password);
  if (!isPasswordValid) {
    throw new AuthError("Invalid email or password", 401);
  }

  // ইমেইল ভেরিফাইড কি না চেক
  if (!user.isEmailVerified) {
    throw new AuthError(
      "Please verify your email address before logging in.",
      403,
      "EMAIL_NOT_VERIFIED",
    );
  }

  // ৭ দিনের ফ্রি ট্রায়াল চেক: পেইড না হলে এবং ট্রায়ালের মেয়াদ শেষ হলে ব্লক
  const now = new Date();
  const trialExpired = user.trialEndDate && now > new Date(user.trialEndDate);

  if (!user.isPaid && (trialExpired || user.subscriptionStatus === "expired")) {
    // ডাটাবেসে স্ট্যাটাস সিঙ্ক
    if (user.subscriptionStatus !== "expired") {
      user.subscriptionStatus = "expired";
      await user.save();
    }

    throw new AuthError(
      "Your 7-day free trial has expired. Please subscribe to a plan to continue using VexChat.",
      403,
      "SUBSCRIPTION_EXPIRED", // ফ্রন্টএন্ড এই কোড দেখে প্রাইসিং পেজে পাঠাবে
    );
  }

  const accessToken = generateAccessToken(user._id.toString());

  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "7d",
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      platformRole: user.platformRole,
      isEmailVerified: user.isEmailVerified,
      subscriptionStatus: user.subscriptionStatus,
      trialStartDate: user.trialStartDate,
      trialEndDate: user.trialEndDate,
      isPaid: user.isPaid,
    },
  };
};

export const getUserProfile = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AuthError("User not found or inactive", 404);
  }

  const userObj = user.toObject();

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    platformRole: user.platformRole,
    isEmailVerified: user.isEmailVerified,
    subscriptionStatus: userObj.subscriptionStatus || "trial",
    trialStartDate: userObj.trialStartDate,
    trialEndDate: userObj.trialEndDate,
    isPaid: typeof userObj.isPaid === "boolean" ? userObj.isPaid : false,
    displayName: userObj.displayName || "",
    phoneNumber: userObj.phoneNumber || "",
    jobTitle: userObj.jobTitle || "Operations & Growth Lead",
    bio: userObj.bio || "",
    timezone: userObj.timezone || "Asia/Dhaka",
    avatarUrl: userObj.avatarUrl || "",
    bannerTheme: userObj.bannerTheme || "aurora",
    customStatus: userObj.customStatus || "Focusing on automations",
    customStatusEmoji: userObj.customStatusEmoji || "🚀",
    isAvailable:
      typeof userObj.isAvailable === "boolean" ? userObj.isAvailable : true,
    notifications: userObj.notifications,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

export const updateUserProfile = async (
  userId: string,
  input: UpdateProfileInput,
) => {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AuthError("User not found or inactive", 404);
  }

  Object.assign(user, input);
  await user.save();

  return getUserProfile(userId);
};

export const changeUserPassword = async (
  userId: string,
  input: ChangePasswordInput,
) => {
  const user = await User.findById(userId).select("+password");
  if (!user || !user.isActive) {
    throw new AuthError("User not found or inactive", 404);
  }

  const isCurrentValid = await comparePassword(
    input.currentPassword,
    user.password,
  );
  if (!isCurrentValid) {
    throw new AuthError("Current password is incorrect", 400);
  }

  user.password = await hashPassword(input.newPassword);
  await user.save();

  return { success: true, message: "Password updated successfully" };
};
