import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "./contact.model.js";
import WhatsAppAccount from "./whatsapp.model.js";
import WhatsAppConversation, {
  ConversationStatus,
  isCustomerServiceWindowOpen,
  getCustomerServiceWindowExpiry,
} from "./conversation.model.js";
import WhatsAppMessage from "./message.model.js";
import { makeWorkspaceWhatsAppRequest } from "../services/whatsapp-api.service.js";
import { getCallSocketIO } from "../../sockets/callSocket.js";
import {
  normalizeWhatsAppPhoneNumber,
  findExistingContactByPhone,
  resolveOrCreateWorkspaceContact,
  resolveOrCreateWorkspaceConversation,
} from "./whatsapp-contact-resolver.service.js";
import type {
  CreateContactInput,
  UpdateContactInput,
  UpdateConversationStatusInput,
} from "./whatsapp.validation.js";

// Helper to escape regex special characters for safe search
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Contacts Service ────────────────────────────────────────────────────────

interface ListContactsParams {
  workspaceId: string;
  page: number;
  limit: number;
  search?: string;
}

export async function listWorkspaceContacts({
  workspaceId,
  page,
  limit,
  search,
}: ListContactsParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
  };

  if (search && search.trim()) {
    const escaped = escapeRegex(search.trim());
    filter.$or = [
      { profileName: { $regex: escaped, $options: "i" } },
      { phoneNumber: { $regex: escaped, $options: "i" } },
      { waId: { $regex: escaped, $options: "i" } },
    ];
  }

  const total = await WhatsAppContact.countDocuments(filter);
  const totalPages = Math.ceil(total / limit) || 1;

  const contacts = await WhatsAppContact.find(filter)
    .sort({ updatedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return {
    contacts,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

interface GetContactByIdParams {
  workspaceId: string;
  contactId: string;
}

export async function getWorkspaceContactById({
  workspaceId,
  contactId,
}: GetContactByIdParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(contactId)) {
    throw new AppError("Contact not found", 404);
  }

  const contact = await WhatsAppContact.findOne({
    _id: new Types.ObjectId(contactId),
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean();

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  return contact;
}

interface CreateContactParams {
  workspaceId: string;
  input: CreateContactInput;
}

export async function createOrUpsertWorkspaceContact({
  workspaceId,
  input,
}: CreateContactParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const rawPhone = input.phoneNumber.trim();
  const digits = rawPhone.replace(/\D/g, "");
  if (digits.length < 5) {
    throw new AppError("Invalid phone number format", 400);
  }

  const contact = await resolveOrCreateWorkspaceContact({
    workspaceId,
    phoneNumber: rawPhone,
    profileName: input.profileName?.trim() || undefined,
  });

  return contact;
}

interface UpdateContactParams {
  workspaceId: string;
  contactId: string;
  input: UpdateContactInput;
}

export async function updateWorkspaceContact({
  workspaceId,
  contactId,
  input,
}: UpdateContactParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(contactId)) {
    throw new AppError("Contact not found", 404);
  }

  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const contactObjectId = new Types.ObjectId(contactId);

  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, ""> = {};

  if (input.phoneNumber !== undefined) {
    const waId = input.phoneNumber.replace(/\D/g, "");
    if (waId.length < 5) {
      throw new AppError("Invalid phone number format", 400);
    }

    const duplicate = await WhatsAppContact.findOne({
      workspaceId: workspaceObjectId,
      waId,
      _id: { $ne: contactObjectId },
    }).select("_id");

    if (duplicate) {
      throw new AppError(
        "A contact with this phone number already exists in this workspace",
        409,
      );
    }

    setFields.phoneNumber = input.phoneNumber.trim();
    setFields.waId = waId;
  }

  if (input.isOptedOut !== undefined) {
    if (input.isOptedOut) {
      setFields.isOptedOut = true;
      setFields.optOutTimestamp = new Date();
      setFields.optOutSource = "USER_ACTION";
    } else {
      setFields.isOptedOut = false;
      setFields.optInTimestamp = new Date();
      setFields.optInSource = "USER_ACTION";
      // Preserve optOutTimestamp and optOutSource for audit trail rather than silently unsetting
    }
  }

  if (input.isBlocked !== undefined) {
    setFields.isBlocked = Boolean(input.isBlocked);
    if (input.isBlocked && input.isOptedOut === undefined) {
      setFields.isOptedOut = true;
      setFields.optOutTimestamp = new Date();
      setFields.optOutSource = "USER_ACTION";
    } else if (!input.isBlocked && input.isOptedOut === undefined) {
      setFields.isOptedOut = false;
      setFields.optInTimestamp = new Date();
      setFields.optInSource = "USER_ACTION";
    }
  }

  if (input.profileName !== undefined) {
    const profileName = input.profileName.trim();
    if (profileName) {
      setFields.profileName = profileName;
    } else {
      unsetFields.profileName = "";
    }
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) {
    update.$set = setFields;
  }
  if (Object.keys(unsetFields).length > 0) {
    update.$unset = unsetFields;
  }

  try {
    const contact = await WhatsAppContact.findOneAndUpdate(
      {
        _id: contactObjectId,
        workspaceId: workspaceObjectId,
      },
      update,
      {
        returnDocument: "after",
        runValidators: true,
      },
    );

    if (!contact) {
      throw new AppError("Contact not found", 404);
    }

    return contact;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: number }).code === 11000
    ) {
      throw new AppError(
        "A contact with this phone number already exists in this workspace",
        409,
      );
    }
    throw error;
  }
}

