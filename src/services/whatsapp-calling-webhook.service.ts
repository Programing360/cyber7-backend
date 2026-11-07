import type { Types } from "mongoose";
import axios from "axios";
import WhatsAppAccount from "../modules/whatsapp/whatsapp.model.js";
import Workspace from "../modules/workspace/workspace.model.js";
import WhatsAppContact from "../modules/whatsapp/contact.model.js";
import Membership from "../modules/workspace/membership.model.js";
import CallLog, { type CallStatus } from "../modules/Calling/CallLog.js";

import User from "../modules/auth/user.model.js";
import {
  enqueueCallEndedNotifications,
  enqueueIncomingCallNotifications,
} from "../modules/Calling/callNotificationOutbox.service.js";

type CallDirection = "USER_INITIATED" | "BUSINESS_INITIATED";
type CallType = "INCOMING" | "OUTGOING" | "MISSED";

interface WhatsAppCallContact {
  wa_id?: string;
  profile?: {
    name?: string;
  };
}

interface WhatsAppCallSession {
  sdp_type?: string;
  sdp?: string;
}

interface WhatsAppCallEvent {
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
  session?: WhatsAppCallSession;
  reason?: string;
}

interface WhatsAppCallStatus {
  id?: string;
  type?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
}

export interface WhatsAppCallingWebhookValue {
  metadata?: {
    phone_number_id?: string;
    display_phone_number?: string;
  };
  contacts?: WhatsAppCallContact[];
  calls?: WhatsAppCallEvent[];
  statuses?: WhatsAppCallStatus[];
}

interface ResolvedAccount {
  workspaceId: Types.ObjectId;
  accessToken?: string;
  phoneNumberId: string;
}

interface CallIdentity {
  callId: string;
  phoneNumber: string;
  callerName: string;
  callType: CallType;
  startedAt: Date;
  phoneNumberId: string;
}

interface IncomingRecipients {
  userIds: Types.ObjectId[];
  assignmentSource: "ASSIGNED_AGENT" | "OWNER_ADMIN_FALLBACK";
  contactId?: Types.ObjectId;
}

const TERMINAL_STATUSES: CallStatus[] = [
  "ENDED",
  "REJECTED",
  "MISSED",
  "FAILED",
];

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseMetaDate(value?: string): Date | undefined {
  if (!normalizeString(value)) return undefined;

  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    const milliseconds =
      numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  const date = new Date(value!);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeDirection(direction?: string): CallDirection | undefined {
  if (direction === "USER_INITIATED") return "USER_INITIATED";
  if (direction === "BUSINESS_INITIATED") return "BUSINESS_INITIATED";
  return undefined;
}

function normalizeDuration(duration?: number): number | undefined {
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    return undefined;
  }
  return Math.floor(duration);
}

function getCallType(direction: CallDirection): CallType {
  return direction === "USER_INITIATED" ? "INCOMING" : "OUTGOING";
}

function getRemotePhoneNumber(
  direction: CallDirection,
  from?: string,
  to?: string,
): string | undefined {
  return normalizeString(direction === "USER_INITIATED" ? from : to);
}

function getContactName(
  contacts: WhatsAppCallContact[] | undefined,
  phoneNumber: string,
): string {
  const contact = contacts?.find(
    (item) => normalizeString(item.wa_id) === phoneNumber,
  );
  return normalizeString(contact?.profile?.name) ?? "Unknown";
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 11000
  );
}

function logEvent(message: string, metadata?: Record<string, unknown>): void {
  console.info(`[Calling Webhook] ${message}`, metadata ?? {});
}

function logInvalidEvent(reason: string): void {
  console.warn("[Calling Webhook] Event ignored:", { reason });
}

// ---------- Meta Calling Direct API Helpers ----------

/**
 * Meta-কে সাথে সাথে জানান যে এজেন্ট সফটফোন বাজছে (status: ring)।
 * এটি মেটার ৪ সেকেন্ডের অটো-টার্মিনেশন ড্রপ হওয়া বন্ধ করে।
 */
