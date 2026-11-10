import { z } from "zod";

export const updateBusinessProfileSchema = z.object({
  businessName: z.string().trim().min(2, "Business name must be at least 2 characters").max(100).optional(),
  businessEmail: z
    .string()
    .trim()
    .email("Invalid business email format")
    .or(z.literal(""))
    .optional(),
  phoneNumber: z.string().trim().max(35).optional(),
  website: z
    .string()
    .trim()
    .url("Website must be a valid URL (including https://)")
    .or(z.literal(""))
    .optional(),
  industry: z.string().trim().max(50).optional(),
  timezone: z.string().trim().max(50).optional(),
  country: z.string().trim().max(80).optional(),
  description: z.string().trim().max(1000).optional(),
});

export const updateNotificationPreferencesSchema = z.object({
  emailNotifications: z.boolean().optional(),
  campaignUpdates: z.boolean().optional(),
  messageFailureAlerts: z.boolean().optional(),
  teamActivityAlerts: z.boolean().optional(),
  weeklyReports: z.boolean().optional(),
  productUpdates: z.boolean().optional(),
});

export const updateSecurityPreferencesSchema = z.object({
  twoFactorEnabled: z.boolean().optional(),
  loginAlerts: z.boolean().optional(),
  sessionTimeout: z.string().trim().optional(),
});

export const updateApiPreferencesSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .url("Webhook endpoint must be a valid HTTPS URL")
    .or(z.literal(""))
    .optional(),
  webhookEvents: z.array(z.string().trim()).optional(),
});

export const updateWorkspaceSettingsSchema = z.object({
  business: updateBusinessProfileSchema.optional(),
  notifications: updateNotificationPreferencesSchema.optional(),
  security: updateSecurityPreferencesSchema.optional(),
  api: updateApiPreferencesSchema.optional(),
});

export type UpdateBusinessProfileInput = z.infer<typeof updateBusinessProfileSchema>;
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
export type UpdateSecurityPreferencesInput = z.infer<typeof updateSecurityPreferencesSchema>;
export type UpdateApiPreferencesInput = z.infer<typeof updateApiPreferencesSchema>;
export type UpdateWorkspaceSettingsInput = z.infer<typeof updateWorkspaceSettingsSchema>;

