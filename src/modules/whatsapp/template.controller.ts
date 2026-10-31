import type { Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import {
  listWorkspaceTemplates,
  getWorkspaceTemplateById,
  syncWorkspaceTemplates,
} from "./template.service.js";

export const listTemplatesController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const { search, category, status, page, limit } = req.query;

    const parsedPage = page ? parseInt(page as string, 10) : 1;
    const parsedLimit = limit ? parseInt(limit as string, 10) : 50;

    const result = await listWorkspaceTemplates({
      workspaceId,
      search: search as string | undefined,
      category: category as string | undefined,
      status: status as string | undefined,
      page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    });

    res.status(200).json({
      success: true,
      message: "Templates retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getTemplateByIdController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const templateId = req.params.templateId as string;

    const template = await getWorkspaceTemplateById({
      workspaceId,
      templateId,
    });

    res.status(200).json({
      success: true,
      message: "Template retrieved successfully",
      data: { template },
    });
  } catch (error) {
    next(error);
  }
};

export const syncTemplatesController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.params.workspaceId as string;

    const result = await syncWorkspaceTemplates(workspaceId);

    res.status(200).json({
      success: true,
      message: `Successfully synced ${result.syncedCount} templates from Meta`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