console.log("[DEBUG TOKEN VALUES]:", {
  // passedAccessToken: Boolean(accessToken),
  META_SYSTEM_USER_ACCESS_TOKEN: Boolean(
    process.env.META_SYSTEM_USER_ACCESS_TOKEN,
  ),
  WHATSAPP_ACCESS_TOKEN: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
  META_ACCESS_TOKEN: Boolean(process.env.META_ACCESS_TOKEN),
  // আপনার .env-এ যে নামে টোকেন রেখেছেন তা এখানে দিন, যেমন:
  WHATSAPP_TOKEN: Boolean(process.env.WHATSAPP_TOKEN),
});
export async function sendMetaCallRinging(
  callId: string,
  phoneNumberId?: string,
  accessToken?: string,
): Promise<void> {
  const token =
    accessToken ||
    process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
    process.env.META_SYSTEM_USER_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN;

  if (!token) return;

  const phoneId =
    phoneNumberId || process.env.TEST_PHONE_NUMBER_ID || "1157794877408926";

  try {
    // মেটার WhatsApp Calling সিগন্যালিং ফরম্যাট
    await axios.post(
      `https://graph.facebook.com/v26.0/${phoneId}/calls`,
      {
        messaging_product: "whatsapp",
        call_id: callId,
        status: "ring",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    logEvent("Meta incoming call acknowledged with 'ring'", { callId });
  } catch (error: any) {
    // যদি {phoneId}/calls কাজ না করে তবে বিকল্প কল আইডি পাথ ট্রাই করবে
    try {
      await axios.post(
        `https://graph.facebook.com/v26.0/${callId}`,
        {
          messaging_product: "whatsapp",
          status: "ring",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      logEvent("Meta incoming call acknowledged with 'ring' (direct path)", {
        callId,
      });
    } catch (fallbackError: any) {
      console.error(
        "[Calling Webhook] Failed to acknowledge 'ring' with Meta:",
        error.response?.data || fallbackError.response?.data || error.message,
      );
    }
  }
}

/**
 * ব্রাউজারের তৈরি WebRTC SDP Answer মেটায় পাঠিয়ে কলটি কানেক্ট করা।
 */
export async function acceptMetaCallWithSdp(
  callId: string,
  sdpAnswer: string,
  accessToken?: string,
): Promise<boolean> {
  const token =
    accessToken ||
    process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN ||
    process.env.META_ACCESS_TOKEN;

  if (!token) {
    console.error(
      "[Calling Webhook] Cannot accept call: No access token found.",
    );
    return false;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${callId}`,
      {
        messaging_product: "whatsapp",
        status: "accept",
        session: {
          sdp_type: "answer",
          sdp: sdpAnswer,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.status === 200;
  } catch (error: any) {
    console.error(
      "[Calling Webhook] Failed to accept call with Meta:",
      error.response?.data || error.message,
    );
    return false;
  }
}

// -----------------------------------------------------

async function resolveWhatsAppAccount(
  phoneNumberId: string,
): Promise<ResolvedAccount | null> {
  const account = await WhatsAppAccount.findOne({
    phoneNumberId,
    status: "CONNECTED",
  })
    .select("_id workspaceId accessToken phoneNumberId")
    .lean();

  if (!account?.workspaceId) return null;

  const workspace = await Workspace.findOne({
    _id: account.workspaceId,
    status: "ACTIVE",
  })
    .select("_id")
    .lean();

  if (!workspace) return null;

  return {
    workspaceId: workspace._id,
    accessToken: (account as any).accessToken,
    phoneNumberId,
  };
}

async function resolveIncomingRecipients(
  workspaceId: Types.ObjectId,
  phoneNumber: string,
): Promise<IncomingRecipients> {
  const contact = await WhatsAppContact.findOne({
    workspaceId,
    waId: phoneNumber,
  })
    .select("_id assignedTo")
    .lean();

  // Priority 1: Assigned active AGENT
  if (contact?.assignedTo) {
    const assignedMembership = await Membership.findOne({
      workspaceId,
      userId: contact.assignedTo,
      role: "AGENT",
      status: "ACTIVE",
    })
      .select("userId")
      .lean();

    if (assignedMembership) {
      const activeAgent = await User.findOne({
        _id: assignedMembership.userId,
        isActive: true,
      })
        .select("_id")
        .lean();

      if (activeAgent) {
        return {
          userIds: [activeAgent._id],
          assignmentSource: "ASSIGNED_AGENT",
          contactId: contact._id,
        };
      }
    }
  }

  // Priority 2: Active OWNER/ADMIN fallback
  const adminMemberships = await Membership.find({
    workspaceId,
    role: { $in: ["OWNER", "ADMIN"] },
    status: "ACTIVE",
  })
    .select("userId")
    .lean();

  if (adminMemberships.length === 0) {
    return {
      userIds: [],
      assignmentSource: "OWNER_ADMIN_FALLBACK",
      contactId: contact?._id,
    };
  }

  const adminUserIds = adminMemberships.map((membership) => membership.userId);

  const activeAdmins = await User.find({
    _id: { $in: adminUserIds },
    isActive: true,
  })
    .select("_id")
    .lean();

  return {
    userIds: activeAdmins.map((user) => user._id),
    assignmentSource: "OWNER_ADMIN_FALLBACK",
    contactId: contact?._id,
  };
}

async function ensureCallLog(
  workspaceId: Types.ObjectId,
  identity: CallIdentity,
  incomingRecipients?: IncomingRecipients,
): Promise<{ created: boolean; callLogId: Types.ObjectId }> {
  const insertFields: Record<string, unknown> = {
    workspaceId,
    providerCallId: identity.callId,
    callerName: identity.callerName,
    phoneNumber: identity.phoneNumber,
    phoneNumberId: identity.phoneNumberId, // FIXED: ভবিষ্যতে মেটা কল অ্যাক্সেপ্টের জন্য সেভ রাখা হলো
    callType: identity.callType,
    status: "RINGING",
    startedAt: identity.startedAt,
    durationSeconds: 0,
  };

  if (incomingRecipients) {
    insertFields.ringingUserIds = incomingRecipients.userIds;
    insertFields.assignmentSource = incomingRecipients.assignmentSource;

    if (incomingRecipients.contactId) {
      insertFields.contactId = incomingRecipients.contactId;
    }
  }

  try {
    const result = await CallLog.updateOne(
      {
        workspaceId,
        providerCallId: identity.callId,
      },
      {
        $setOnInsert: insertFields,
      },
      {
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const existingCall = await CallLog.findOne({
      workspaceId,
      providerCallId: identity.callId,
    })
      .select("_id")
      .lean();

    if (!existingCall) {
      throw new Error("CallLog could not be retrieved after upsert.");
    }

    return {
      created: result.upsertedCount === 1,
      callLogId: existingCall._id,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const existingCall = await CallLog.findOne({
      workspaceId,
      providerCallId: identity.callId,
    })
      .select("_id")
      .lean();

    if (!existingCall) {
      throw error;
    }

    return {
      created: false,
      callLogId: existingCall._id,
    };
  }
}

async function updateNonTerminalCall(
  workspaceId: Types.ObjectId,
  callId: string,
  update: Record<string, unknown>,
): Promise<void> {
  await CallLog.updateOne(
    {
      workspaceId,
      providerCallId: callId,
      status: { $nin: TERMINAL_STATUSES },
    },
    { $set: update },
    { runValidators: true },
  );
}

/**
 * Processes incoming and outgoing connect events.
 */
async function processConnectEvent(
  workspaceId: Types.ObjectId,
  event: WhatsAppCallEvent,
  contacts: WhatsAppCallContact[] | undefined,
  phoneNumberId: string,
  accessToken?: string,
): Promise<void> {
  const callId = normalizeString(event.id);
  const direction = normalizeDirection(event.direction);
  const from = normalizeString(event.from);
  const to = normalizeString(event.to);

  if (!callId || !direction || !from || !to) {
    logInvalidEvent("Connect event has missing identity fields");
    return;
  }

  const phoneNumber = getRemotePhoneNumber(direction, from, to);

  if (!phoneNumber) {
    logInvalidEvent("Connect event has no remote phone number");
    return;
  }

  const callerName = getContactName(contacts, phoneNumber);

  const identity: CallIdentity = {
    callId,
    phoneNumber,
    callerName,
    callType: getCallType(direction),
    startedAt: parseMetaDate(event.timestamp) ?? new Date(),
    phoneNumberId,
  };

  if (direction === "USER_INITIATED") {
    // ১. মেটাকে সবার আগে 'ring' স্ট্যাটাস পাঠিয়ে কল ড্রপ হওয়া ঠেকানো
    void sendMetaCallRinging(callId, accessToken);

    const recipients = await resolveIncomingRecipients(
      workspaceId,
      phoneNumber,
    );

    const result = await ensureCallLog(workspaceId, identity, recipients);

    const persistedCall = await CallLog.findOne({
      _id: result.callLogId,
      workspaceId,
    })
      .select("ringingUserIds")
      .lean();

    if (!persistedCall) {
      throw new Error("Incoming CallLog not found after creation.");
    }

    const recipientIds = persistedCall.ringingUserIds ?? [];

    if (recipientIds.length === 0) {
      logEvent("Incoming call has no eligible recipients", { callId });
      return;
    }

    // ২. সকেটের নোটিফিকেশনে মেটার WebRTC SDP অফার যুক্ত করা
    await enqueueIncomingCallNotifications({
      workspaceId,
      callLogId: result.callLogId,
      providerCallId: callId,
      recipientUserIds: recipientIds,
      payload: {
        workspaceId: workspaceId.toString(),
        callId,
        name: callerName,
        phone: phoneNumber,
        sdpOffer: event.session?.sdp, // WebRTC SDP Offer
      },
    });

    logEvent("Incoming call notification enqueued", {
      callId,
      recipientCount: recipientIds.length,
      callLogCreated: result.created,
    });

    return;
  }

  await ensureCallLog(workspaceId, identity);

  await updateNonTerminalCall(workspaceId, callId, {
    callerName,
    phoneNumber,
    status: "CONNECTED",
  });

  logEvent("Outgoing connect event processed");
}

async function processTerminateEvent(
  workspaceId: Types.ObjectId,
  event: WhatsAppCallEvent,
  contacts?: WhatsAppCallContact[],
  phoneNumberId?: string,
): Promise<void> {
  const callId = normalizeString(event.id);
  const direction = normalizeDirection(event.direction);

  if (!callId || !direction) {
    logInvalidEvent("Terminate event has missing call ID or direction");
    return;
  }

  const from = normalizeString(event.from);
  const to = normalizeString(event.to);
  const phoneNumber = getRemotePhoneNumber(direction, from, to);

  const existingCall = await CallLog.findOne({
    workspaceId,
    providerCallId: callId,
  })
    .select("phoneNumber callerName startedAt status phoneNumberId")
    .lean();

  const resolvedPhoneNumber = phoneNumber ?? existingCall?.phoneNumber;

  if (!resolvedPhoneNumber) {
    logInvalidEvent("Terminate event has no resolvable phone number");
    return;
  }

  const contactName = getContactName(contacts, resolvedPhoneNumber);

  const callerName =
    contactName !== "Unknown"
      ? contactName
      : (existingCall?.callerName ?? "Unknown");

  const metaStatus = normalizeString(event.status)?.toUpperCase();
  const duration = normalizeDuration(event.duration);

  const isRejected = metaStatus === "REJECTED";

  const isUnanswered =
    direction === "USER_INITIATED" &&
    (metaStatus === "NO_ANSWER" ||
      metaStatus === "CANCELED" ||
      metaStatus === "CANCELLED" ||
      event.reason === "timeout" ||
      (metaStatus === "COMPLETED" && duration === undefined));

  const callType: CallType = isUnanswered ? "MISSED" : getCallType(direction);

  const endStatus: "MISSED" | "REJECTED" | "ENDED" = isUnanswered
    ? "MISSED"
    : isRejected
      ? "REJECTED"
      : "ENDED";

  const endedAt =
    parseMetaDate(event.end_time) ??
    parseMetaDate(event.timestamp) ??
    new Date();

  const startedAt =
    parseMetaDate(event.start_time) ??
    existingCall?.startedAt ??
    parseMetaDate(event.timestamp) ??
    endedAt;

  const identity: CallIdentity = {
    callId,
    phoneNumber: resolvedPhoneNumber,
    callerName,
    callType,
    startedAt,
    phoneNumberId:
      (phoneNumberId || (existingCall as any)?.phoneNumberId) ?? "",
  };

  const { callLogId } = await ensureCallLog(workspaceId, identity);

  const update: Record<string, unknown> = {
    status: endStatus,
    endedAt,
    callType,
    callerName,
    phoneNumber: resolvedPhoneNumber,
  };

  if (duration !== undefined) {
    update.durationSeconds = duration;
  }

  await CallLog.updateOne(
    {
      _id: callLogId,
      workspaceId,
      status: { $nin: TERMINAL_STATUSES },
    },
    {
      $set: update,
    },
    {
      runValidators: true,
    },
  );

  if (direction === "USER_INITIATED") {
    const savedCall = await CallLog.findOne({
      _id: callLogId,
      workspaceId,
    })
      .select("ringingUserIds")
      .lean();

    const recipientUserIds = savedCall?.ringingUserIds ?? [];

    if (recipientUserIds.length > 0) {
      await enqueueCallEndedNotifications({
        workspaceId,
        callLogId,
        providerCallId: callId,
        recipientUserIds,
        payload: {
          workspaceId: workspaceId.toString(),
          callId,
          endStatus,
        },
      });

      logEvent("Call-ended notifications enqueued", {
        callId,
        recipientCount: recipientUserIds.length,
        endStatus,
      });
    }
  }

  logEvent("Terminate event processed", {
    callType,
    status: isRejected ? "REJECTED" : "ENDED",
    endStatus,
    durationSeconds: duration ?? 0,
  });
}

async function processCallStatus(
  workspaceId: Types.ObjectId,
  statusEvent: WhatsAppCallStatus,
  phoneNumberId: string,
): Promise<void> {
  if (statusEvent.type !== "call") return;

  const callId = normalizeString(statusEvent.id);
  const status = normalizeString(statusEvent.status)?.toUpperCase();

  if (!callId || !status) {
    logInvalidEvent("Call status event is incomplete");
    return;
  }

  const timestamp = parseMetaDate(statusEvent.timestamp) ?? new Date();

  if (status === "RINGING") {
    const recipient = normalizeString(statusEvent.recipient_id);

    if (!recipient) {
      logInvalidEvent("RINGING event has no recipient ID");
      return;
    }

    await ensureCallLog(workspaceId, {
      callId,
      phoneNumber: recipient,
      callerName: "Unknown",
      callType: "OUTGOING",
      startedAt: timestamp,
      phoneNumberId,
    });

    await updateNonTerminalCall(workspaceId, callId, {
      status: "RINGING",
    });

    return;
  }

  if (status === "ACCEPTED") {
    await updateNonTerminalCall(workspaceId, callId, {
      status: "CONNECTED",
    });
    return;
  }

  if (status === "REJECTED") {
    await updateNonTerminalCall(workspaceId, callId, {
      status: "REJECTED",
      endedAt: timestamp,
    });
    return;
  }

  logEvent("Unsupported call status ignored", { status });
}

export async function processWhatsAppCallingWebhook(
  value: WhatsAppCallingWebhookValue,
): Promise<void> {
  const phoneNumberId = normalizeString(value.metadata?.phone_number_id);

  if (!phoneNumberId) {
    logInvalidEvent("Missing metadata.phone_number_id");
    return;
  }

  const account = await resolveWhatsAppAccount(phoneNumberId);

  if (!account) {
    logEvent("No connected account or active workspace found");
    return;
  }

  const contacts = value.contacts ?? [];

  for (const event of value.calls ?? []) {
    const eventName = normalizeString(event.event)?.toLowerCase();

    if (eventName === "connect") {
      await processConnectEvent(
        account.workspaceId,
        event,
        contacts,
        phoneNumberId,
        account.accessToken,
      );
      continue;
    }

    if (eventName === "terminate") {
      await processTerminateEvent(
        account.workspaceId,
        event,
        contacts,
        phoneNumberId,
      );
      continue;
    }

    if (eventName) {
      logEvent("Unsupported call event ignored", { event: eventName });
    } else {
      logInvalidEvent("Call event has no event name");
    }
  }

  for (const statusEvent of value.statuses ?? []) {
    await processCallStatus(account.workspaceId, statusEvent, phoneNumberId);
  }
}
