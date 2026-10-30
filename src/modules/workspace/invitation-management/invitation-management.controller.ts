import type { Request, Response, NextFunction } from "express";



import {
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from "./invitation-management.service.js";
import { AppError } from "../../../utils/app-error.js";

export async function listWorkspaceInvitationsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.params.workspaceId as string;

    if (!workspaceId) {
      throw new AppError("Workspace ID is required", 400);
    }

    const rawPage = req.query.page ?? "1";
    const rawLimit = req.query.limit ?? "10";

    if (
      typeof rawPage !== "string" ||
      typeof rawLimit !== "string" ||
      !/^\d+$/.test(rawPage) ||
      !/^\d+$/.test(rawLimit)
    ) {
      throw new AppError("Invalid pagination parameters", 400);
    }

    const page = Number(rawPage);
    const limit = Number(rawLimit);

    if (
      !Number.isSafeInteger(page) ||
      !Number.isSafeInteger(limit) ||
      page < 1 ||
      limit < 1 ||
      limit > 100
    ) {
      throw new AppError("Invalid pagination values", 400);
    }

    const result = await listWorkspaceInvitations({
      workspaceId,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function revokeWorkspaceInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.params.workspaceId as string;
    const invitationId = req.params.invitationId as string;

    if (!workspaceId || !invitationId) {
      throw new AppError("Workspace ID and invitation ID are required", 400);
    }

    const result = await revokeWorkspaceInvitation(workspaceId, invitationId);

    res.status(200).json({
      success: true,
      message: "Invitation revoked successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
