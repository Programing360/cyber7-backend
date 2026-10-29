import type { Response } from "express";

import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";

export const getWorkspaceAccessController = (
  req: WorkspaceRequest,
  res: Response,
): void => {
  if (!req.user || !req.workspace) {
    res.status(403).json({
      success: false,
      message: "Workspace access could not be verified",
    });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Workspace access verified successfully",
    data: {
      user: {
        id: req.user.id,
        email: req.user.email,
      },
      workspace: {
        id: req.workspace.id,
        role: req.workspace.role,
      },
    },
  });
};
