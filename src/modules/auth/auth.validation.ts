import { z } from "zod";

// বাংলাদেশি ও আন্তর্জাতিক ফোন নম্বর ভ্যালিডেশন
const phoneRegex = /^(?:\+8801|8801|01)[3-9]\d{8}$/;

export const initiateRegisterSchema = z
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

    phoneNumber: z
      .string()
      .trim()
      .regex(
        phoneRegex,
        "Please provide a valid phone number (e.g., 017XXXXXXXX)",
      ),

    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(72, "Password is too long"),
  })
  .strict();

export type InitiateRegisterInput = z.infer<typeof initiateRegisterSchema>;

export const verifyRegistrationOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .transform((email) => email.toLowerCase()),

    otp: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Verification code must be exactly 6 digits"),
  })
  .strict();

export type VerifyRegistrationOtpInput = z.infer<
  typeof verifyRegistrationOtpSchema
>;

export const resendOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .transform((email) => email.toLowerCase()),
  })
  .strict();

export type ResendOtpInput = z.infer<typeof resendOtpSchema>;

export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .transform((email) => email.toLowerCase()),

    password: z.string().min(1, "Password is required"),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    displayName: z.string().trim().max(100).optional(),
    phoneNumber: z
      .string()
      .trim()
      .regex(phoneRegex, "Invalid phone number")
      .optional(),
    jobTitle: z.string().trim().max(100).optional(),
    bio: z.string().trim().max(500).optional(),
    timezone: z.string().trim().max(100).optional(),
    avatarUrl: z.string().optional(),
    bannerTheme: z.string().trim().max(50).optional(),
    customStatus: z.string().trim().max(100).optional(),
    customStatusEmoji: z.string().trim().max(10).optional(),
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
      .max(72),
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// Aliases for compatibility
export const sendSignupOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please provide a valid email address")
      .transform((email) => email.toLowerCase()),
  })
  .strict();

export const verifySignupOtpSchema = verifyRegistrationOtpSchema;
export const registerSchema = initiateRegisterSchema;
