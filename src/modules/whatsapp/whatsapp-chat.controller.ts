import type { Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import { AppError } from "../../utils/app-error.js";
import {
  listWorkspaceContacts,
  getWorkspaceContactById,
  createOrUpsertWorkspaceContact,
  updateWorkspaceContact,
  deleteWorkspaceContact,
  listWorkspaceConversations,
  getWorkspaceConversationById,
  updateWorkspaceConversationStatus,
  listWorkspaceConversationMessages,
} from "./whatsapp-chat.service.js";
import {
  createContactSchema,
  updateContactSchema,
  updateConversationStatusSchema,
} from "./whatsapp.validation.js";

// Helper to parse pagination params
function parsePagination(
  rawPage: unknown,
  rawLimit: unknown,
  defaultLimit = 20,
  maxLimit = 100,
) {
  const pageStr = typeof rawPage === "string" ? rawPage : "1";
  const limitStr =
    typeof rawLimit === "string" ? rawLimit : String(defaultLimit);

  if (!/^\d+$/.test(pageStr) || !/^\d+$/.test(limitStr)) {
    throw new AppError("Invalid pagination parameters", 400);
  }

  const page = Number(pageStr);
  const limit = Number(limitStr);

  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(limit) ||
    page < 1 ||
    limit < 1 ||
    limit > maxLimit
  ) {
    throw new AppError(
      `Page must be positive and limit must be between 1 and ${maxLimit}`,
      400,
    );
  }

  return { page, limit };
}

// ─── Contacts Controllers ────────────────────────────────────────────────────

/**
 * GET /:workspaceId/contacts
 */
export async function listContactsController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const { page, limit } = parsePagination(req.query.page, req.query.limit, 20);
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined;

    const result = await listWorkspaceContacts({
      workspaceId,
      page,
      limit,
      search,
    });

    res.status(200).json({
      success: true,
      message: "Contacts retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /:workspaceId/contacts/:contactId
 */
export async function getContactByIdController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const contactId = req.params.contactId as string;

    const contact = await getWorkspaceContactById({
      workspaceId,
      contactId,
    });

    res.status(200).json({
      success: true,
      message: "Contact retrieved successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /:workspaceId/contacts
 */
export async function createContactController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;

    const parsed = createContactSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues[0]?.message ?? "Invalid contact data",
        400,
      );
    }

    const contact = await createOrUpsertWorkspaceContact({
      workspaceId,
      input: parsed.data,
    });

    res.status(201).json({
      success: true,
      message: "Contact saved successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /:workspaceId/contacts/:contactId
 */
export async function updateContactController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const contactId = req.params.contactId as string;

    const parsed = updateContactSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues[0]?.message ?? "Invalid contact data",
        400,
      );
    }

    const contact = await updateWorkspaceContact({
      workspaceId,
      contactId,
      input: parsed.data,
    });

    res.status(200).json({
      success: true,
      message: "Contact updated successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /:workspaceId/contacts/:contactId
 */
export async function deleteContactController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const contactId = req.params.contactId as string;

    const result = await deleteWorkspaceContact({
      workspaceId,
      contactId,
    });

    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    next(error);
  }
}

// ─── Conversations Controllers ───────────────────────────────────────────────

/**
 * GET /:workspaceId/conversations
 */
export async function listConversationsController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const { page, limit } = parsePagination(req.query.page, req.query.limit, 20);
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined;

    const result = await listWorkspaceConversations({
      workspaceId,
      page,
      limit,
      status,
      search,
    });

    res.status(200).json({
      success: true,
      message: "Conversations retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /:workspaceId/conversations/:conversationId
 */
export async function getConversationByIdController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const conversationId = req.params.conversationId as string;

    const conversation = await getWorkspaceConversationById({
      workspaceId,
      conversationId,
    });

    res.status(200).json({
      success: true,
      message: "Conversation retrieved successfully",
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /:workspaceId/conversations/:conversationId/status
 */
export async function updateConversationStatusController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const conversationId = req.params.conversationId as string;

    const parsed = updateConversationStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues[0]?.message ?? "Invalid status data",
        400,
      );
    }

    const conversation = await updateWorkspaceConversationStatus({
      workspaceId,
      conversationId,
      status: parsed.data.status,
    });

    res.status(200).json({
      success: true,
      message: "Conversation status updated successfully",
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

// ─── Messages History Controller ─────────────────────────────────────────────

/**
 * GET /:workspaceId/conversations/:conversationId/messages
 */
export async function listConversationMessagesController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const conversationId = req.params.conversationId as string;
    const { page, limit } = parsePagination(
      req.query.page,
      req.query.limit,
      50,
      100,
    );

    const result = await listWorkspaceConversationMessages({
      workspaceId,
      conversationId,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      message: "Messages retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
