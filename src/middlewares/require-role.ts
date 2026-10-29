import type { Response, NextFunction } from "express";

import type { WorkspaceRequest } from "./require-workspace-membership.js";

type WorkspaceRole = "OWNER" | "ADMIN" | "AGENT";

export const requireRole = (...allowedRoles: WorkspaceRole[]) => {
  return (req: WorkspaceRequest, res: Response, next: NextFunction): void => {
    if (!req.workspace) {
      res.status(403).json({
        success: false,
        message: "Workspace membership must be verified first",
      });
      return;
    }

    if (!allowedRoles.includes(req.workspace.role)) {
      res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action",
      });
      return;
    }

    next();
  };
};
