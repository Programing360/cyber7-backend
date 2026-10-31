
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

import { whatsappConfig } from "../config/whatsapp.config.js";
import { recordWebhookVerificationSuccess } from "../whatsapp/meta-platform-config.model.js";

import {
  verifyWhatsAppWebhookSignature,
} from "../services/whatsapp-webhook.service.js";

import {
  processIncomingWhatsAppMessage,
  updateWhatsAppMessageStatus,
} from "../services/whatsapp-message.service.js";

import type { WhatsAppMessageType } from "../whatsapp/message.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";


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
    message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker;

  return mediaPayload?.id;
}

/**
 * Extract media MIME type from an incoming webhook message.
 */
function extractMediaMimeType(message: WebhookMessage): string | undefined {
  const mediaPayload =
    message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker;

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

  if (
    mode === "subscribe" &&
    isValidToken &&
    typeof challenge === "string"
  ) {
    try {
      await recordWebhookVerificationSuccess(req.ip);
    } catch (err) {
      console.error("[Webhook Verification] Failed to persist verification record:", err);
    }
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}


// ---------- POST: Receive WhatsApp webhook events ----------

export async function receiveWhatsAppWebhook(
  req: RawBodyRequest,
  res: Response,
) {
  try {
    // 1. Verify webhook signature.
    const signature = req.headers["x-hub-signature-256"];

    const rawBody = req.rawBody ?? Buffer.alloc(0);

    const isValid = verifyWhatsAppWebhookSignature(
      rawBody,
      typeof signature === "string" ? signature : undefined,
    );

    if (!isValid) {
      // Return 401 for invalid signature — Meta should not retry invalid payloads.
      return res.status(401).json({
        success: false,
        message: "Invalid webhook signature",
      });
    }

    // 2. Validate webhook payload.
    const payload = req.body as WhatsAppWebhookPayload;

    if (payload.object !== "whatsapp_business_account") {
      // Return 200 for unrecognized objects to prevent retry storms.
      return res.sendStatus(200);
    }

    // 3. Process entries and changes.
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") {
          continue;
        }

        const value = change.value;

        const phoneNumberId = value.metadata?.phone_number_id;

        if (!phoneNumberId) {
          continue;
        }

        // 4. Process incoming messages — all types.
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
            // Log but do NOT throw — process remaining messages in the batch.
            console.error(
              `[Webhook] Failed to process message ${message.id}:`,
              messageError instanceof Error ? messageError.message : messageError,
            );
          }
        }

        // 5. Process outgoing message status updates.
        for (const status of value.statuses ?? []) {
          try {
            // Find connected account for status updates.
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
              status.errors?.[0]?.message ??
              status.errors?.[0]?.title;

            await updateWhatsAppMessageStatus({
              whatsappAccountId: account._id.toString(),
              messageId: status.id,
              status: statusMap[status.status],
              timestamp: status.timestamp,
              errorMessage,
            });
          } catch (statusError) {
            // Log but do NOT throw — process remaining status updates.
            console.error(
              `[Webhook] Failed to process status ${status.id}:`,
              statusError instanceof Error ? statusError.message : statusError,
            );
          }
        }
      }
    }

    // 6. Always acknowledge webhook with 200.
    return res.sendStatus(200);
  } catch (error) {
    // Even on unexpected errors, return 200 to prevent Meta retry storms.
    // The webhook has been received; processing failures are internal.
    console.error(
      "[Webhook] Unexpected processing error:",
      error instanceof Error ? error.message : error,
    );

    return res.sendStatus(200);
  }
}
