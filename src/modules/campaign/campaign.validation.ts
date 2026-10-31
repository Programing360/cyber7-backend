import { z } from "zod";

import {
  CAMPAIGN_AUDIENCE_MODES,
  CAMPAIGN_STATUSES,
} from "./campaign.model.js";
import { CAMPAIGN_RECIPIENT_STATUSES } from "./campaign-recipient.model.js";

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId");

const nameSchema = z
  .string()
  .trim()
  .min(2, "Campaign name must be at least 2 characters")
  .max(100, "Campaign name cannot exceed 100 characters");

const descriptionSchema = z
  .string()
  .trim()
  .max(500, "Campaign description cannot exceed 500 characters");

export const audienceConfigSchema = z
  .object({
    mode: z.enum(CAMPAIGN_AUDIENCE_MODES),
    contactIds: z
      .array(objectIdSchema)
      .max(5000, "Audience cannot contain more than 5000 contacts")
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.mode === "SELECTED_CONTACTS" &&
      (!value.contactIds || value.contactIds.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "At least one contact must be selected",
        path: ["contactIds"],
      });
    }

    if (
      value.mode === "ALL_CONTACTS" &&
      value.contactIds &&
      value.contactIds.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "contactIds must be empty for an all-contacts audience",
        path: ["contactIds"],
      });
    }
  });

export const createCampaignSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    whatsappAccountId: objectIdSchema,
    templateId: objectIdSchema,
    audience: audienceConfigSchema,
  })
  .strict();

export const updateDraftCampaignSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    whatsappAccountId: objectIdSchema.optional(),
    templateId: objectIdSchema.optional(),
    audience: audienceConfigSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one field must be provided",
  );

const scheduledAtSchema = z
  .string()
  .trim()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "scheduledAt must be a valid date",
  )
  .refine(
    (value) => Date.parse(value) > Date.now(),
    "scheduledAt must be in the future",
  );

export const scheduleCampaignSchema = z
  .object({
    scheduledAt: scheduledAtSchema,
  })
  .strict();

export const campaignListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z
      .string()
      .trim()
      .max(100, "Search term cannot exceed 100 characters")
      .optional(),
    status: z.enum(CAMPAIGN_STATUSES).optional(),
  })
  .strict();

export const campaignRecipientListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(CAMPAIGN_RECIPIENT_STATUSES).optional(),
  })
  .strict();

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateDraftCampaignInput = z.infer<
  typeof updateDraftCampaignSchema
>;
export type ScheduleCampaignInput = z.infer<typeof scheduleCampaignSchema>;
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;
export type CampaignRecipientListQuery = z.infer<
  typeof campaignRecipientListQuerySchema
>;
export type AudienceConfigInput = z.infer<typeof audienceConfigSchema>;
