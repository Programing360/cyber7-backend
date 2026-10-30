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

const WHATSAPP_STATUSES = ["CONNECTED", "DISCONNECTED", "PENDING", "ERROR"] as const;

export const updateWhatsAppStatusSchema = z.object({
  status: z.enum(WHATSAPP_STATUSES, {
    error: "Invalid status value",
  }),
});

export type UpdateWhatsAppStatusInput = z.infer<
  typeof updateWhatsAppStatusSchema
>;
