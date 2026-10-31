import type { Response, NextFunction } from "express";

import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import { AppError } from "../../utils/app-error.js";
import {
  cancelCampaign,
  createCampaign,
  deleteDraftCampaign,
  getCampaignById,
  getCampaignRecipients,
  getCampaigns,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
  updateDraftCampaign,
} from "./campaign.service.js";
import {
  campaignListQuerySchema,
  campaignRecipientListQuerySchema,
  createCampaignSchema,
  scheduleCampaignSchema,
  updateDraftCampaignSchema,
} from "./campaign.validation.js";

export const CAMPAIGN_EXECUTION_NOTICE =
  "Campaign execution is not available yet. No messages will be sent until the campaign execution engine is implemented.";

function firstIssueMessage(error: {
  issues: Array<{ message: string }>;
}): string {
  return error.issues[0]?.message ?? "Invalid request data";
}

function getWorkspaceId(req: WorkspaceRequest): string {
  return (req.workspace?.id ?? req.params.workspaceId) as string;
}

function getCampaignId(req: WorkspaceRequest): string {
  return req.params.campaignId as string;
}

function parseCampaignListQuery(query: WorkspaceRequest["query"]) {
  const parsed = campaignListQuerySchema.safeParse({
    page: query.page,
    limit: query.limit,
    search: typeof query.search === "string" ? query.search : undefined,
    status: typeof query.status === "string" ? query.status : undefined,
  });

  if (!parsed.success) {
    throw new AppError(firstIssueMessage(parsed.error), 400);
  }

  return parsed.data;
}

function parseRecipientListQuery(query: WorkspaceRequest["query"]) {
  const parsed = campaignRecipientListQuerySchema.safeParse({
    page: query.page,
    limit: query.limit,
    status: typeof query.status === "string" ? query.status : undefined,
  });

  if (!parsed.success) {
    throw new AppError(firstIssueMessage(parsed.error), 400);
  }

  return parsed.data;
}

export async function createCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = createCampaignSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(firstIssueMessage(parsed.error), 400);
    }

    if (!req.user) {
      throw new AppError("Authentication is required", 401);
    }

    const result = await createCampaign({
      workspaceId: getWorkspaceId(req),
      createdBy: req.user.id,
      input: parsed.data,
    });

    res.status(201).json({
      success: true,
      message: "Campaign created as a draft",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function listCampaignsController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await getCampaigns({
      workspaceId: getWorkspaceId(req),
      query: parseCampaignListQuery(req.query),
    });

    res.status(200).json({
      success: true,
      message: "Campaigns retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function getCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const campaign = await getCampaignById({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
    });

    res.status(200).json({
      success: true,
      message: "Campaign retrieved successfully",
      data: campaign,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = updateDraftCampaignSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(firstIssueMessage(parsed.error), 400);
    }

    const result = await updateDraftCampaign({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
      input: parsed.data,
    });

    res.status(200).json({
      success: true,
      message: "Draft campaign updated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await deleteDraftCampaign({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
    });

    res.status(200).json({
      success: true,
      message: "Draft campaign deleted successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function scheduleCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = scheduleCampaignSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(firstIssueMessage(parsed.error), 400);
    }

    const result = await scheduleCampaign({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
      input: parsed.data,
    });

    res.status(200).json({
      success: true,
      message: `Campaign scheduled successfully. ${CAMPAIGN_EXECUTION_NOTICE}`,
      data: {
        ...result,
        executionNotice: CAMPAIGN_EXECUTION_NOTICE,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const campaign = await cancelCampaign({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
    });

    res.status(200).json({
      success: true,
      message: "Campaign cancelled successfully",
      data: campaign,
    });
  } catch (error) {
    next(error);
  }
}

export async function pauseCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const campaign = await pauseCampaign({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
    });

    res.status(200).json({
      success: true,
      message: "Campaign paused successfully",
      data: campaign,
    });
  } catch (error) {
    next(error);
  }
}

export async function resumeCampaignController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const campaign = await resumeCampaign({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
    });

    res.status(200).json({
      success: true,
      message: `Campaign resumed successfully. ${CAMPAIGN_EXECUTION_NOTICE}`,
      data: {
        campaign,
        executionNotice: CAMPAIGN_EXECUTION_NOTICE,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function listCampaignRecipientsController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await getCampaignRecipients({
      workspaceId: getWorkspaceId(req),
      campaignId: getCampaignId(req),
      query: parseRecipientListQuery(req.query),
    });

    res.status(200).json({
      success: true,
      message: "Campaign recipients retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
