import { z } from "zod";

export const resendInvoiceEmailSchema = z.object({
  recipientEmail: z
    .string()
    .trim()
    .email("Invalid recipient email address")
    .optional(),
});

export type ResendInvoiceEmailInput = z.infer<typeof resendInvoiceEmailSchema>;

