import { z } from "zod";

export const connectWhatsAppSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(2, "Business name must be at least 2 characters")
    .max(100),

  businessAccountId: z
    .string()
    .trim()
    .min(5, "Invalid WhatsApp Business Account ID"),

  phoneNumberId: z.string().trim().min(5, "Invalid Phone Number ID"),

  displayPhoneNumber: z.string().trim().min(5, "Invalid phone number"),

  accessToken: z.string().trim().min(20, "Invalid access token"),
});

export type ConnectWhatsAppInput = z.infer<typeof connectWhatsAppSchema>;

const WHATSAPP_STATUSES = [
  "CONNECTED",
  "DISCONNECTED",
  "PENDING",
  "ERROR",
] as const;

export const updateWhatsAppStatusSchema = z.object({
  status: z.enum(WHATSAPP_STATUSES, {
    error: "Invalid status value",
  }),
});

export type UpdateWhatsAppStatusInput = z.infer<
  typeof updateWhatsAppStatusSchema
>;

export const sendWhatsAppTextMessageSchema = z.object({
  conversationId: z.string().regex(/^[0-9a-fA-F]{24}$/, {
    message: "Invalid conversation ID",
  }),
  text: z
    .string()
    .trim()
    .min(1, "Message cannot be empty")
    .max(4096, "Message cannot exceed 4096 characters"),
});

export type SendWhatsAppTextMessageInput = z.infer<
  typeof sendWhatsAppTextMessageSchema
>;

export const createContactSchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .min(7, "Phone number must be at least 7 characters")
    .max(25, "Phone number cannot exceed 25 characters"),
  profileName: z
    .string()
    .trim()
    .max(100, "Profile name cannot exceed 100 characters")
    .optional(),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    phoneNumber: z
      .string()
      .trim()
      .min(7, "Phone number must be at least 7 characters")
      .max(25, "Phone number cannot exceed 25 characters")
      .optional(),
    profileName: z
      .string()
      .trim()
      .max(100, "Profile name cannot exceed 100 characters")
      .optional(),
  })
  .strict()
  .refine(
    (data) => data.phoneNumber !== undefined || data.profileName !== undefined,
    {
      message: "At least one field must be provided to update the contact",
    },
  );

export type UpdateContactInput = z.infer<typeof updateContactSchema>;

const CONVERSATION_STATUSES = ["OPEN", "CLOSED", "PENDING"] as const;

export const updateConversationStatusSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES, {
    error: "Invalid status value. Must be OPEN, CLOSED, or PENDING",
  }),
});

export type UpdateConversationStatusInput = z.infer<
  typeof updateConversationStatusSchema
>;