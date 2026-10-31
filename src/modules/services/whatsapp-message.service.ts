import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import WhatsAppConversation from "../whatsapp/conversation.model.js";
import WhatsAppMessage, {
  WhatsAppMessageStatus,
  WhatsAppMessageType,
} from "../whatsapp/message.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import Workspace from "../workspace/workspace.model.js";
import { makeWorkspaceWhatsAppRequest } from "./whatsapp-api.service.js";

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

  // 3. Find or create contact
  const contact = await WhatsAppContact.findOneAndUpdate(
    {
      workspaceId: account.workspaceId,
      waId: message.from,
    },
    {
      $set: {
        phoneNumber: message.from,
        ...(contactName ? { profileName: contactName } : {}),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  // 4. Find or create conversation
  const conversation = await WhatsAppConversation.findOneAndUpdate(
    {
      workspaceId: account.workspaceId,
      whatsappAccountId: account._id,
      contactId: contact._id,
    },
    {
      $set: {
        status: "OPEN",
        lastMessageAt: new Date(Number(message.timestamp) * 1000),
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
      timestamp: new Date(Number(message.timestamp) * 1000),
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
      error.code === 11000
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
  // e.g. READ cannot regress to DELIVERED or SENT; DELIVERED cannot regress to SENT
  if (newRank < currentRank) {
    return message;
  }

  // Rule 3: If status rank is equal (e.g. repeated DELIVERED events), only update if incoming timestamp is newer or equal
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

  // 2. Find contact.
  const contact = await WhatsAppContact.findOne({
    _id: conversation.contactId,
    workspaceId,
  });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  // 3. Find connected WhatsApp account.
  const account = await WhatsAppAccount.findOne({
    _id: conversation.whatsappAccountId,
    workspaceId,
    status: "CONNECTED",
  });

  if (!account) {
    throw new AppError("WhatsApp account not connected", 404);
  }

  // 4. Send message through Meta WhatsApp Cloud API.
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

  // 5. Extract Meta message ID.
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

  // 6. Save outgoing message.
  // Note: statusUpdatedAt is deliberately undefined at creation time so that Meta's
  // first status event (sent/delivered) is not blocked by local millisecond clock skew.
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

  // 7. Update conversation activity.
  conversation.lastMessageAt = savedMessage.timestamp;
  await conversation.save();

  return savedMessage;
}
