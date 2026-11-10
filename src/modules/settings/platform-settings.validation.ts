import { z } from "zod";

export const sessionPoliciesSchema = z.object({
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(1, "Idle timeout must be at least 1 minute")
    .max(1440, "Idle timeout cannot exceed 1440 minutes")
    .optional(),
  absoluteLifetimeHours: z
    .number()
    .int()
    .min(1, "Absolute lifetime must be at least 1 hour")
    .max(720, "Absolute lifetime cannot exceed 720 hours")
    .optional(),
  highValueStepUpThresholdBdt: z
    .number()
    .min(0, "Threshold cannot be negative")
    .optional(),
});

export const gatewayTogglesSchema = z.object({
  bkashDirect: z.boolean().optional(),
  cityBankTransfer: z.boolean().optional(),
  portPosCards: z.boolean().optional(),
});

export const updatePlatformSettingsSchema = z.object({
  currency: z.string().trim().min(3).max(3).toUpperCase().optional(),
  maintenanceMode: z.boolean().optional(),
  sessionPolicies: sessionPoliciesSchema.optional(),
  gatewayToggles: gatewayTogglesSchema.optional(),
});

export type UpdatePlatformSettingsInput = z.infer<
  typeof updatePlatformSettingsSchema
>;

