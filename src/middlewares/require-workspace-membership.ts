import mongoose from "mongoose";
import type { Response, NextFunction } from "express";

import Membership from "../modules/workspace/membership.model.js";
import type { AuthenticatedRequest } from "./authenticate.js";

export interface WorkspaceRequest extends AuthenticatedRequest {
  workspace?: {
    id: string;
    role: "OWNER" | "ADMIN" | "AGENT";
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

    const workspaceId = req.params.workspaceId as string;

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
