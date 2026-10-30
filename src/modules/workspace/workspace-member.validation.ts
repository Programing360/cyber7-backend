import { z } from "zod";

export const updateMemberRoleSchema = z.object({
  role: z.enum(["ADMIN", "AGENT"]),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const updateMemberStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

export type UpdateMemberStatusInput = z.infer<typeof updateMemberStatusSchema>;
