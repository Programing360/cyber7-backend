import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "./contact.model.js";
import WhatsAppConversation, {
  ConversationStatus,
} from "./conversation.model.js";
import WhatsAppMessage from "./message.model.js";
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

  const waId = input.phoneNumber.replace(/\D/g, "");
  if (waId.length < 5) {
    throw new AppError("Invalid phone number format", 400);
  }

  try {
    const contact = await WhatsAppContact.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        waId,
      },
      {
        $set: {
          phoneNumber: input.phoneNumber.trim(),
          ...(input.profileName
            ? { profileName: input.profileName.trim() }
            : {}),
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );

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
        new: true,
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
    .populate("contactId", "profileName phoneNumber waId")
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
    const latestMessages = await WhatsAppMessage.aggregate([
      {
        $match: {
          conversationId: { $in: conversationIds },
          workspaceId: new Types.ObjectId(workspaceId),
        },
      },
      { $sort: { timestamp: -1 } },
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
            },
          },
        },
      },
    ]);

    for (const msg of latestMessages) {
      latestMessageMap.set(msg._id.toString(), msg.lastMessage);
    }
  }

  const enrichedConversations = conversations.map((conv) => ({
    ...conv,
    lastMessage: latestMessageMap.get(conv._id.toString()) || null,
  }));

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
    .populate("contactId", "profileName phoneNumber waId")
    .populate("assignedTo", "name email")
    .populate("whatsappAccountId", "businessName displayPhoneNumber")
    .lean();

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  return conversation;
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
    { new: true },
  )
    .populate("contactId", "profileName phoneNumber waId")
    .populate("assignedTo", "name email");

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  return conversation;
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
