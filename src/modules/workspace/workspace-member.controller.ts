import type { Request, Response, NextFunction } from "express";
import { listWorkspaceMembers } from "./workspace-member.service.js";
import { AppError } from "../../utils/app-error.js";

export async function listWorkspaceMembersController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { workspaceId } = req.params;

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
