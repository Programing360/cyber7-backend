import mongoose from "mongoose";
import type { Response, NextFunction } from "express";

import Membership from "../modules/workspace/membership.model.js";
import Workspace from "../modules/workspace/workspace.model.js";
import type { AuthenticatedRequest } from "./authenticate.js";

export interface WorkspaceRequest extends AuthenticatedRequest {
  workspace?: {
    id: string;
    role: "USER" |"OWNER" | "ADMIN" | "AGENT";
    membershipId: string;
  };
}

export const requireWorkspaceMembership = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const workspaceId = (
      req.params.workspaceId ||
      (req.query.workspaceId as string) ||
      (req.headers["x-workspace-id"] as string) ||
      req.body?.workspaceId
    ) as string;

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      res.status(400).json({
        success: false,
        message: "A valid workspace ID is required",
      });
      return;
    }

    const membership = await Membership.findOne({
      workspaceId,
      userId: req.user.id,
      status: "ACTIVE",
    }).select("_id workspaceId role");

    if (!membership) {
      // 1. Check if user is the direct workspace owner
      const workspace = await Workspace.findById(workspaceId).select(
        "_id ownerId",
      );
      if (workspace && workspace.ownerId?.toString() === req.user.id) {
        req.workspace = {
          id: workspace._id.toString(),
          role: "OWNER",
          membershipId: `owner-${workspace._id.toString()}`,
        };
        next();
        return;
      }

      // 2. Check if user is a platform admin (SUPER_ADMIN or FINANCE_ADMIN)
      const userPlatformRole = String(
        req.user.platformRole || req.user.role || "",
      ).toUpperCase();
      if (
        userPlatformRole === "SUPER_ADMIN" ||
        userPlatformRole === "FINANCE_ADMIN" ||
        req.user.role === "admin" ||
        req.user.role === "super_admin"
      ) {
        req.workspace = {
          id: workspaceId,
          role: "OWNER",
          membershipId: `admin-${req.user.id}`,
        };
        next();
        return;
      }

      res.status(403).json({
        success: false,
        message: "You do not have access to this workspace",
      });
      return;
    }

    req.workspace = {
      id: membership.workspaceId.toString(),
      role: membership.role as "OWNER" | "ADMIN" | "AGENT",
      membershipId: membership._id.toString(),
    };

    next();
  } catch (error: unknown) {
    next(error);
  }
};
