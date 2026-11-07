import { z } from "zod";

export const registerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name cannot exceed 100 characters"),

    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .max(254, "Email is too long")
      .transform((email) => email.toLowerCase()),

    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(72, "Password is too long for this password-hashing configuration"),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export const sendSignupOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .max(254, "Email is too long")
      .transform((email) => email.toLowerCase()),
  })
  .strict();

export type SendSignupOtpInput = z.infer<typeof sendSignupOtpSchema>;

export const verifySignupOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .max(254, "Email is too long")
      .transform((email) => email.toLowerCase()),

    otp: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Verification code must be exactly 6 digits"),

    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name cannot exceed 100 characters")
      .optional(),

    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(72, "Password is too long for this password-hashing configuration")
      .optional(),
  })
  .strict();

export type VerifySignupOtpInput = z.infer<typeof verifySignupOtpSchema>;


export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .max(254, "Email is too long")
      .transform((email) => email.toLowerCase()),

    password: z.string().min(1, "Password is required"),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name cannot exceed 100 characters")
      .optional(),
    displayName: z
      .string()
      .trim()
      .max(100, "Display name cannot exceed 100 characters")
      .optional(),
    phoneNumber: z
      .string()
      .trim()
      .max(35, "Phone number cannot exceed 35 characters")
      .optional(),
    jobTitle: z
      .string()
      .trim()
      .max(100, "Job title cannot exceed 100 characters")
      .optional(),
    bio: z
      .string()
      .trim()
      .max(500, "Bio cannot exceed 500 characters")
      .optional(),
    timezone: z
      .string()
      .trim()
      .max(100, "Timezone identifier is too long")
      .optional(),
    avatarUrl: z.string().optional(),
    bannerTheme: z
      .string()
      .trim()
      .max(50, "Banner theme is invalid")
      .optional(),
    customStatus: z
      .string()
      .trim()
      .max(100, "Status text cannot exceed 100 characters")
      .optional(),
    customStatusEmoji: z
      .string()
      .trim()
      .max(10, "Status emoji is too long")
      .optional(),
    isAvailable: z.boolean().optional(),
    notifications: z
      .object({
        whatsappInbound: z.boolean().optional(),
        campaignDeliveries: z.boolean().optional(),
        templateApprovals: z.boolean().optional(),
        weeklyDigest: z.boolean().optional(),
        securityAlerts: z.boolean().optional(),
        soundEffects: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters")
      .max(72, "New password is too long for this hashing configuration"),
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
