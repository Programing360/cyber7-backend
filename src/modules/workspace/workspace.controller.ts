import type { Response, NextFunction } from "express";

import type { AuthenticatedRequest } from "../../middlewares/authenticate.js";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";

import { createWorkspaceSchema } from "./workspace.validation.js";

import {
  createWorkspace,
  getUserWorkspaces,
  updateWorkspace,
} from "./workspace.service.js";

export const createWorkspaceController = async (
  req: AuthenticatedRequest,
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

    const validation = createWorkspaceSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });

      return;
    }

    const workspace = await createWorkspace(req.user.id, validation.data);

    res.status(201).json({
      success: true,
      message: "Workspace created successfully",
      data: { workspace },
    });
  } catch (error: unknown) {
    next(error);
  }
};

export const getMyWorkspacesController = async (
  req: AuthenticatedRequest,
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

    const workspaces = await getUserWorkspaces(req.user.id);

    res.status(200).json({
      success: true,
      message: "Workspaces retrieved successfully",
      data: { workspaces },
    });
  } catch (error: unknown) {
    next(error);
  }
};

export const updateWorkspaceController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const { name, timezone, currency } = req.body;

    const workspace = await updateWorkspace(workspaceId, {
      name,
      timezone,
      currency,
    });

    res.status(200).json({
      success: true,
      message: "Workspace updated successfully",
      data: { workspace },
    });
  } catch (error: unknown) {
    next(error);
  }
};
