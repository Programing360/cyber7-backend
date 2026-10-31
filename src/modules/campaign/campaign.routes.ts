import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate.js";
import { requireRole } from "../../middlewares/require-role.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import {
  cancelCampaignController,
  createCampaignController,
  deleteCampaignController,
  getCampaignController,
  listCampaignRecipientsController,
  listCampaignsController,
  pauseCampaignController,
  resumeCampaignController,
  scheduleCampaignController,
  updateCampaignController,
} from "./campaign.controller.js";

const campaignRoutes = Router();

campaignRoutes.post(
  "/:workspaceId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  createCampaignController,
);

campaignRoutes.get(
  "/:workspaceId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  listCampaignsController,
);

campaignRoutes.get(
  "/:workspaceId/:campaignId/recipients",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  listCampaignRecipientsController,
);

campaignRoutes.get(
  "/:workspaceId/:campaignId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getCampaignController,
);

campaignRoutes.patch(
  "/:workspaceId/:campaignId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  updateCampaignController,
);

campaignRoutes.delete(
  "/:workspaceId/:campaignId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  deleteCampaignController,
);

campaignRoutes.post(
  "/:workspaceId/:campaignId/schedule",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  scheduleCampaignController,
);

campaignRoutes.post(
  "/:workspaceId/:campaignId/cancel",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  cancelCampaignController,
);

campaignRoutes.post(
  "/:workspaceId/:campaignId/pause",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  pauseCampaignController,
);

campaignRoutes.post(
  "/:workspaceId/:campaignId/resume",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  resumeCampaignController,
);

export default campaignRoutes;
