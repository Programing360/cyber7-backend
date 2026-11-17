import mongoose, { Types } from "mongoose";
import WhatsAppContact, { type IWhatsAppContact } from "./contact.model.js";
import WhatsAppConversation, {
  type IWhatsAppConversation,
  isCustomerServiceWindowOpen,
  getCustomerServiceWindowExpiry,
  CUSTOMER_SERVICE_WINDOW_MS,
} from "./conversation.model.js";
import WhatsAppMessage from "./message.model.js";
import CallLog from "../Calling/CallLog.js";

/**
 * Normalizes phone numbers across different inputs and formats.
 * E.g., handles "017XXXXXXXX" (Bangladesh local) -> "88017XXXXXXXX",
 * "+88017XXXXXXXX" -> "88017XXXXXXXX",
 * stripping whitespace, dashes, parens, and builds search variants for DB matching.
 */
export function normalizeWhatsAppPhoneNumber(
  input: string,
  defaultCountryCode = "880",
): {
  waId: string;
  phoneNumber: string;
  searchVariants: string[];
} {
  const raw = (input || "").trim();
  const digits = raw.replace(/\D/g, "");

  let canonicalDigits = digits;

  // Local BD format starting with 0 (e.g., 017... 11 digits)
  if (digits.startsWith("0") && digits.length === 11) {
    canonicalDigits = defaultCountryCode + digits.slice(1);
  } else if (!digits.startsWith("0") && digits.length === 10) {
    // 10 digits without country code or leading 0 (e.g., 17...)
    canonicalDigits = defaultCountryCode + digits;
  }

  const variants = new Set<string>();
  if (digits) variants.add(digits);
  if (canonicalDigits) {
    variants.add(canonicalDigits);
    variants.add(`+${canonicalDigits}`);
  }
  if (digits) {
    variants.add(`+${digits}`);
  }
  if (raw) {
    variants.add(raw);
  }

  if (digits.startsWith("0")) {
    variants.add(digits.replace(/^0+/, ""));
  }
  if (canonicalDigits.startsWith("880") && canonicalDigits.length === 13) {
    variants.add("0" + canonicalDigits.slice(3));
    variants.add(canonicalDigits.slice(3));
  }

  return {
    waId: canonicalDigits,
    phoneNumber: `+${canonicalDigits}`,
    searchVariants: Array.from(variants).filter(Boolean),
  };
}

/**
 * Finds an existing contact in the workspace using multiple phone variants
 * and suffix regex, and merges any existing duplicate contacts into a single primary contact.
 */
export async function findExistingContactByPhone(
  workspaceId: Types.ObjectId | string,
  rawPhone: string,
): Promise<IWhatsAppContact | null> {
  if (!rawPhone || !rawPhone.trim()) return null;

  const wsObjectId =
    typeof workspaceId === "string"
      ? new Types.ObjectId(workspaceId)
      : workspaceId;
  const { waId, searchVariants } = normalizeWhatsAppPhoneNumber(rawPhone);
  const last10 = waId.slice(-10);

  const filter: Record<string, unknown> = {
    workspaceId: wsObjectId,
    $or: [
      { waId: { $in: searchVariants } },
      { phoneNumber: { $in: searchVariants } },
      ...(last10.length >= 8
        ? [
            { waId: { $regex: `${last10}$` } },
            { phoneNumber: { $regex: `${last10}$` } },
          ]
        : []),
    ],
  };

  // 1. First, attempt findOne (which uses indexes and is properly mocked in offline unit tests)
  const contact = await WhatsAppContact.findOne(filter);
  if (!contact) {
    return null;
  }

  // 2. Only perform multi-document duplicate cleanup when active DB connection is live
  if (mongoose.connection?.readyState === 1) {
    try {
      const contacts = await WhatsAppContact.find(filter).sort({ createdAt: 1 });
      if (contacts && contacts.length > 1) {
        const primaryContact = contacts[0];
        const duplicateContacts = contacts.slice(1);
        const duplicateContactIds = duplicateContacts.map((c) => c._id);

        const primaryConversation = await WhatsAppConversation.findOne({
          workspaceId: wsObjectId,
          contactId: primaryContact._id,
        });

        const duplicateConversations = await WhatsAppConversation.find({
          workspaceId: wsObjectId,
          contactId: { $in: duplicateContactIds },
        });

        for (const dupConv of duplicateConversations) {
          if (primaryConversation) {
            await WhatsAppMessage.updateMany(
              { conversationId: dupConv._id },
              {
                $set: {
                  conversationId: primaryConversation._id,
                  contactId: primaryContact._id,
                },
              },
            );
            await WhatsAppConversation.findByIdAndDelete(dupConv._id);
          } else {
            dupConv.contactId = primaryContact._id as Types.ObjectId;
            await dupConv.save();
          }
        }

        await WhatsAppMessage.updateMany(
          { contactId: { $in: duplicateContactIds } },
          { $set: { contactId: primaryContact._id } },
        );

        await CallLog.updateMany(
          { contactId: { $in: duplicateContactIds } },
          { $set: { contactId: primaryContact._id } },
        );

        for (const dup of duplicateContacts) {
          if (dup.profileName && !primaryContact.profileName) {
            primaryContact.profileName = dup.profileName;
          }
        }

        await WhatsAppContact.deleteMany({ _id: { $in: duplicateContactIds } });
        await primaryContact.save();
        return primaryContact;
      }
    } catch (mergeErr) {
      console.warn(
        "[ContactResolver] Duplicate contact merge notice:",
        mergeErr,
      );
    }
  }

  return contact;
}

/**
 * Strictly finds or creates a contact by phone number.
 * Updates profileName if a new one is provided.
 */
