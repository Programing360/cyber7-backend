import type { Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import {
  getWorkspaceDashboardStats,
  getWorkspaceAnalytics,
  type AnalyticsPeriod,
} from "./dashboard.service.js";

export const getDashboardStatsController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const daysQuery = req.query.days ? parseInt(req.query.days as string, 10) : 7;
    const activityDays = Number.isFinite(daysQuery) ? daysQuery : 7;

    const stats = await getWorkspaceDashboardStats({
      workspaceId,
      activityDays,
    });

    res.status(200).json({
      success: true,
      message: "Dashboard statistics retrieved successfully",
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};

export const getWorkspaceAnalyticsController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const periodQuery = (req.query.period as string) || "30d";
    const period: AnalyticsPeriod = ["7d", "30d", "90d"].includes(periodQuery)
      ? (periodQuery as AnalyticsPeriod)
      : "30d";

    const analytics = await getWorkspaceAnalytics({
      workspaceId,
      period,
    });

    res.status(200).json({
      success: true,
      message: "Workspace analytics retrieved successfully",
      data: analytics,
    });
  } catch (error) {
    next(error);
  }
};
