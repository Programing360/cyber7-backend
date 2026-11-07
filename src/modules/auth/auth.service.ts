import crypto from "node:crypto";
import User from "./user.model.js";
import SignupOtp from "./signup-otp.model.js";
import { comparePassword, hashPassword } from "../../utils/password.js";
import type {
  LoginInput,
  RegisterInput,
  SendSignupOtpInput,
  VerifySignupOtpInput,
  UpdateProfileInput,
  ChangePasswordInput,
} from "./auth.validation.js";
import { generateAccessToken } from "../../utils/jwt.js";
import { sendEmail } from "../../services/mail.service.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const sendSignupOtp = async (input: SendSignupOtpInput) => {
  const existingUser = await User.findOne({
    email: input.email,
  });

  if (existingUser) {
    throw new AuthError("An account with this email already exists", 409);
  }

  // Generate 6-digit cryptographically secure OTP
  const rawOtp = crypto.randomInt(100000, 999999).toString();
  const codeHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

  await SignupOtp.findOneAndUpdate(
    { email: input.email },
    {
      codeHash,
      expiresAt,
      attempts: 0,
      isVerified: false,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0b0f19; color: #ffffff; padding: 40px 20px; border-radius: 16px; max-width: 480px; margin: auto;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 26px; font-weight: 800; color: #10b981; letter-spacing: -0.5px;">VexChat</span>
      </div>
      <h2 style="color: #ffffff; font-size: 20px; font-weight: 700; margin-bottom: 10px; text-align: center;">Verify Your Email Address</h2>
      <p style="color: #94a3b8; font-size: 14px; text-align: center; line-height: 1.6; margin-bottom: 24px;">
        Thank you for choosing VexChat! Use the 6-digit verification code below to verify your email and activate your <strong>7-Day Free Trial</strong>:
      </p>
      <div style="background-color: #1e293b; border: 1px solid #334155; padding: 20px; border-radius: 12px; text-align: center; margin: 24px 0;">
        <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #10b981; font-family: monospace;">
          ${rawOtp}
        </span>
      </div>
      <p style="color: #64748b; font-size: 12px; text-align: center; line-height: 1.5; margin-top: 24px;">
        This code is valid for 10 minutes. If you did not request this verification, please safely ignore this email.
      </p>
    </div>
  `;

  const emailSent = await sendEmail({
    to: input.email,
    subject: `[VexChat] Verification Code: ${rawOtp}`,
    html: htmlContent,
  });

  if (!emailSent) {
    console.warn(
      `[SignupOtp] Email dispatch failed for ${input.email}. Verification code: ${rawOtp}`,
    );
  }

  return {
    success: true,
    message: "A verification code has been sent to your email.",
  };
};

export const verifySignupOtp = async (input: VerifySignupOtpInput) => {
  const existingUser = await User.findOne({
    email: input.email,
  });

  if (existingUser) {
    throw new AuthError("An account with this email already exists", 409);
  }

  const otpRecord = await SignupOtp.findOne({ email: input.email });

  if (!otpRecord) {
    throw new AuthError(
      "No active verification code found for this email. Please request a new code.",
      400,
    );
  }

  if (otpRecord.attempts >= 5) {
    await SignupOtp.deleteOne({ email: input.email });
    throw new AuthError(
      "Too many incorrect attempts. Please request a new verification code.",
      429,
    );
  }

  if (Date.now() > new Date(otpRecord.expiresAt).getTime()) {
    await SignupOtp.deleteOne({ email: input.email });
    throw new AuthError(
      "Verification code has expired. Please request a new code.",
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
    throw new AuthError("Invalid verification code. Please check and try again.", 400);
  }

  // If full credentials (name and password) were supplied, create the account directly
  if (input.name && input.password) {
    const hashedPassword = await hashPassword(input.password);
    const now = new Date();
    const trialEndDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const user = await User.create({
      name: input.name,
      email: input.email,
      password: hashedPassword,
      role: "user",
      platformRole: "USER",
      isEmailVerified: true,
      subscriptionStatus: "trial",
      trialStartDate: now,
      trialEndDate,
      isPaid: false,
    });

    await SignupOtp.deleteOne({ email: input.email });

    const accessToken = generateAccessToken(user._id.toString());

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        subscriptionStatus: user.subscriptionStatus,
        trialStartDate: user.trialStartDate,
        trialEndDate: user.trialEndDate,
        isPaid: user.isPaid,
        createdAt: user.createdAt,
      },
    };
  }

  // Otherwise, mark the OTP record as verified so registerUser can be completed
  otpRecord.isVerified = true;
  otpRecord.expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute completion window
  await otpRecord.save();

  return {
    verified: true,
    message: "OTP verified successfully. You can now complete your registration.",
  };
};

export const registerUser = async (input: RegisterInput) => {
  const existingUser = await User.findOne({
    email: input.email,
  });

  if (existingUser) {
    throw new AuthError("An account with this email already exists", 409);
  }

  // Enforce OTP verification before allowing final account creation
  const otpRecord = await SignupOtp.findOne({ email: input.email });
  if (!otpRecord || !otpRecord.isVerified) {
    throw new AuthError(
      "Email verification required. Please verify your email with OTP first.",
      403,
    );
  }

  const hashedPassword = await hashPassword(input.password);
  const now = new Date();
  const trialEndDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const user = await User.create({
      name: input.name,
      email: input.email,
      password: hashedPassword,
      role: "user",
      platformRole: "USER",
      isEmailVerified: true,
      subscriptionStatus: "trial",
      trialStartDate: now,
      trialEndDate,
      isPaid: false,
    });

    // Delete verified OTP record now that the account is permanently created
    await SignupOtp.deleteOne({ email: input.email });

    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      subscriptionStatus: user.subscriptionStatus,
      trialStartDate: user.trialStartDate,
      trialEndDate: user.trialEndDate,
      isPaid: user.isPaid,
      createdAt: user.createdAt,
    };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      throw new AuthError("An account with this email already exists", 409);
    }

    throw error;
  }
};

export const loginUser = async (input: LoginInput) => {
  const user = await User.findOne({
    email: input.email,
  }).select("+password");

  if (!user) {
    throw new AuthError("Invalid email or password", 401);
  }

  if (!user.isActive) {
    throw new AuthError("This account is inactive", 403);
  }

  const isPasswordValid = await comparePassword(
    input.password,
    user.password
  );

  if (!isPasswordValid) {
    throw new AuthError("Invalid email or password", 401);
  }

  const accessToken = generateAccessToken(user._id.toString());

  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      subscriptionStatus: (user as any).subscriptionStatus || "trial",
      trialStartDate: (user as any).trialStartDate,
      trialEndDate: (user as any).trialEndDate,
      isPaid: typeof (user as any).isPaid === "boolean" ? (user as any).isPaid : false,
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
    isAvailable: typeof userObj.isAvailable === "boolean" ? userObj.isAvailable : true,
    notifications: userObj.notifications || {
      whatsappInbound: true,
      campaignDeliveries: true,
      templateApprovals: true,
      weeklyDigest: false,
      securityAlerts: true,
      soundEffects: true,
    },
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

  if (input.name !== undefined) user.name = input.name;
  if (input.displayName !== undefined) (user as any).displayName = input.displayName;
  if (input.phoneNumber !== undefined) (user as any).phoneNumber = input.phoneNumber;
  if (input.jobTitle !== undefined) (user as any).jobTitle = input.jobTitle;
  if (input.bio !== undefined) (user as any).bio = input.bio;
  if (input.timezone !== undefined) (user as any).timezone = input.timezone;
  if (input.avatarUrl !== undefined) (user as any).avatarUrl = input.avatarUrl;
  if (input.bannerTheme !== undefined) (user as any).bannerTheme = input.bannerTheme;
  if (input.customStatus !== undefined) (user as any).customStatus = input.customStatus;
  if (input.customStatusEmoji !== undefined) (user as any).customStatusEmoji = input.customStatusEmoji;
  if (input.isAvailable !== undefined) (user as any).isAvailable = input.isAvailable;
  if (input.notifications !== undefined) {
    const existing = (user as any).notifications?.toObject?.() || (user as any).notifications || {};
    (user as any).notifications = {
      ...existing,
      ...input.notifications,
    };
  }

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

  const isCurrentValid = await comparePassword(input.currentPassword, user.password);
  if (!isCurrentValid) {
    throw new AuthError("Current password is incorrect", 400);
  }

  const hashedNewPassword = await hashPassword(input.newPassword);
  user.password = hashedNewPassword;
  await user.save();

  return { success: true, message: "Password updated successfully" };
};
