import type { Request, Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import {
  connectWhatsAppAccount,
  listWhatsAppAccounts,
  getWhatsAppAccount,
  updateWhatsAppAccountStatus,
  disconnectWhatsAppAccount,
  getWhatsAppAccounts,
  getWhatsAppAccountById,
  getWhatsAppConfigStatus,
} from "./whatsapp.service.js";
import {
  connectWhatsAppSchema,
  sendWhatsAppTextMessageSchema,
  sendWhatsAppTemplateMessageSchema,
  updateWhatsAppStatusSchema,
} from "./whatsapp.validation.js";
import { AppError } from "../../utils/app-error.js";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  getWhatsAppMediaStream,
  sendWhatsAppMediaMessage,
} from "../services/whatsapp-message.service.js";
import { recordWebhookVerificationSuccess } from "./meta-platform-config.model.js";

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

export async function verifyWebhookController(
  req: WorkspaceRequest,
  res: Response,
) {
  const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

  const mode = req.query["hub.mode"] as string | undefined;
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    const clientIp =
      (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;

    // ✅ ডাটাবেজে ভেরিফিকেশন সফল হিসেবে রেকর্ড করুন
    await recordWebhookVerificationSuccess(clientIp);

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
        // if (!change.value?.messages && !change.value?.statuses) {
        //   await markWebhookVerified(phoneNumberId);
        // }

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

    // If templateId is provided, route to template sending
    if (req.body && typeof req.body === "object" && "templateId" in req.body) {
      const templateValidation = sendWhatsAppTemplateMessageSchema.safeParse(
        req.body,
      );
      if (!templateValidation.success) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: templateValidation.error.flatten(),
        });
      }

      const { conversationId, templateId, language, components } =
        templateValidation.data;

      const message = await sendWhatsAppTemplateMessage({
        workspaceId,
        conversationId,
        senderId: req.user.id,
        templateId,
        language,
        components,
      });

      return res.status(201).json({
        success: true,
        message: "WhatsApp template message sent successfully",
        data: message,
      });
    }

    // Otherwise, validate free-form text request body
    const validationResult = sendWhatsAppTextMessageSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationResult.error.flatten(),
      });
    }

    const { conversationId, text } = validationResult.data;

    // Send WhatsApp text message.
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

export async function sendWhatsAppTemplateMessageController(
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

    const templateValidation = sendWhatsAppTemplateMessageSchema.safeParse(
      req.body,
    );
    if (!templateValidation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: templateValidation.error.flatten(),
      });
    }

    const { conversationId, templateId, language, components } =
      templateValidation.data;

    const message = await sendWhatsAppTemplateMessage({
      workspaceId,
      conversationId,
      senderId: req.user.id,
      templateId,
      language,
      components,
    });

    return res.status(201).json({
      success: true,
      message: "WhatsApp template message sent successfully",
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
    const workspaceId = req.workspace?.id ?? (req.params.workspaceId as string);

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

/**
 * GET /api/workspaces/:workspaceId/whatsapp/media/:mediaId
 * or /api/whatsapp/:workspaceId/media/:mediaId
 *
 * Implements Issue 3: Authenticated Media Streaming Proxy
 */
export async function getWhatsAppMediaStreamController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId =
      req.workspace?.id ??
      (req.params.workspaceId as string | undefined) ??
      (req.query.workspaceId as string | undefined) ??
      (req.headers["x-workspace-id"] as string | undefined);
    const mediaId = req.params.mediaId as string;

    if (!mediaId) {
      throw new AppError("Media ID is required", 400);
    }

    const { stream, contentType, contentLength } = await getWhatsAppMediaStream({
      workspaceId,
      mediaId,
    });

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");

    // Guard against client disconnecting or stream piping failures
    (stream as any).on("error", (err: any) => {
      if (!res.headersSent) {
        next(err);
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      if ((stream as any).destroy) {
        (stream as any).destroy();
      }
    });

    (stream as NodeJS.ReadableStream).pipe(res);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/workspaces/:workspaceId/whatsapp/messages/media
 * or /api/whatsapp/:workspaceId/messages/media
 *
 * Implements Issue 3: Outbound Image / Video Message Sending
 */
export async function sendWhatsAppMediaMessageController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const workspaceId = req.workspace?.id ?? (req.params.workspaceId as string);

    if (!req.user?.id) {
      throw new AppError("Unauthorized", 401);
    }
    if (!workspaceId) {
      throw new AppError("Workspace ID is required", 400);
    }

    const {
      conversationId,
      type,
      fileBase64,
      mediaUrl,
      filename,
      mimeType,
      caption,
    } = req.body || {};

    if (!conversationId) {
      throw new AppError("Conversation ID is required", 400);
    }
    if (!type || (type !== "IMAGE" && type !== "VIDEO")) {
      throw new AppError("Valid media type (IMAGE or VIDEO) is required", 400);
    }
    if (!fileBase64 && !mediaUrl) {
      throw new AppError("Either fileBase64 or mediaUrl must be provided", 400);
    }

    const message = await sendWhatsAppMediaMessage({
      workspaceId,
      conversationId,
      senderId: req.user.id,
      type,
      fileBase64,
      mediaUrl,
      filename,
      mimeType,
      caption,
    });

    return res.status(201).json({
      success: true,
      message: "Media message sent successfully",
      data: message,
    });
  } catch (error) {
    next(error);
  }
}
