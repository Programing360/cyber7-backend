import type { Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import { getWorkspaceDashboardStats } from "./dashboard.service.js";

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