export async function resolveOrCreateWorkspaceContact({
  workspaceId,
  phoneNumber,
  profileName,
  isOptedOut,
  optOutSource,
  optInSource,
  timestamp,
}: {
  workspaceId: Types.ObjectId | string;
  phoneNumber: string;
  profileName?: string;
  isOptedOut?: boolean;
  optOutSource?: "STOP_MESSAGE" | "USER_ACTION" | "API";
  optInSource?: "START_MESSAGE" | "USER_ACTION" | "API";
  timestamp?: Date;
}): Promise<IWhatsAppContact> {
  const wsObjectId =
    typeof workspaceId === "string"
      ? new Types.ObjectId(workspaceId)
      : workspaceId;

  const { waId: canonicalWaId, phoneNumber: canonicalPhone } =
    normalizeWhatsAppPhoneNumber(phoneNumber);

  const existing = await findExistingContactByPhone(wsObjectId, phoneNumber);

  if (existing) {
    let changed = false;

    // Update profileName if provided and newer
    if (
      profileName &&
      profileName.trim() &&
      existing.profileName !== profileName.trim()
    ) {
      existing.profileName = profileName.trim();
      changed = true;
    }

    // Ensure waId and phoneNumber are in canonical format
    if (existing.waId !== canonicalWaId) {
      existing.waId = canonicalWaId;
      changed = true;
    }
    if (!existing.phoneNumber || existing.phoneNumber.startsWith("0")) {
      existing.phoneNumber = canonicalPhone;
      changed = true;
    }

    if (isOptedOut !== undefined) {
      existing.isOptedOut = isOptedOut;
      if (isOptedOut) {
        existing.optOutTimestamp = timestamp || new Date();
        if (optOutSource) existing.optOutSource = optOutSource;
      } else {
        existing.optInTimestamp = timestamp || new Date();
        if (optInSource) existing.optInSource = optInSource;
      }
      changed = true;
    }

    if (changed) {
      await existing.save();
    }

    return existing;
  }

  // Create new contact
  const newContact = await WhatsAppContact.create({
    workspaceId: wsObjectId,
    waId: canonicalWaId,
    phoneNumber: canonicalPhone,
    profileName: profileName?.trim() || undefined,
    isOptedOut: Boolean(isOptedOut),
    optOutTimestamp: isOptedOut ? timestamp || new Date() : undefined,
    optOutSource: isOptedOut ? optOutSource : undefined,
    optInTimestamp:
      !isOptedOut && optInSource ? timestamp || new Date() : undefined,
    optInSource: !isOptedOut ? optInSource : undefined,
    createdAt: timestamp || new Date(),
  });

  return newContact;
}

/**
 * Strictly finds or creates a conversation for a contact in a workspace.
 * If conversation exists, updates account, status, timestamps, and 24h window.
 * Never creates duplicate conversations for the same contact / phone number.
 */
export async function resolveOrCreateWorkspaceConversation({
  workspaceId,
  whatsappAccountId,
  contactId,
  isCustomerMessage = false,
  messageTimestamp,
  isStopKeyword = false,
}: {
  workspaceId: Types.ObjectId | string;
  whatsappAccountId: Types.ObjectId | string;
  contactId: Types.ObjectId | string;
  isCustomerMessage?: boolean;
  messageTimestamp?: Date;
  isStopKeyword?: boolean;
}): Promise<IWhatsAppConversation> {
  const wsObjectId =
    typeof workspaceId === "string"
      ? new Types.ObjectId(workspaceId)
      : workspaceId;
  const accObjectId =
    typeof whatsappAccountId === "string"
      ? new Types.ObjectId(whatsappAccountId)
      : whatsappAccountId;
  const cObjectId =
    typeof contactId === "string" ? new Types.ObjectId(contactId) : contactId;

  const msgDate = messageTimestamp || new Date();
  const conversationStatus = isStopKeyword ? "CLOSED" : "OPEN";

  const expiryDate: Date =
    (getCustomerServiceWindowExpiry
      ? getCustomerServiceWindowExpiry(msgDate)
      : null) ||
    new Date(
      msgDate.getTime() + (CUSTOMER_SERVICE_WINDOW_MS || 24 * 60 * 60 * 1000),
    );

  let conversation = await WhatsAppConversation.findOne({
    workspaceId: wsObjectId,
    contactId: cObjectId,
  });

  if (conversation) {
    conversation.whatsappAccountId = accObjectId;
    conversation.status = conversationStatus;
    conversation.lastMessageAt = msgDate;

    if (isCustomerMessage) {
      conversation.lastCustomerMessageAt = msgDate;
      conversation.isCustomerServiceWindowActive = !isStopKeyword;
      conversation.customerServiceWindowExpiresAt = isStopKeyword
        ? undefined
        : expiryDate;
    } else if (conversation.lastCustomerMessageAt) {
      // Re-evaluate 24h window based on existing lastCustomerMessageAt
      conversation.isCustomerServiceWindowActive = isCustomerServiceWindowOpen(
        conversation.lastCustomerMessageAt,
      );
      conversation.customerServiceWindowExpiresAt =
        getCustomerServiceWindowExpiry(conversation.lastCustomerMessageAt) ??
        undefined;
    }

    await conversation.save();
    return conversation;
  }

  // Create conversation
  conversation = await WhatsAppConversation.create({
    workspaceId: wsObjectId,
    whatsappAccountId: accObjectId,
    contactId: cObjectId,
    status: conversationStatus,
    lastMessageAt: msgDate,
    lastCustomerMessageAt: isCustomerMessage ? msgDate : undefined,
    isCustomerServiceWindowActive: isCustomerMessage && !isStopKeyword,
    customerServiceWindowExpiresAt:
      isCustomerMessage && !isStopKeyword ? expiryDate : undefined,
    createdAt: msgDate,
  });

  return conversation;
}
