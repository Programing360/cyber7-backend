import User from "./user.model.js";
import { comparePassword, hashPassword } from "../../utils/password.js";
import type {
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
  ChangePasswordInput,
} from "./auth.validation.js";
import { generateAccessToken } from "../../utils/jwt.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const registerUser = async (input: RegisterInput) => {
  const existingUser = await User.findOne({
    email: input.email,
  });

  if (existingUser) {
    throw new AuthError("An account with this email already exists", 409);
  }

  const hashedPassword = await hashPassword(input.password);

  try {
    const user = await User.create({
      name: input.name,
      email: input.email,
      password: hashedPassword,
      role: "OWNER",
    });

    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
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
