import { z } from "zod";

export const updateWorkspaceQuotasSchema = z.object({
  maxWhatsAppNumbers: z
    .union([z.number().int().min(1), z.literal(-1), z.null()])
    .optional(),
  maxTeamMembers: z
    .union([z.number().int().min(1), z.literal(-1), z.null()])
    .optional(),
});

export const modifySubscriptionPlanSchema = z.object({
  planCode: z.string().trim().min(1, "Plan code is required"),
  immediate: z.boolean().default(true),
  adminNotes: z.string().trim().max(500).optional(),
});

export const cancelSubscriptionSchema = z.object({
  reason: z.string().trim().min(3, "Cancellation reason must be at least 3 characters"),
  cancelAtPeriodEnd: z.boolean().default(false),
});

export const createCustomPlanSchema = z.object({
  planCode: z.string().trim().min(2).max(50).toUpperCase(),
  name: z.string().trim().min(2).max(100),
  priceBdt: z.number().min(0, "Price must be non-negative"),
  description: z.string().trim().max(500).optional(),
  limits: z.object({
    maxWhatsAppNumbers: z.number().int(),
    maxTeamMembers: z.number().int(),
  }),
  features: z.array(z.string().trim()).optional(),
});

export const updateCustomPlanSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  priceBdt: z.number().min(0, "Price must be non-negative").optional(),
  description: z.string().trim().max(500).optional(),
  limits: z
    .object({
      maxWhatsAppNumbers: z.number().int(),
      maxTeamMembers: z.number().int(),
    })
    .partial()
    .optional(),
  features: z.array(z.string().trim()).optional(),
});

export type UpdateWorkspaceQuotasInput = z.infer<typeof updateWorkspaceQuotasSchema>;
export type ModifySubscriptionPlanInput = z.infer<typeof modifySubscriptionPlanSchema>;
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;
export type CreateCustomPlanInput = z.infer<typeof createCustomPlanSchema>;
export type UpdateCustomPlanInput = z.infer<typeof updateCustomPlanSchema>;
