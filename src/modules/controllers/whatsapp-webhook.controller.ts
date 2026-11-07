import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

import { whatsappConfig } from "../config/whatsapp.config.js";
import { recordWebhookVerificationSuccess } from "../whatsapp/meta-platform-config.model.js";

import { verifyWhatsAppWebhookSignature } from "../services/whatsapp-webhook.service.js";

import {
  processIncomingWhatsAppMessage,
  updateWhatsAppMessageStatus,
} from "../services/whatsapp-message.service.js";

import type { WhatsAppMessageType } from "../whatsapp/message.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import { processWhatsAppCallingWebhook } from "../../services/whatsapp-calling-webhook.service.js";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const statusMap = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
} as const;

/**
 * Map Meta webhook message type string to our internal WhatsAppMessageType.
 */
function mapMessageType(metaType: string): WhatsAppMessageType {
  const typeMap: Record<string, WhatsAppMessageType> = {
    text: "TEXT",
    image: "IMAGE",
    video: "VIDEO",
    audio: "AUDIO",
    document: "DOCUMENT",
    location: "LOCATION",
    interactive: "INTERACTIVE",
    template: "TEMPLATE",
  };

  return typeMap[metaType] ?? "UNKNOWN";
}

/**
 * Extract text content from an incoming webhook message.
 */
function extractTextContent(message: WebhookMessage): string | undefined {
  if (message.type === "text" && message.text?.body) {
    return message.text.body;
  }

  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title
    );
  }

  return undefined;
}

/**
 * Extract media ID from an incoming webhook message.
 */
function extractMediaId(message: WebhookMessage): string | undefined {
  const mediaPayload =
    message.image ??
    message.video ??
    message.audio ??
    message.document ??
    message.sticker;

  return mediaPayload?.id;
}

/**
 * Extract media MIME type from an incoming webhook message.
 */
function extractMediaMimeType(message: WebhookMessage): string | undefined {
  const mediaPayload =
    message.image ??
    message.video ??
    message.audio ??
    message.document ??
    message.sticker;

  return mediaPayload?.mime_type;
}

// ---------- Webhook payload types ----------

interface WebhookMediaPayload {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;

  text?: {
    body: string;
  };

  image?: WebhookMediaPayload;
  video?: WebhookMediaPayload;
  audio?: WebhookMediaPayload;
  document?: WebhookMediaPayload;
  sticker?: WebhookMediaPayload;

  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };

  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };

  contacts?: unknown;
  referral?: unknown;
}

interface WebhookCall {
  id?: string;
  event?: string;
  direction?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  status?: string;
  duration?: number;
  start_time?: string;
  end_time?: string;
  session?: {
    sdp_type?: string;
    sdp?: string;
  };
}

interface WhatsAppWebhookPayload {
  object: string;

  entry?: Array<{
    changes?: Array<{
      field: string;

      value: {
        metadata?: {
          phone_number_id?: string;
        };

        contacts?: Array<{
          profile?: {
            name?: string;
          };

          wa_id?: string;
        }>;

        messages?: WebhookMessage[];

        calls?: WebhookCall[];

        statuses?: Array<{
          id: string;
          status: keyof typeof statusMap;
          timestamp: string;
          recipient_id: string;

          errors?: Array<{
            code: number;
            title: string;
            message?: string;
          }>;
        }>;
      };
    }>;
  }>;
}

