import type { Request, Response, NextFunction } from "express";
import {
  listWorkspaceMembers,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
  updateWorkspaceMemberStatus,
} from "./workspace-member.service.js";
import { AppError } from "../../utils/app-error.js";
import {
  updateMemberRoleSchema,
  updateMemberStatusSchema,
} from "./workspace-member.validation.js";
import { getRouteParam } from "../../utils/get-route-param.js";
import type { AuthenticatedRequest } from "../../middlewares/authenticate.js";

export async function listWorkspaceMembersController(
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
      throw new AppError(
        "Page must be positive and limit must be between 1 and 100",
        400,
      );
    }

    const result = await listWorkspaceMembers({
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

export async function updateMemberRoleController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = getRouteParam(req, "workspaceId");
    const memberId = getRouteParam(req, "memberId");

    if (!workspaceId || !memberId) {
      return res.status(400).json({
        success: false,
        message: "Workspace ID and member ID are required",
      });
    }

    const validation = updateMemberRoleSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid request data",
        errors: validation.error.issues,
      });
    }

    if (!req.user?.id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const result = await updateWorkspaceMemberRole({
      workspaceId,
      memberId,
      role: validation.data.role,
      requesterId: req.user.id,
    });

    return res.status(200).json({
      success: true,
      message: "Member role updated successfully",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

export const updateMemberStatusController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = getRouteParam(req, "workspaceId");
    const memberId = getRouteParam(req, "memberId");

    if (!workspaceId || !memberId) {
      throw new AppError("Workspace ID and Member ID are required", 400);
    }

    if (!req.user?.id) {
      throw new AppError("Unauthorized", 401);
    }

    const validation = updateMemberStatusSchema.safeParse(req.body);

    if (!validation.success) {
      throw new AppError("Invalid member status", 400);
    }

    const result = await updateWorkspaceMemberStatus({
      workspaceId,
      memberId,
      status: validation.data.status,
      requesterId: req.user.id,
    });

    res.status(200).json({
      success: true,
      message: "Member status updated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const removeWorkspaceMemberController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = getRouteParam(req, "workspaceId");
    const memberId = getRouteParam(req, "memberId");

    if (!workspaceId || !memberId) {
      throw new AppError("Workspace ID and Member ID are required", 400);
    }

    if (!req.user?.id) {
      throw new AppError("Unauthorized", 401);
    }

    const result = await removeWorkspaceMember({
      workspaceId,
      memberId,
      requesterId: req.user.id,
    });

    res.status(200).json({
      success: true,
      message: "Workspace member removed successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
