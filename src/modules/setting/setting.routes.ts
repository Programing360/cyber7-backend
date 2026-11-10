import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";
import {
  getWorkspaceSettingsController,
  updateWorkspaceSettingsController,
  regenerateApiKeyController,
  getSettingsProfileController,
  updateSettingsProfileController,
  changeSettingsPasswordController,
} from "./setting.controller.js";

const settingRouter = Router();

// Base protection
settingRouter.use(authenticate);

// ─── Workspace Settings Endpoints ───────────────────────────────────────────
settingRouter.get(
  "/workspace/:workspaceId",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getWorkspaceSettingsController,
);

settingRouter.get(
  "/workspace",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getWorkspaceSettingsController,
);

settingRouter.patch(
  "/workspace/:workspaceId",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  updateWorkspaceSettingsController,
);

settingRouter.patch(
  "/workspace",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  updateWorkspaceSettingsController,
);

settingRouter.post(
  "/workspace/:workspaceId/api-key",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  regenerateApiKeyController,
);

settingRouter.post(
  "/workspace/api-key",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  regenerateApiKeyController,
);

// ─── User Profile & Password Endpoints ──────────────────────────────────────
settingRouter.get("/profile", getSettingsProfileController);
settingRouter.patch("/profile", updateSettingsProfileController);
settingRouter.put("/profile", updateSettingsProfileController);
settingRouter.post("/change-password", changeSettingsPasswordController);

export default settingRouter;
