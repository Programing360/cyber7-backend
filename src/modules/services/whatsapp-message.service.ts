import { Types } from "mongoose";
import axios from "axios";
import { AppError } from "../../utils/app-error.js";
import { decrypt } from "../../utils/encryption.js";
import { getCallSocketIO } from "../../sockets/callSocket.js";
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

export {
  CUSTOMER_SERVICE_WINDOW_MS,
  isCustomerServiceWindowOpen,
  getCustomerServiceWindowExpiry,
};

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
  // Validate incoming message from identifier
  if (
    !message.from ||
    typeof message.from !== "string" ||
    !message.from.trim()
  ) {
    console.error(
      "[WhatsApp Inbound] Missing or invalid message.from identifier",
    );
    return {
      accountNotFound: false,
      duplicate: false,
    };
  }

  const rawFrom = message.from.trim();
  const cleanFrom = rawFrom.replace(/\D/g, "");
  if (!cleanFrom || cleanFrom.length < 5) {
    console.error(
      `[WhatsApp Inbound] Invalid message sender phone number: ${rawFrom}`,
    );
    return {
      accountNotFound: false,
      duplicate: false,
    };
  }

  // 1. Find connected WhatsApp account
  const cleanPhoneId = phoneNumberId.trim();
  const account = await WhatsAppAccount.findOne({
    phoneNumberId: cleanPhoneId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  // ("[INBOUND ACCOUNT CHECK]", {
  //   phoneNumberId: cleanPhoneId,
  //   accountFound: Boolean(account),
  //   accountStatus: account?.status,
  //   workspaceId: account?.workspaceId?.toString(),
  // });

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
  const isStopKeyword = /^(stop|unsubscribe|cancel|optout|opt-out|quit)$/i.test(
    cleanedText,
  );
  const isStartKeyword = /^(start|unstop)$/i.test(cleanedText);

  // 3. Find or create contact with opt-out / opt-in tracking
  // ⚠️ ফিক্স: waId ফিল্ডটি $set এবং $setOnInsert দুটো থেকেই বাদ দেওয়া হয়েছে (ফিল্টারের কারণে অটো সেট হবে)
  const contactUpdate: Record<string, unknown> = {
    phoneNumber: rawFrom,
    ...(contactName ? { profileName: contactName } : {}),
  };

  const contactSetOnInsert: Record<string, unknown> = {
    createdAt: incomingDate,
  };
  const contactUnset: Record<string, 1> = {};

  if (isStopKeyword) {
    contactUpdate.isOptedOut = true;
    contactUpdate.optOutTimestamp = incomingDate;
    contactUpdate.optOutSource = "STOP_MESSAGE";
  } else if (isStartKeyword) {
    contactUpdate.optInTimestamp = incomingDate;
    contactUpdate.optInSource = "START_MESSAGE";
  } else {
    contactSetOnInsert.isOptedOut = false;
  }

  const contact = await WhatsAppContact.findOneAndUpdate(
    {
      workspaceId: account.workspaceId,
      waId: cleanFrom,
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
      returnDocument: "after",
      setDefaultsOnInsert: true,
    },
  );

  // 4. Find or create conversation — updating 24-hour customer service window timestamp

  const isWindowActive = !isStopKeyword;
  const expiryDate = getCustomerServiceWindowExpiry
    ? getCustomerServiceWindowExpiry(incomingDate)
    : new Date(
        incomingDate.getTime() +
          (CUSTOMER_SERVICE_WINDOW_MS || 24 * 60 * 60 * 1000),
      );

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
        isCustomerServiceWindowActive: true, // ✅ ২৪ ঘণ্টার উইন্ডো সক্রিয় করা হলো
        customerServiceWindowExpiresAt: expiryDate,
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    },
  );

  // console.log("[INBOUND MESSAGE SAVE]", {
  //   waMessageId: message.id,
  //   conversationId: conversation._id.toString(),
  //   contactId: contact._id.toString(),
  //   type: message.type,
  // });

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
    // ("[INBOUND MESSAGE SAVED]", {
    //   messageId: savedMessage._id.toString(),
    //   waMessageId: savedMessage.waMessageId,
    // });

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
    console.warn(
      "[WhatsApp Status] Message not found for status update:",
      messageId,
    );
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
    if (
      message.statusUpdatedAt &&
      incomingTimestamp < message.statusUpdatedAt
    ) {
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
  // if (!isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt)) {
  //   throw new AppError(
  //     "The 24-hour customer service window has expired. You can only send approved template messages outside this window.",
  //     422,
  //     "CUSTOMER_SERVICE_WINDOW_EXPIRED",
  //   );
  // }

  // 4. Find connected WhatsApp account.
  const account = await WhatsAppAccount.findOne({
    _id: conversation.whatsappAccountId,
    workspaceId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (!account) {
    throw new AppError("WhatsApp account not connected", 404);
  }

  // 5. Validate recipient phone number integrity before outbound sending
  const rawRecipient = contact.waId || contact.phoneNumber || "";
  const recipientPhone = rawRecipient.replace(/\D/g, "");

  if (!recipientPhone || recipientPhone.length < 5) {
    throw new AppError(
      "Contact does not have a valid WhatsApp phone number. Please update the contact's phone number.",
      400,
      "INVALID_RECIPIENT_PHONE",
    );
  }

  // Proactive self-heal: ensure contact waId in DB matches valid recipientPhone
  if (
    (!contact.waId || contact.waId !== recipientPhone) &&
    typeof (contact as { save?: () => Promise<unknown> }).save === "function"
  ) {
    contact.waId = recipientPhone;
    if (!contact.phoneNumber) {
      contact.phoneNumber = recipientPhone;
    }
    await (contact as { save: () => Promise<unknown> })
      .save()
      .catch((err: unknown) => {
        console.warn(
          "[Contact Self-Heal Warning] Failed to update contact waId:",
          err,
        );
      });
  }

  // console.log("[OUTBOUND WHATSAPP DIAGNOSTIC]", {
  //   action: "SEND_TEXT_MESSAGE",
  //   workspaceId: String(workspaceId),
  //   phoneNumberId: account.phoneNumberId,
  //   conversationId: conversation._id.toString(),
  //   contactId: contact._id.toString(),
  //   recipientPhoneMasked:
  //     recipientPhone.length > 4
  //       ? recipientPhone.slice(0, 4) + "****" + recipientPhone.slice(-2)
  //       : "****",
  //   messageType: "text",
  //   textLength: text.length,
  //   hasToken: Boolean(account.accessTokenEncrypted),
  // });

  // 6. Send message through Meta WhatsApp Cloud API.
  const apiResponse = await makeWorkspaceWhatsAppRequest(
    workspaceId,
    account.phoneNumberId,
    "messages",
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "text",
      text: {
        preview_url: false,
        body: text,
      },
    },
  );

  // 7. Extract Meta message ID.
  const messages = apiResponse.messages as Array<{ id?: string }> | undefined;

  const waMessageId = messages?.[0]?.id;

  if (!waMessageId) {
    throw new AppError("WhatsApp API did not return a message ID", 502);
  }

  // 8. Save outgoing message.
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

  // console.log("[OUTBOUND MESSAGE SAVED]", {
  //   messageId: savedMessage._id.toString(),
  //   waMessageId: savedMessage.waMessageId,
  // });

  // 9. Update conversation activity.
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
  // console.log(conversation);
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
  }).select("+accessTokenEncrypted");

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
  type TemplateComponentItem = NonNullable<
    SendWhatsAppTemplateMessageParams["components"]
  >[number];
  const validatedComponents: TemplateComponentItem[] = [];

  // 5a. Header validation
  if (template.header?.format) {
    const headerFormat = template.header.format.toUpperCase();
    const headerComponent = components?.find((c) => c.type === "header");

    if (["IMAGE", "DOCUMENT", "VIDEO"].includes(headerFormat)) {
      const mediaTypeLower = headerFormat.toLowerCase();
      const hasMediaParam = headerComponent?.parameters?.some(
        (p) =>
          p.type === mediaTypeLower &&
          (p as Record<string, unknown>)[mediaTypeLower],
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
    if (
      btn.index === undefined ||
      btn.index < 0 ||
      typeof btn.index !== "number"
    ) {
      throw new AppError(
        "Button component requires a non-negative index",
        400,
        "INVALID_TEMPLATE_BUTTON_PARAMETERS",
      );
    }
    if (
      !btn.sub_type ||
      !["url", "quick_reply"].includes(btn.sub_type.toLowerCase())
    ) {
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

  // 6b. Validate recipient phone number integrity before template sending
  const rawRecipient = contact.waId || contact.phoneNumber || "";
  const recipientPhone = rawRecipient.replace(/\D/g, "");

  if (!recipientPhone || recipientPhone.length < 5) {
    throw new AppError(
      "Contact does not have a valid WhatsApp phone number. Please update the contact's phone number.",
      400,
      "INVALID_RECIPIENT_PHONE",
    );
  }

  // Proactive self-heal: ensure contact waId in DB matches valid recipientPhone
  if (
    (!contact.waId || contact.waId !== recipientPhone) &&
    typeof (contact as { save?: () => Promise<unknown> }).save === "function"
  ) {
    contact.waId = recipientPhone;
    if (!contact.phoneNumber) {
      contact.phoneNumber = recipientPhone;
    }
    await (contact as { save: () => Promise<unknown> })
      .save()
      .catch((err: unknown) => {
        console.warn(
          "[Contact Self-Heal Warning] Failed to update contact waId:",
          err,
        );
      });
  }

  // console.log("[OUTBOUND WHATSAPP DIAGNOSTIC]", {
  //   action: "SEND_TEMPLATE_MESSAGE",
  //   workspaceId: workspaceObjectId.toString(),
  //   phoneNumberId: account.phoneNumberId,
  //   conversationId: conversation._id.toString(),
  //   contactId: contact._id.toString(),
  //   recipientPhoneMasked:
  //     recipientPhone.length > 4
  //       ? recipientPhone.slice(0, 4) + "****" + recipientPhone.slice(-2)
  //       : "****",
  //   messageType: "template",
  //   templateName: template.name,
  //   templateLanguage: template.language,
  //   hasToken: Boolean(account.accessTokenEncrypted),
  // });

  const apiResponse = await makeWorkspaceWhatsAppRequest(
    workspaceId,
    account.phoneNumberId,
    "messages",
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "template",
      template: templatePayload,
    },
  );

  // 7. Extract Meta message ID.
  const messages = apiResponse.messages as Array<{ id?: string }> | undefined;

  const waMessageId = messages?.[0]?.id;

  if (!waMessageId) {
    throw new AppError("WhatsApp API did not return a message ID", 502);
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

/**
 * Streams media (image, video, audio, document) from Meta Graph API.
 *
 * Implements Issue 3: Backend Media Proxy
 */
export async function getWhatsAppMediaStream({
  workspaceId,
  mediaId,
}: {
  workspaceId: string;
  mediaId: string;
}): Promise<{
  stream: NodeJS.ReadableStream;
  contentType: string;
  contentLength?: number;
}> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("Invalid workspace ID", 400);
  }
  if (!mediaId || typeof mediaId !== "string") {
    throw new AppError("Media ID is required", 400);
  }

  // 1. Find connected WhatsApp account
  const account = await WhatsAppAccount.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (!account || !account.accessTokenEncrypted) {
    throw new AppError(
      "No active WhatsApp account connected for this workspace",
      404,
    );
  }

  let token: string;
  try {
    token = decrypt(account.accessTokenEncrypted);
  } catch {
    throw new AppError("Failed to decrypt WhatsApp account credentials", 500);
  }

  // 2. Fetch media URL from Meta Graph API: GET https://graph.facebook.com/v21.0/{media_id}
  const metaInfoRes = await axios.get(
    `https://graph.facebook.com/v21.0/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 15000,
    },
  );

  const mediaUrl = metaInfoRes.data?.url;
  const mimeType = metaInfoRes.data?.mime_type || "application/octet-stream";
  const fileSize = metaInfoRes.data?.file_size;

  if (!mediaUrl) {
    throw new AppError("Meta Graph API did not return a media URL", 502);
  }

  // 3. Fetch media binary stream from Meta CDN using Bearer token
  const mediaStreamRes = await axios.get(mediaUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "curl/7.64.1",
    },
    responseType: "stream",
    timeout: 30000,
  });

  return {
    stream: mediaStreamRes.data,
    contentType: mimeType,
    contentLength: typeof fileSize === "number" ? fileSize : undefined,
  };
}

export interface SendWhatsAppMediaMessageParams {
  workspaceId: string;
  conversationId: string;
  senderId: string;
  type: "IMAGE" | "VIDEO";
  fileBase64?: string;
  mediaUrl?: string;
  filename?: string;
  mimeType?: string;
  caption?: string;
}

/**
 * Sends an outbound image or video to a WhatsApp contact via Meta Messages API.
 *
 * Implements Issue 3: Backend Outbound Media
 */
export async function sendWhatsAppMediaMessage({
  workspaceId,
  conversationId,
  senderId,
  type,
  fileBase64,
  mediaUrl,
  filename,
  mimeType,
  caption,
}: SendWhatsAppMediaMessageParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("Valid workspace ID is required", 400);
  }
  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError("Valid conversation ID is required", 400);
  }

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

  // Server-side enforcement of 24-hour Customer Service Window
  // if (!isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt)) {
  //   throw new AppError(
  //     "The 24-hour customer service window has expired. You can only send approved template messages outside this window.",
  //     422,
  //     "CUSTOMER_SERVICE_WINDOW_EXPIRED",
  //   );
  // }

  const account = await WhatsAppAccount.findOne({
    _id: conversation.whatsappAccountId,
    workspaceId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (!account || !account.accessTokenEncrypted) {
    throw new AppError("WhatsApp account not connected", 404);
  }

  let token: string;
  try {
    token = decrypt(account.accessTokenEncrypted);
  } catch {
    throw new AppError("Failed to decrypt WhatsApp account credentials", 500);
  }

  const rawRecipient = contact.waId || contact.phoneNumber || "";
  const recipientPhone = rawRecipient.replace(/\D/g, "");

  if (!recipientPhone || recipientPhone.length < 5) {
    throw new AppError(
      "Contact does not have a valid WhatsApp phone number",
      400,
    );
  }

  let metaMediaId: string | undefined = undefined;
  const determinedMime =
    mimeType || (type === "VIDEO" ? "video/mp4" : "image/jpeg");

  // If base64 file data was sent, upload to Meta Media API first
  if (fileBase64) {
    const rawData = fileBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(rawData, "base64");

    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("type", determinedMime);
    formData.append(
      "file",
      new Blob([buffer], { type: determinedMime }),
      filename ||
        (type === "VIDEO"
          ? `video-${Date.now()}.mp4`
          : `image-${Date.now()}.jpg`),
    );

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v21.0/${account.phoneNumberId}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    metaMediaId = uploadRes.data?.id;
    if (!metaMediaId) {
      throw new AppError("Failed to upload media to Meta Graph API", 502);
    }
  }

  if (!metaMediaId && !mediaUrl) {
    throw new AppError("Either fileBase64 or mediaUrl must be provided", 400);
  }

  // Send message via Meta WhatsApp Messages API
  const mediaKey = type.toLowerCase() as "image" | "video";
  const mediaPayload: Record<string, unknown> = metaMediaId
    ? { id: metaMediaId }
    : { link: mediaUrl };

  if (caption && caption.trim()) {
    mediaPayload.caption = caption.trim();
  }

  const apiResponse = await makeWorkspaceWhatsAppRequest(
    workspaceId,
    account.phoneNumberId,
    "messages",
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: mediaKey,
      [mediaKey]: mediaPayload,
    },
  );

  const metaMsgId = (
    apiResponse.messages as Array<{ id?: string }> | undefined
  )?.[0]?.id;
  if (!metaMsgId) {
    throw new AppError("WhatsApp API did not return a message ID", 502);
  }

  // Save to DB
  const savedMessage = await WhatsAppMessage.create({
    workspaceId,
    conversationId: conversation._id,
    contactId: contact._id,
    whatsappAccountId: account._id,
    waMessageId: metaMsgId,
    direction: "OUTBOUND",
    type: type.toUpperCase() as "IMAGE" | "VIDEO",
    status: "SENT",
    text: caption?.trim() || "",
    mediaId: metaMediaId,
    mediaMimeType: determinedMime,
    senderId,
    timestamp: new Date(),
  });

  conversation.lastMessageAt = savedMessage.timestamp;
  await conversation.save();

  // Broadcast to Socket.IO ("new-message")
  const io = getCallSocketIO();
  if (io) {
    const wsId = workspaceId.toString();
    const payload = {
      _id: savedMessage._id.toString(),
      workspaceId: wsId,
      conversationId: conversation._id.toString(),
      contactId: contact._id.toString(),
      whatsappAccountId: account._id.toString(),
      direction: savedMessage.direction,
      type: savedMessage.type,
      status: savedMessage.status,
      text: savedMessage.text,
      mediaId: savedMessage.mediaId,
      mediaMimeType: savedMessage.mediaMimeType,
      timestamp: savedMessage.timestamp.toISOString(),
      createdAt: (savedMessage as any).createdAt
        ? (savedMessage as any).createdAt.toISOString()
        : savedMessage.timestamp.toISOString(),
    };
    io.to(wsId).emit("new-message", payload);
    io.to(`workspace_${wsId}`).emit("new-message", payload);
  }

  return savedMessage;
}
