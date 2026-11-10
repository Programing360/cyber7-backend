import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";
import {
  getDashboardStatsController,
  getWorkspaceAnalyticsController,
} from "./dashboard.controller.js";

const dashboardRoutes = Router();

dashboardRoutes.get(
  "/:workspaceId/stats",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getDashboardStatsController,
);

dashboardRoutes.get(
  "/:workspaceId/analytics",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getWorkspaceAnalyticsController,
);

export default dashboardRoutes;
