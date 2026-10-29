import { z } from "zod";

export const createInvitationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),

    role: z.enum(["ADMIN", "AGENT"]),
  })
  .strict();

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(32).max(256),
  })
  .strict();

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
