import type { Request, Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import {
  connectWhatsAppAccount,
  listWhatsAppAccounts,
  getWhatsAppAccount,
  updateWhatsAppAccountStatus,
  disconnectWhatsAppAccount,
  markWebhookVerified,
  getWhatsAppAccounts,
  getWhatsAppAccountById,
  getWhatsAppConfigStatus,
} from "./whatsapp.service.js";
import {
  connectWhatsAppSchema,
  sendWhatsAppTextMessageSchema,
  updateWhatsAppStatusSchema,
} from "./whatsapp.validation.js";
import { AppError } from "../../utils/app-error.js";
import { sendWhatsAppTextMessage } from "../services/whatsapp-message.service.js";

// ─── POST /:workspaceId/accounts ─────────────────────────────────────────────

export async function connectWhatsAppController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace!.id;

    const parsedInput = connectWhatsAppSchema.safeParse(req.body);

    if (!parsedInput.success) {
      throw new AppError(
        parsedInput.error.issues[0]?.message ?? "Invalid request data",
        400,
      );
    }

    const account = await connectWhatsAppAccount({
      workspaceId,
      input: parsedInput.data,
    });

    res.status(201).json({
      success: true,
      message: "WhatsApp account registered successfully",
      data: account,
    });
  } catch (error) {
    next(error);
  }
}

// ─── GET /:workspaceId/accounts ───────────────────────────────────────────────

export async function listWhatsAppAccountsController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace!.id;

    const accounts = await listWhatsAppAccounts(workspaceId);

    res.status(200).json({
      success: true,
      data: accounts,
    });
  } catch (error) {
    next(error);
  }
}

// ─── GET /:workspaceId/accounts/:accountId ────────────────────────────────────

export async function getWhatsAppAccountController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace!.id;
    const accountId = req.params.accountId as string;

    const account = await getWhatsAppAccount({ workspaceId, accountId });

    res.status(200).json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
}

// ─── PATCH /:workspaceId/accounts/:accountId/status ──────────────────────────

export async function updateWhatsAppStatusController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace!.id;
    const accountId = req.params.accountId as string;

    const parsedInput = updateWhatsAppStatusSchema.safeParse(req.body);

    if (!parsedInput.success) {
      throw new AppError(
        parsedInput.error.issues[0]?.message ?? "Invalid status value",
        400,
      );
    }

    const account = await updateWhatsAppAccountStatus({
      workspaceId,
      accountId,
      input: parsedInput.data,
    });

    res.status(200).json({
      success: true,
      message: "WhatsApp account status updated",
      data: account,
    });
  } catch (error) {
    next(error);
  }
}

// ─── DELETE /:workspaceId/accounts/:accountId ─────────────────────────────────

export async function disconnectWhatsAppController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace!.id;
    const accountId = req.params.accountId as string;

    const result = await disconnectWhatsAppAccount({ workspaceId, accountId });

    res.status(200).json({
      success: true,
      message: "WhatsApp account disconnected successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

// ─── GET /webhook (Meta verification challenge) ───────────────────────────────

export function verifyWebhookController(req: WorkspaceRequest, res: Response) {
  const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  const mode = req.query["hub.mode"] as string | undefined;
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({
      success: false,
      message: "Webhook verification failed",
    });
  }
}

// ─── POST /webhook (Incoming messages) ───────────────────────────────────────

export async function handleWebhookController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const body = req.body as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          value?: {
            metadata?: { phone_number_id?: string };
            messages?: unknown[];
            statuses?: unknown[];
          };
        }>;
      }>;
    };

    // Acknowledge immediately — Meta requires a fast 200 response.
    res.status(200).json({ success: true });

    if (body.object !== "whatsapp_business_account") return;

    const entries = body.entry ?? [];

    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;

        if (!phoneNumberId) continue;

        // Mark account as connected once we receive the first real event.
        if (!change.value?.messages && !change.value?.statuses) {
          await markWebhookVerified(phoneNumberId);
        }

        // TODO: route messages / status updates to conversation handlers.
      }
    }
  } catch (error) {
    next(error);
  }
}

export async function getWhatsAppAccountsController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;

    if (!workspaceId) {
      throw new AppError("Workspace ID is required", 400);
    }

    const accounts = await getWhatsAppAccounts(workspaceId);

    res.status(200).json({
      success: true,
      message: "WhatsApp accounts retrieved successfully",
      data: accounts,
    });
  } catch (error) {
    next(error);
  }
}

export async function getWhatsAppAccountByIdController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = (req.workspace?.id ?? req.params.workspaceId) as string;
    const accountId = req.params.accountId as string;

    if (!workspaceId || !accountId) {
      throw new AppError("Workspace ID and Account ID are required", 400);
    }

    const account = await getWhatsAppAccountById(workspaceId, accountId);

    res.status(200).json({
      success: true,
      message: "WhatsApp account retrieved successfully",
      data: account,
    });
  } catch (error) {
    next(error);
  }
}

export async function sendWhatsAppMessage(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace?.id ?? (req.params.workspaceId as string);

    if (!req.user?.id) {
      throw new AppError("Unauthorized", 401);
    }

    if (!workspaceId || typeof workspaceId !== "string") {
      throw new AppError("Workspace ID is required", 400);
    }

    // Validate request body.
    const validationResult = sendWhatsAppTextMessageSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationResult.error.flatten(),
      });
    }

    const { conversationId, text } = validationResult.data;

    // Send WhatsApp message.
    const message = await sendWhatsAppTextMessage({
      workspaceId,
      conversationId,
      senderId: req.user.id,
      text,
    });

    return res.status(201).json({
      success: true,
      message: "WhatsApp message sent successfully",
      data: message,
    });
  } catch (error) {
    next(error);
  }
}

// ─── GET /:workspaceId/config-status ─────────────────────────────────────────

export async function getWhatsAppConfigStatusController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId =
      req.workspace?.id ?? (req.params.workspaceId as string);

    if (!workspaceId || typeof workspaceId !== "string") {
      throw new AppError("Workspace ID is required", 400);
    }

    const configStatus = await getWhatsAppConfigStatus(workspaceId);

    return res.status(200).json({
      success: true,
      data: configStatus,
    });
  } catch (error) {
    next(error);
  }
}