export async function deleteWorkspaceContact({
  workspaceId,
  contactId,
}: {
  workspaceId: string;
  contactId: string;
}) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(contactId)) {
    throw new AppError("Contact not found", 404);
  }

  const contact = await WhatsAppContact.findOneAndDelete({
    _id: new Types.ObjectId(contactId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  return { message: "Contact deleted successfully" };
}

// ─── Conversations Service ───────────────────────────────────────────────────

interface ListConversationsParams {
  workspaceId: string;
  page: number;
  limit: number;
  status?: string;
  search?: string;
}

export async function listWorkspaceConversations({
  workspaceId,
  page,
  limit,
  status,
  search,
}: ListConversationsParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
  };

  if (status && ["OPEN", "CLOSED", "PENDING"].includes(status.toUpperCase())) {
    filter.status = status.toUpperCase();
  }

  if (search && search.trim()) {
    const escaped = escapeRegex(search.trim());
    const matchingContacts = await WhatsAppContact.find({
      workspaceId: new Types.ObjectId(workspaceId),
      $or: [
        { profileName: { $regex: escaped, $options: "i" } },
        { phoneNumber: { $regex: escaped, $options: "i" } },
        { waId: { $regex: escaped, $options: "i" } },
      ],
    }).select("_id");

    filter.contactId = { $in: matchingContacts.map((c) => c._id) };
  }

  const total = await WhatsAppConversation.countDocuments(filter);
  const totalPages = Math.ceil(total / limit) || 1;

  const conversations = await WhatsAppConversation.find(filter)
    .populate(
      "contactId",
      "profileName phoneNumber waId isBlocked isOptedOut",
    )
    .populate("assignedTo", "name email")
    .populate("whatsappAccountId", "businessName displayPhoneNumber")
    .sort({ lastMessageAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  // Efficient batch aggregation to get latest message preview without N+1 queries
  const conversationIds = conversations.map((c) => c._id);
  const latestMessageMap = new Map<string, unknown>();

  if (conversationIds.length > 0) {
    const targetWorkspaceObjectId = Types.ObjectId.isValid(workspaceId)
      ? new Types.ObjectId(workspaceId)
      : null;

    const conversationObjectIds = conversationIds
      .map((id) =>
        Types.ObjectId.isValid(id.toString())
          ? new Types.ObjectId(id.toString())
          : null,
      )
      .filter(Boolean);
    const conversationStringIds = conversationIds.map((id) => id.toString());
    const allConversationIds = Array.from(
      new Set([...conversationObjectIds, ...conversationStringIds]),
    );

    const workspaceMatchList: unknown[] = [workspaceId.toString()];
    if (targetWorkspaceObjectId) {
      workspaceMatchList.push(targetWorkspaceObjectId);
    }

    const latestMessages = await WhatsAppMessage.aggregate([
      {
        $match: {
          conversationId: { $in: allConversationIds },
          workspaceId: { $in: workspaceMatchList },
        },
      },
      { $sort: { timestamp: -1, createdAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          lastMessage: {
            $first: {
              _id: "$_id",
              text: "$text",
              type: "$type",
              direction: "$direction",
              status: "$status",
              timestamp: "$timestamp",
              templateName: "$templateName",
              mediaMimeType: "$mediaMimeType",
              createdAt: "$createdAt",
            },
          },
        },
      },
    ]);

    for (const msg of latestMessages) {
      latestMessageMap.set(String(msg._id), msg.lastMessage);
    }
  }

  const enrichedConversations = conversations.map((conv) => {
    const lastMsg: any =
      latestMessageMap.get(conv._id.toString()) ||
      (conv as any).lastMessage ||
      null;

    return {
      ...conv,
      lastMessage: lastMsg,
      lastMessageText:
        lastMsg?.text ||
        lastMsg?.templateName ||
        (lastMsg?.type ? `[${lastMsg.type}]` : undefined),
      isCustomerServiceWindowActive: isCustomerServiceWindowOpen(
        conv.lastCustomerMessageAt,
      ),
      customerServiceWindowExpiresAt:
        getCustomerServiceWindowExpiry(
          conv.lastCustomerMessageAt,
        )?.toISOString() ?? null,
    };
  });

  return {
    conversations: enrichedConversations,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

interface GetConversationByIdParams {
  workspaceId: string;
  conversationId: string;
}

export async function getWorkspaceConversationById({
  workspaceId,
  conversationId,
}: GetConversationByIdParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError("Conversation not found", 404);
  }

  const conversation = await WhatsAppConversation.findOne({
    _id: new Types.ObjectId(conversationId),
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .populate(
      "contactId",
      "profileName phoneNumber waId isBlocked isOptedOut",
    )
    .populate("assignedTo", "name email")
    .populate("whatsappAccountId", "businessName displayPhoneNumber")
    .lean();

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  return {
    ...conversation,
    isCustomerServiceWindowActive: isCustomerServiceWindowOpen(
      conversation.lastCustomerMessageAt,
    ),
    customerServiceWindowExpiresAt:
      getCustomerServiceWindowExpiry(
        conversation.lastCustomerMessageAt,
      )?.toISOString() ?? null,
  };
}

interface UpdateConversationStatusParams {
  workspaceId: string;
  conversationId: string;
  status: ConversationStatus;
}

export async function updateWorkspaceConversationStatus({
  workspaceId,
  conversationId,
  status,
}: UpdateConversationStatusParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError("Conversation not found", 404);
  }

  const conversation = await WhatsAppConversation.findOneAndUpdate(
    {
      _id: new Types.ObjectId(conversationId),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: { status } },
    { returnDocument: "after" },
  )
    .populate(
      "contactId",
      "profileName phoneNumber waId isBlocked isOptedOut",
    )
    .populate("assignedTo", "name email");

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  return conversation;
}

export async function updateWorkspaceConversation({
  workspaceId,
  conversationId,
  input,
}: {
  workspaceId: string;
  conversationId: string;
  input: { status?: ConversationStatus; isFavorite?: boolean };
}) {
  if (
    !Types.ObjectId.isValid(workspaceId) ||
    !Types.ObjectId.isValid(conversationId)
  ) {
    throw new AppError("Invalid workspace or conversation ID", 400);
  }

  const updateFields: Record<string, unknown> = {};
  if (input.status !== undefined) {
    updateFields.status = input.status;
  }
  if (input.isFavorite !== undefined) {
    updateFields.isFavorite = Boolean(input.isFavorite);
  }

  const conversation = await WhatsAppConversation.findOneAndUpdate(
    {
      _id: new Types.ObjectId(conversationId),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: updateFields },
    { returnDocument: "after" },
  )
    .populate(
      "contactId",
      "profileName phoneNumber waId isBlocked isOptedOut",
    )
    .populate("assignedTo", "name email");

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  return conversation;
}

export async function deleteWorkspaceConversation({
  workspaceId,
  conversationId,
}: {
  workspaceId: string;
  conversationId: string;
}) {
  if (
    !Types.ObjectId.isValid(workspaceId) ||
    !Types.ObjectId.isValid(conversationId)
  ) {
    throw new AppError("Invalid workspace or conversation ID", 400);
  }

  const conversation = await WhatsAppConversation.findOneAndDelete({
    _id: new Types.ObjectId(conversationId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  // Clean up associated messages
  await WhatsAppMessage.deleteMany({
    conversationId: new Types.ObjectId(conversationId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  return { message: "Conversation deleted successfully" };
}

// ─── Messages History Service ────────────────────────────────────────────────

interface ListConversationMessagesParams {
  workspaceId: string;
  conversationId: string;
  page: number;
  limit: number;
}

export async function listWorkspaceConversationMessages({
  workspaceId,
  conversationId,
  page,
  limit,
}: ListConversationMessagesParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError("Conversation not found", 404);
  }

  // Verify conversation exists and belongs to the workspace
  const conversation = await WhatsAppConversation.findOne({
    _id: new Types.ObjectId(conversationId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  const filter = {
    workspaceId: new Types.ObjectId(workspaceId),
    conversationId: new Types.ObjectId(conversationId),
  };

  const total = await WhatsAppMessage.countDocuments(filter);
  const totalPages = Math.ceil(total / limit) || 1;

  // Chronological order: timestamp ascending
  const messages = await WhatsAppMessage.find(filter)
    .select(
      "conversationId contactId whatsappAccountId waMessageId direction type status text mediaId mediaMimeType timestamp errorMessage senderId statusUpdatedAt createdAt",
    )
    .sort({ timestamp: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return {
    messages,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

interface CreateOrGetConversationParams {
  workspaceId: string;
  contactId?: string;
  phoneNumber?: string;
  profileName?: string;
}

export async function createOrGetWorkspaceConversation({
  workspaceId,
  contactId,
  phoneNumber,
  profileName,
}: CreateOrGetConversationParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }
  const workspaceObjectId = new Types.ObjectId(workspaceId);

  // Find connected account
  const account = await WhatsAppAccount.findOne({
    workspaceId: workspaceObjectId,
    status: "CONNECTED",
  });
  if (!account) {
    throw new AppError("No connected WhatsApp account found in this workspace", 400);
  }

  let targetContactId: Types.ObjectId;

  if (contactId) {
    if (!Types.ObjectId.isValid(contactId)) {
      throw new AppError("Invalid contact ID", 400);
    }
    const contact = await WhatsAppContact.findOne({
      _id: new Types.ObjectId(contactId),
      workspaceId: workspaceObjectId,
    });
    if (!contact) {
      throw new AppError("Contact not found", 404);
    }
    targetContactId = contact._id as Types.ObjectId;
  } else if (phoneNumber) {
    const contact = await createOrUpsertWorkspaceContact({
      workspaceId,
      input: { phoneNumber, profileName },
    });
    targetContactId = contact._id as Types.ObjectId;
  } else {
    throw new AppError("Either contactId or phoneNumber is required", 400);
  }

  // Find or create conversation with strict single-conversation guarantee
  const conversationDoc = await resolveOrCreateWorkspaceConversation({
    workspaceId: workspaceObjectId,
    whatsappAccountId: account._id,
    contactId: targetContactId,
    isCustomerMessage: false,
  });

  const conversation = await WhatsAppConversation.findById(conversationDoc._id)
    .populate(
      "contactId",
      "profileName phoneNumber waId isBlocked isOptedOut",
    )
    .populate("assignedTo", "name email")
    .populate("whatsappAccountId", "businessName displayPhoneNumber")
    .lean();

  if (!conversation) {
    throw new AppError("Failed to create conversation", 500);
  }

  return {
    ...conversation,
    isCustomerServiceWindowActive: isCustomerServiceWindowOpen(
      conversation.lastCustomerMessageAt,
    ),
    customerServiceWindowExpiresAt:
      getCustomerServiceWindowExpiry(
        conversation.lastCustomerMessageAt,
      )?.toISOString() ?? null,
  };
}

// ─── Read Receipts / Mark Conversation Read ─────────────────────────────────

interface MarkConversationAsReadParams {
  workspaceId: string;
  conversationId: string;
  userId?: string;
}

export async function markWorkspaceConversationAsRead({
  workspaceId,
  conversationId,
  userId,
}: MarkConversationAsReadParams) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError("A valid conversation ID is required", 400);
  }

  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const conversationObjectId = new Types.ObjectId(conversationId);

  // 1. Verify conversation belongs to this workspace
  const conversation = await WhatsAppConversation.findOne({
    _id: conversationObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  const now = new Date();

  // 2. Mark all unread INBOUND messages as READ in MongoDB
  const updateResult = await WhatsAppMessage.updateMany(
    {
      workspaceId: workspaceObjectId,
      conversationId: conversationObjectId,
      direction: "INBOUND",
      status: { $ne: "READ" },
    },
    {
      $set: {
        status: "READ",
        statusUpdatedAt: now,
      },
    },
  );

  // 3. Mark unread messages on Meta Graph API in the background (non-blocking)
  setImmediate(async () => {
    try {
      const account = await WhatsAppAccount.findOne({
        _id: conversation.whatsappAccountId,
        workspaceId: workspaceObjectId,
        status: "CONNECTED",
      }).select("phoneNumberId");

      if (!account?.phoneNumberId) return;

      const unreadInbounds = await WhatsAppMessage.find({
        workspaceId: workspaceObjectId,
        conversationId: conversationObjectId,
        direction: "INBOUND",
        waMessageId: { $exists: true, $ne: "" },
      })
        .sort({ timestamp: -1 })
        .limit(10)
        .lean();

      for (const msg of unreadInbounds) {
        if (!msg.waMessageId) continue;
        try {
          await makeWorkspaceWhatsAppRequest(
            workspaceId,
            account.phoneNumberId,
            "messages",
            {
              messaging_product: "whatsapp",
              status: "read",
              message_id: msg.waMessageId,
            },
          );
        } catch {
          // Meta API read delivery is best-effort
        }
      }
    } catch (err: any) {
      console.warn("[Meta Read Receipt Error]:", err?.message);
    }
  });

  // 4. Real-time broadcast via Socket.IO
  try {
    const io = globalThis.__CALL_SOCKET_IO__ ?? getCallSocketIO();
    if (io) {
      const readPayload = {
        workspaceId,
        conversationId,
        readBy: userId,
        readAt: now.toISOString(),
        updatedCount: updateResult.modifiedCount,
      };

      io.to(workspaceId).emit("conversation:read", readPayload);
      io.to(`workspace_${workspaceId}`).emit("conversation:read", readPayload);

      io.to(workspaceId).emit("message-status-updated", {
        conversationId,
        status: "READ",
        statusUpdatedAt: now.toISOString(),
      });
      io.to(`workspace_${workspaceId}`).emit("message-status-updated", {
        conversationId,
        status: "READ",
        statusUpdatedAt: now.toISOString(),
      });
    }
  } catch (socketErr) {
    console.warn("[Socket.IO] Failed to broadcast conversation:read:", socketErr);
  }

  return {
    success: true,
    modifiedCount: updateResult.modifiedCount,
    readAt: now.toISOString(),
  };
}
