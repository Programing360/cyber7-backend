import { Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import WhatsAppConversation, {
  CUSTOMER_SERVICE_WINDOW_MS,
  getCustomerServiceWindowExpiry,
  isCustomerServiceWindowOpen,
} from "../whatsapp/conversation.model.js";
import WhatsAppMessage, {
  WhatsAppMessageStatus,
  WhatsAppMessageType,
} from "../whatsapp/message.model.js";
import WhatsAppTemplate from "../whatsapp/template.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import Workspace from "../workspace/workspace.model.js";
import { makeWorkspaceWhatsAppRequest } from "./whatsapp-api.service.js";

export { CUSTOMER_SERVICE_WINDOW_MS, isCustomerServiceWindowOpen, getCustomerServiceWindowExpiry };

export const STATUS_RANK: Record<WhatsAppMessageStatus, number> = {
  RECEIVED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 4,
};

export interface IncomingParsedWhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: WhatsAppMessageType;
  text?: string;
  mediaId?: string;
  mediaMimeType?: string;
}

export interface ProcessIncomingMessageParams {
  phoneNumberId: string;
  contactName?: string;
  message: IncomingParsedWhatsAppMessage;
}

export async function processIncomingWhatsAppMessage({
  phoneNumberId,
  contactName,
  message,
}: ProcessIncomingMessageParams) {
  // 1. Find connected WhatsApp account
  const cleanPhoneId = phoneNumberId.trim();
  const account = await WhatsAppAccount.findOne({
    phoneNumberId: cleanPhoneId,
    status: "CONNECTED",
  });

  if (!account) {
    console.warn(
      `[WhatsApp Inbound] Account not found or disconnected for phoneNumberId: ${cleanPhoneId}`,
    );
    return {
      accountNotFound: true,
      duplicate: false,
    };
  }

  // 1b. Verify workspace association and active status
  const workspace = await Workspace.findById(account.workspaceId);
  if (!workspace || workspace.status === "SUSPENDED") {
    console.warn(
      `[WhatsApp Inbound] Workspace ${account.workspaceId} not found or suspended for account ${account._id}`,
    );
    return {
      accountNotFound: true,
      duplicate: false,
    };
  }

  // 2. Check duplicate message
  const existingMessage = await WhatsAppMessage.findOne({
    whatsappAccountId: account._id,
    waMessageId: message.id,
  });

  if (existingMessage) {
    return {
      duplicate: true,
      messageId: existingMessage._id,
    };
  }

  // Parse incoming timestamp safely and clamp future timestamps to prevent window extension
  const parsedSeconds = Number(message.timestamp);
  const now = Date.now();
  const rawMs =
    !Number.isNaN(parsedSeconds) && parsedSeconds > 0
      ? parsedSeconds * 1000
      : now;
  const incomingDate = new Date(Math.min(rawMs, now));

  // Determine opt-out / opt-in keywords with punctuation and whitespace normalization
  const rawText = (message.text || "").trim();
  // Strip trailing punctuation common in mobile messaging (. , ! ? ; : and Bengali Dari ।)
  const cleanedText = rawText.replace(/[.,!?;:\u0964]+$/, "").trim();
  const isStopKeyword = /^(stop|unsubscribe|cancel|optout|opt-out|quit)$/i.test(cleanedText);
  const isStartKeyword = /^(start|unstop)$/i.test(cleanedText);

  // 3. Find or create contact with opt-out / opt-in tracking
  const contactUpdate: Record<string, unknown> = {
    phoneNumber: message.from,
    ...(contactName ? { profileName: contactName } : {}),
  };

  const contactSetOnInsert: Record<string, unknown> = {};
  const contactUnset: Record<string, 1> = {};

  if (isStopKeyword) {
    contactUpdate.isOptedOut = true;
    contactUpdate.optOutTimestamp = incomingDate;
    contactUpdate.optOutSource = "STOP_MESSAGE";
  } else if (isStartKeyword) {
    // Record conversational opt-in audit trail
    // NOTE: START/UNSTOP alone does NOT automatically grant marketing consent (isOptedOut is preserved)
    contactUpdate.optInTimestamp = incomingDate;
    contactUpdate.optInSource = "START_MESSAGE";
  } else {
    contactSetOnInsert.isOptedOut = false;
  }

  const contact = await WhatsAppContact.findOneAndUpdate(
    {
      workspaceId: account.workspaceId,
      waId: message.from,
    },
    {
      $set: contactUpdate,
      ...(Object.keys(contactSetOnInsert).length > 0
        ? { $setOnInsert: contactSetOnInsert }
        : {}),
      ...(Object.keys(contactUnset).length > 0 ? { $unset: contactUnset } : {}),
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  // 4. Find or create conversation — updating 24-hour customer service window timestamp
  const conversationStatus = isStopKeyword ? "CLOSED" : "OPEN";

  const conversation = await WhatsAppConversation.findOneAndUpdate(
    {
      workspaceId: account.workspaceId,
      whatsappAccountId: account._id,
      contactId: contact._id,
    },
    {
      $set: {
        status: conversationStatus,
        lastMessageAt: incomingDate,
        lastCustomerMessageAt: incomingDate,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  // 5. Save incoming message
  try {
    const savedMessage = await WhatsAppMessage.create({
      workspaceId: account.workspaceId,
      conversationId: conversation._id,
      contactId: contact._id,
      whatsappAccountId: account._id,
      waMessageId: message.id,
      direction: "INBOUND",
      type: message.type || "TEXT",
      status: "RECEIVED",
      text: message.text || "",
      mediaId: message.mediaId,
      mediaMimeType: message.mediaMimeType,
      timestamp: incomingDate,
    });

    return {
      duplicate: false,
      contact,
      conversation,
      message: savedMessage,
    };
  } catch (error) {
    // Meta may retry the same webhook event concurrently.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: number }).code === 11000
    ) {
      const duplicateMessage = await WhatsAppMessage.findOne({
        whatsappAccountId: account._id,
        waMessageId: message.id,
      });

      return {
        duplicate: true,
        messageId: duplicateMessage?._id,
      };
    }

    throw error;
  }
}

export interface UpdateWhatsAppMessageStatusParams {
  whatsappAccountId: string;
  messageId: string;
  status: WhatsAppMessageStatus;
  timestamp: string;
  errorMessage?: string;
}

/**
 * Updates message status according to strict status progression and timestamp rules.
 *
 * Rules:
 * 1. FAILED messages are terminal and cannot be overwritten by older or intermediate events.
 * 2. Status rank hierarchy (RECEIVED < SENT < DELIVERED < READ < FAILED) must be enforced.
 *    READ can never regress to DELIVERED or SENT.
 *    DELIVERED can never regress to SENT.
 * 3. Equal-rank status updates are rejected if incoming timestamp is older than recorded.
 * 4. Local millisecond timestamps at creation time do not block early Meta status events.
 */
export async function updateWhatsAppMessageStatus({
  whatsappAccountId,
  messageId,
  status,
  timestamp,
  errorMessage,
}: UpdateWhatsAppMessageStatusParams) {
  const incomingTimestamp = new Date(Number(timestamp) * 1000);

  if (Number.isNaN(incomingTimestamp.getTime())) {
    throw new AppError("Invalid WhatsApp status timestamp", 400);
  }

  const message = await WhatsAppMessage.findOne({
    whatsappAccountId,
    waMessageId: messageId,
    direction: "OUTBOUND",
  });

  if (!message) {
    console.warn("[WhatsApp Status] Message not found for status update:", messageId);
    return null;
  }

  const currentRank = STATUS_RANK[message.status] ?? 0;
  const newRank = STATUS_RANK[status] ?? 0;

  // Rule 1: A FAILED message is in a terminal state and cannot be overwritten by other statuses
  if (message.status === "FAILED" && status !== "FAILED") {
    return message;
  }

  // Rule 2: Enforce status precedence. Never allow a lower-rank status to overwrite a higher-rank status
  if (newRank < currentRank) {
    return message;
  }

  // Rule 3: If status rank is equal, only update if incoming timestamp is newer or equal
  if (newRank === currentRank) {
    if (message.statusUpdatedAt && incomingTimestamp < message.statusUpdatedAt) {
      return message;
    }
  }

  // Rule 4: Update status and official Meta timestamp
  message.status = status;
  message.statusUpdatedAt = incomingTimestamp;

  if (errorMessage) {
    message.errorMessage = errorMessage;
  }

  await message.save();
  return message;
}

export interface SendWhatsAppTextMessageParams {
  workspaceId: string;
  conversationId: string;
  senderId: string;
  text: string;
}

export async function sendWhatsAppTextMessage({
  workspaceId,
  conversationId,
  senderId,
  text,
}: SendWhatsAppTextMessageParams) {
  // 1. Find conversation inside workspace.
  const conversation = await WhatsAppConversation.findOne({
    _id: conversationId,
    workspaceId,
  });

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  if (conversation.status === "CLOSED") {
    throw new AppError("Conversation is closed", 400);
  }

  // 2. Find contact and verify opt-out status.
  const contact = await WhatsAppContact.findOne({
    _id: conversation.contactId,
    workspaceId,
  });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  if (contact.isOptedOut) {
    throw new AppError(
      "This contact has opted out of WhatsApp messages.",
      422,
      "CONTACT_OPTED_OUT",
    );
  }

  // 3. Server-side enforcement of 24-hour Customer Service Window
  if (!isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt)) {
    throw new AppError(
      "The 24-hour customer service window has expired. You can only send approved template messages outside this window.",
      422,
      "CUSTOMER_SERVICE_WINDOW_EXPIRED",
    );
  }

  // 4. Find connected WhatsApp account.
  const account = await WhatsAppAccount.findOne({
    _id: conversation.whatsappAccountId,
    workspaceId,
    status: "CONNECTED",
  });

  if (!account) {
    throw new AppError("WhatsApp account not connected", 404);
  }

  // 5. Send message through Meta WhatsApp Cloud API.
  const apiResponse = await makeWorkspaceWhatsAppRequest(
    workspaceId,
    account.phoneNumberId,
    "messages",
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: contact.waId,
      type: "text",
      text: {
        preview_url: false,
        body: text,
      },
    },
  );

  // 6. Extract Meta message ID.
  const messages = apiResponse.messages as
    | Array<{ id?: string }>
    | undefined;

  const waMessageId = messages?.[0]?.id;

  if (!waMessageId) {
    throw new AppError(
      "WhatsApp API did not return a message ID",
      502,
    );
  }

  // 7. Save outgoing message.
  const savedMessage = await WhatsAppMessage.create({
    workspaceId,
    conversationId: conversation._id,
    contactId: contact._id,
    whatsappAccountId: account._id,
    waMessageId,
    direction: "OUTBOUND",
    type: "TEXT",
    status: "SENT",
    text,
    senderId,
    timestamp: new Date(),
    statusUpdatedAt: undefined,
  });

  // 8. Update conversation activity.
  conversation.lastMessageAt = savedMessage.timestamp;
  await conversation.save();

  return savedMessage;
}

export interface SendWhatsAppTemplateMessageParams {
  workspaceId: string;
  conversationId: string;
  senderId: string;
  templateId: string;
  language?: string;
  components?: Array<{
    type: "header" | "body" | "button";
    sub_type?: string;
    index?: number;
    parameters: Array<Record<string, unknown>>;
  }>;
}

export async function sendWhatsAppTemplateMessage({
  workspaceId,
  conversationId,
  senderId,
  templateId,
  language,
  components,
}: SendWhatsAppTemplateMessageParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }
  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError("Invalid conversation ID", 400);
  }
  if (!Types.ObjectId.isValid(templateId)) {
    throw new AppError("Invalid template ID", 400);
  }

  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const conversationObjectId = new Types.ObjectId(conversationId);
  const templateObjectId = new Types.ObjectId(templateId);

  // 1. Find conversation inside workspace.
  const conversation = await WhatsAppConversation.findOne({
    _id: conversationObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  // 2. Find contact and verify opt-out status.
  const contact = await WhatsAppContact.findOne({
    _id: conversation.contactId,
    workspaceId: workspaceObjectId,
  });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  if (contact.isOptedOut) {
    throw new AppError(
      "This contact has opted out of WhatsApp messages.",
      422,
      "CONTACT_OPTED_OUT",
    );
  }

  // 3. Find connected WhatsApp account.
  const account = await WhatsAppAccount.findOne({
    _id: conversation.whatsappAccountId,
    workspaceId: workspaceObjectId,
    status: "CONNECTED",
  });

  if (!account) {
    throw new AppError("WhatsApp account not connected", 404);
  }

  // 4. Load approved template belonging to this workspace and account.
  const template = await WhatsAppTemplate.findOne({
    _id: templateObjectId,
    workspaceId: workspaceObjectId,
    whatsappAccountId: account._id,
  });

  if (!template) {
    throw new AppError("Template not found in this workspace", 404);
  }

  if (template.status !== "APPROVED") {
    throw new AppError(
      `Template is not approved (status: ${template.status})`,
      422,
      "TEMPLATE_NOT_APPROVED",
    );
  }

  // 5. Validate required template variables and components
  type TemplateComponentItem = NonNullable<SendWhatsAppTemplateMessageParams["components"]>[number];
  const validatedComponents: TemplateComponentItem[] = [];

  // 5a. Header validation
  if (template.header?.format) {
    const headerFormat = template.header.format.toUpperCase();
    const headerComponent = components?.find((c) => c.type === "header");

    if (["IMAGE", "DOCUMENT", "VIDEO"].includes(headerFormat)) {
      const mediaTypeLower = headerFormat.toLowerCase();
      const hasMediaParam = headerComponent?.parameters?.some(
        (p) => p.type === mediaTypeLower && (p as Record<string, unknown>)[mediaTypeLower],
      );

      if (!headerComponent || !hasMediaParam) {
        throw new AppError(
          `Template requires a header media parameter of type ${mediaTypeLower}`,
          400,
          "MISSING_TEMPLATE_HEADER_MEDIA",
        );
      }
      validatedComponents.push(headerComponent);
    } else if (headerFormat === "TEXT" && template.header.text) {
      const headerMatches = template.header.text.match(/\{\{\d+\}\}/g) || [];
      if (headerMatches.length > 0) {
        const providedParams = headerComponent?.parameters || [];
        if (providedParams.length < headerMatches.length) {
          throw new AppError(
            `Template requires ${headerMatches.length} parameter(s) for header text, but only ${providedParams.length} provided`,
            400,
            "MISSING_TEMPLATE_HEADER_PARAMETERS",
          );
        }
        validatedComponents.push(headerComponent!);
      } else if (headerComponent) {
        validatedComponents.push(headerComponent);
      }
    } else if (headerComponent) {
      validatedComponents.push(headerComponent);
    }
  } else {
    const headerComponent = components?.find((c) => c.type === "header");
    if (headerComponent) {
      validatedComponents.push(headerComponent);
    }
  }

  // 5b. Body parameters validation
  const requiredVariables = template.variables || [];
  const bodyRegexMatches = template.body
    ? template.body.match(/\{\{\d+\}\}/g) || []
    : [];
  const totalRequiredBodyParams = Math.max(
    requiredVariables.length,
    bodyRegexMatches.length,
  );

  const bodyComponent = components?.find((c) => c.type === "body");
  if (totalRequiredBodyParams > 0) {
    const providedParams = bodyComponent?.parameters || [];
    if (providedParams.length < totalRequiredBodyParams) {
      throw new AppError(
        `Template requires ${totalRequiredBodyParams} parameter(s) for body, but only ${providedParams.length} provided`,
        400,
        "MISSING_TEMPLATE_PARAMETERS",
      );
    }
    validatedComponents.push(bodyComponent!);
  } else if (bodyComponent) {
    validatedComponents.push(bodyComponent);
  }

  // 5c. Button parameters validation
  const buttonComponents = components?.filter((c) => c.type === "button") || [];
  for (const btn of buttonComponents) {
    if (btn.index === undefined || btn.index < 0 || typeof btn.index !== "number") {
      throw new AppError(
        "Button component requires a non-negative index",
        400,
        "INVALID_TEMPLATE_BUTTON_PARAMETERS",
      );
    }
    if (!btn.sub_type || !["url", "quick_reply"].includes(btn.sub_type.toLowerCase())) {
      throw new AppError(
        "Button component requires a valid sub_type (url or quick_reply)",
        400,
        "INVALID_TEMPLATE_BUTTON_PARAMETERS",
      );
    }
    if (!btn.parameters || btn.parameters.length === 0) {
      throw new AppError(
        "Button component requires at least one parameter",
        400,
        "INVALID_TEMPLATE_BUTTON_PARAMETERS",
      );
    }
    validatedComponents.push(btn);
  }

  // 5d. Enforce standard Meta component ordering: header, body, button
  const orderRank: Record<string, number> = { header: 1, body: 2, button: 3 };
  const sortedComponents = [...validatedComponents].sort(
    (a, b) => (orderRank[a.type] || 99) - (orderRank[b.type] || 99),
  );

  // 6. Build Meta template payload.
  const templatePayload: Record<string, unknown> = {
    name: template.name,
    language: { code: language || template.language },
  };

  if (sortedComponents.length > 0) {
    templatePayload.components = sortedComponents;
  }

  const apiResponse = await makeWorkspaceWhatsAppRequest(
    workspaceId,
    account.phoneNumberId,
    "messages",
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: contact.waId,
      type: "template",
      template: templatePayload,
    },
  );

  // 7. Extract Meta message ID.
  const messages = apiResponse.messages as
    | Array<{ id?: string }>
    | undefined;

  const waMessageId = messages?.[0]?.id;

  if (!waMessageId) {
    throw new AppError(
      "WhatsApp API did not return a message ID",
      502,
    );
  }

  // 8. Save outgoing template message.
  const savedMessage = await WhatsAppMessage.create({
    workspaceId: workspaceObjectId,
    conversationId: conversation._id,
    contactId: contact._id,
    whatsappAccountId: account._id,
    waMessageId,
    direction: "OUTBOUND",
    type: "TEMPLATE",
    status: "SENT",
    text: template.body,
    templateName: template.name,
    templateLanguage: template.language,
    templateComponents: components,
    senderId: new Types.ObjectId(senderId),
    timestamp: new Date(),
    statusUpdatedAt: undefined,
  });

  // 9. Update conversation activity and reopen if previously closed.
  conversation.lastMessageAt = savedMessage.timestamp;
  if (conversation.status === "CLOSED") {
    conversation.status = "OPEN";
  }
  await conversation.save();

  return savedMessage;
}