function safeCompareTokens(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

// ---------- GET: Verify WhatsApp webhook with Meta ----------

export async function verifyWhatsAppWebhook(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expectedToken = whatsappConfig.webhookVerifyToken;

  const isValidToken =
    typeof token === "string" && safeCompareTokens(token, expectedToken);

  if (mode === "subscribe" && isValidToken && typeof challenge === "string") {
    try {
      await recordWebhookVerificationSuccess(req.ip);
    } catch (err) {
      console.error(
        "[Webhook Verification] Failed to persist verification record:",
        err,
      );
    }

    if (typeof res.type === "function") {
      res.type("text/plain");
    } else if (typeof res.setHeader === "function") {
      res.setHeader("Content-Type", "text/plain");
    }

    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}

// ---------- POST: Internal Webhook Audit Record ----------

export async function recordInternalWebhookAuditController(
  _req: Request,
  res: Response,
) {
  try {
    await recordWebhookVerificationSuccess();

    return res.status(200).json({
      success: true,
      message: "Webhook verification recorded successfully",
    });
  } catch (error) {
    console.error(
      "[Internal Webhook Audit] Failed to record verification:",
      error,
    );

    return res.status(500).json({
      success: false,
      code: "AUDIT_PERSISTENCE_FAILED",
      message: "Failed to persist webhook verification audit",
    });
  }
}

// ---------- POST: Receive WhatsApp webhook events ----------

export async function receiveWhatsAppWebhook(
  req: RawBodyRequest,
  res: Response,
) {
  try {
    // 1. Verify Meta webhook signature.

    const signature = req.headers["x-hub-signature-256"];
    const rawBody = req.rawBody ?? Buffer.alloc(0);

    console.info("[Webhook Signature Debug]", {
      rawBodyCaptured: Buffer.isBuffer(req.rawBody),
      rawBodyLength: rawBody.length,
      signaturePresent: typeof signature === "string",
      signatureFormatValid:
        typeof signature === "string" &&
        /^sha256=[a-fA-F0-9]{64}$/.test(signature),
      appSecretConfigured: Boolean(process.env.META_APP_SECRET?.trim()),
      contentType: req.headers["content-type"],
    });

    const isValid = verifyWhatsAppWebhookSignature(
      rawBody,
      typeof signature === "string" ? signature : undefined,
    );

    if (!isValid) {
      return res.status(401).json({
        success: false,
        code: "INVALID_META_SIGNATURE",
        message: "Invalid webhook signature",
      });
    }

    // 2. Validate webhook payload.
    const payload = req.body as WhatsAppWebhookPayload;

    if (!payload || payload.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    // 3. Process entries and changes.
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;

        // 4. Process WhatsApp Calling webhook events.
        if (change.field === "calls") {
          const phoneNumberId = value.metadata?.phone_number_id;

          if (!phoneNumberId) {
            console.warn("[Calling Webhook] Missing metadata.phone_number_id");
            continue;
          }

          try {
            await processWhatsAppCallingWebhook({
              metadata: {
                phone_number_id: phoneNumberId,
              },
              contacts: value.contacts,
              calls: value.calls,
              // BUG-02 FIX: forward call-progress statuses so processCallStatus()
              // can handle RINGING / ACCEPTED / REJECTED for business-initiated calls.
              statuses: value.statuses,
            });

            console.info(
              `[Calling Webhook] Processed call events for phoneNumberId: ${phoneNumberId}`,
            );
          } catch (callingError) {
            console.error(
              "[Calling Webhook] Failed to process call events:",
              callingError instanceof Error
                ? callingError.message
                : callingError,
            );

            throw callingError;
          }

          continue;
        }

        // Ignore unsupported webhook fields.
        if (change.field !== "messages") {
          continue;
        }

        const phoneNumberId = value.metadata?.phone_number_id;

        if (!phoneNumberId) {
          continue;
        }

        // 5. Process incoming WhatsApp messages.
        for (const message of value.messages ?? []) {
          try {
            const mappedType = mapMessageType(message.type);
            const text = extractTextContent(message);
            const mediaId = extractMediaId(message);
            const mediaMimeType = extractMediaMimeType(message);

            const contactName = value.contacts?.find(
              (contact) => contact.wa_id === message.from,
            )?.profile?.name;

            const result = await processIncomingWhatsAppMessage({
              phoneNumberId,
              contactName,

              message: {
                from: message.from,
                id: message.id,
                timestamp: message.timestamp,
                type: mappedType,
                text,
                mediaId,
                mediaMimeType,
              },
            });

            if (result.accountNotFound) {
              console.warn(
                `[Webhook] No connected account for phoneNumberId: ${phoneNumberId}, skipping message ${message.id}`,
              );
            }

            if (result.duplicate) {
              console.info(
                `[Webhook] Duplicate message ignored: ${message.id}`,
              );
            }
          } catch (messageError) {
            console.error(
              `[Webhook] Failed to process message ${message.id}:`,
              messageError instanceof Error
                ? messageError.message
                : messageError,
            );

            throw messageError;
          }
        }

        // 6. Process outgoing message status updates.
        for (const status of value.statuses ?? []) {
          try {
            const cleanPhoneId = phoneNumberId.trim();

            const account = await WhatsAppAccount.findOne({
              phoneNumberId: cleanPhoneId,
              status: "CONNECTED",
            }).select("_id");

            if (!account) {
              console.warn(
                `[Webhook] No connected account for status update, phoneNumberId: ${cleanPhoneId}`,
              );
              continue;
            }

            const errorMessage =
              status.errors?.[0]?.message ?? status.errors?.[0]?.title;

            await updateWhatsAppMessageStatus({
              whatsappAccountId: account._id.toString(),
              messageId: status.id,
              status: statusMap[status.status],
              timestamp: status.timestamp,
              errorMessage,
            });
          } catch (statusError) {
            console.error(
              `[Webhook] Failed to process status ${status.id}:`,
              statusError instanceof Error ? statusError.message : statusError,
            );

            throw statusError;
          }
        }
      }
    }

    // 7. Acknowledge only after processing completes.
    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "[Webhook] Unexpected processing error:",
      error instanceof Error ? error.message : error,
    );

    // Meta can retry failed webhook deliveries.
    return res.status(500).json({
      success: false,
      message: "Webhook processing error",
    });
  }
}
