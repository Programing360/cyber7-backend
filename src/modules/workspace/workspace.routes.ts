import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate.js";

import {
  createWorkspaceController,
  getMyWorkspacesController,
} from "./workspace.controller.js";
import { getWorkspaceAccessController } from "./workspace-access.controller.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { listWorkspaceMembersController } from "./workspace-member.controller.js";
import { createInvitationController } from "./invitation/invitation.controller.js";
import { requireRole } from "../../middlewares/require-role.js";

const workspaceRouter = Router();

workspaceRouter.use(authenticate);

workspaceRouter.post("/", createWorkspaceController);

workspaceRouter.get("/me", getMyWorkspacesController);
workspaceRouter.get(
  "/:workspaceId/access-check",
  requireWorkspaceMembership,
  getWorkspaceAccessController,
);

workspaceRouter.get(
  "/:workspaceId/members",
  requireWorkspaceMembership,
  listWorkspaceMembersController
);

workspaceRouter.post(
  "/:workspaceId/invitations",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  createInvitationController
);

export default workspaceRouter;
