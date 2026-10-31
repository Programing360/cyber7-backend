import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate.js";

import {
  createWorkspaceController,
  getMyWorkspacesController,
  updateWorkspaceController,
} from "./workspace.controller.js";
import { getWorkspaceAccessController } from "./workspace-access.controller.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import {
  listWorkspaceMembersController,
  removeWorkspaceMemberController,
  updateMemberRoleController,
  updateMemberStatusController,
} from "./workspace-member.controller.js";
import { createInvitationController } from "./invitation/invitation.controller.js";
import { requireRole } from "../../middlewares/require-role.js";
import {
  listWorkspaceInvitationsController,
  revokeWorkspaceInvitationController,
} from "./invitation-management/invitation-management.controller.js";

const workspaceRouter = Router();

workspaceRouter.use(authenticate);

workspaceRouter.post("/", createWorkspaceController);

workspaceRouter.get("/me", getMyWorkspacesController);
workspaceRouter.get(
  "/:workspaceId/access-check",
  requireWorkspaceMembership,
  getWorkspaceAccessController,
);

workspaceRouter.patch(
  "/:workspaceId",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  updateWorkspaceController,
);

workspaceRouter.get(
  "/:workspaceId/members",
  requireWorkspaceMembership,
  listWorkspaceMembersController,
);

workspaceRouter.post(
  "/:workspaceId/invitations",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  createInvitationController,
);

// List pending invitations
workspaceRouter.get(
  "/:workspaceId/invitations",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  listWorkspaceInvitationsController,
);

// Revoke invitation
workspaceRouter.delete(
  "/:workspaceId/invitations/:invitationId",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  revokeWorkspaceInvitationController,
);

workspaceRouter.patch(
  "/:workspaceId/members/:memberId/role",
  requireWorkspaceMembership,
  updateMemberRoleController,
);

workspaceRouter.patch(
  "/:workspaceId/members/:memberId/status",
  requireWorkspaceMembership,
  updateMemberStatusController,
);

workspaceRouter.delete(
  "/:workspaceId/members/:memberId",
  requireWorkspaceMembership,
  removeWorkspaceMemberController,
);

export default workspaceRouter;
