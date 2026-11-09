import { z } from "zod";

export const updateWorkspaceStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"], {
    error: "Status must be either ACTIVE or SUSPENDED",
  }),
  reason: z.string().trim().max(500, "Reason cannot exceed 500 characters").optional(),
});

export const updateUserRoleSchema = z.object({
  platformRole: z.enum(["SUPER_ADMIN", "FINANCE_ADMIN", "USER"], {
    error: "Platform role must be SUPER_ADMIN, FINANCE_ADMIN, or USER",
  }),
});

export const revokeUserSessionsSchema = z.object({
  reason: z.string().trim().max(500, "Reason cannot exceed 500 characters").optional(),
});

export const updateUserStatusSchema = z.object({
  isActive: z.boolean({
    error: "isActive must be a boolean",
  }),
  reason: z.string().trim().max(500, "Reason cannot exceed 500 characters").optional(),
});

export const deleteUserSchema = z.object({
  confirmation: z.literal("DELETE", {
    error: "confirmation must strictly equal 'DELETE'",
  }),
});

export type UpdateWorkspaceStatusInput = z.infer<typeof updateWorkspaceStatusSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type RevokeUserSessionsInput = z.infer<typeof revokeUserSessionsSchema>;
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
