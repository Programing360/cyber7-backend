import type { Types } from "mongoose";
import WhatsAppAccount from "../modules/whatsapp/whatsapp.model.js";
import Workspace from "../modules/workspace/workspace.model.js";
import WhatsAppContact from "../modules/whatsapp/contact.model.js";
import Membership from "../modules/workspace/membership.model.js";
import CallLog, { type CallStatus } from "../modules/Calling/CallLog.js";

import User from "../modules/auth/user.model.js";
import { enqueueCallEndedNotifications, enqueueIncomingCallNotifications } from "../modules/Calling/callNotificationOutbox.service.js";

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
}

interface CallIdentity {
  callId: string;
  phoneNumber: string;
  callerName: string;
  callType: CallType;
  startedAt: Date;
}

interface IncomingRecipients {
  userIds: Types.ObjectId[];
  assignmentSource: "ASSIGNED_AGENT" | "OWNER_ADMIN_FALLBACK";
  contactId?: Types.ObjectId;
}

const TERMINAL_STATUSES: CallStatus[] = ["ENDED", "REJECTED", "MISSED", "FAILED"];

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

async function resolveWhatsAppAccount(
  phoneNumberId: string,
): Promise<ResolvedAccount | null> {
  const account = await WhatsAppAccount.findOne({
    phoneNumberId,
    status: "CONNECTED",
  })
    .select("_id workspaceId")
    .lean();

  if (!account?.workspaceId) return null;

  const workspace = await Workspace.findOne({
    _id: account.workspaceId,
    status: "ACTIVE",
  })
    .select("_id")
    .lean();

  if (!workspace) return null;

  return { workspaceId: workspace._id };
}

/**
 * Resolve eligible incoming-call recipients.
 *
 * Priority:
 * 1. Contact's assigned ACTIVE AGENT.
 * 2. If no valid assigned agent, all ACTIVE OWNER/ADMIN members.
 */

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

  // Priority 1: Assigned active AGENT.
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

  // Priority 2: Active OWNER/ADMIN fallback.
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

/**
 * Creates one call log per workspace/provider call ID.
 * Duplicate webhook deliveries do not create duplicate call logs.
 */
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
  contacts?: WhatsAppCallContact[],
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
  };

  if (direction === "USER_INITIATED") {
    const recipients = await resolveIncomingRecipients(
      workspaceId,
      phoneNumber,
    );

    const result = await ensureCallLog(workspaceId, identity, recipients);

    // Use the recipients persisted on the original CallLog.
    // Do not change the routing decision on webhook retries.
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
      logEvent("Incoming call has no eligible recipients", {
        callId,
      });

      return;
    }

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

/**
 * Processes Meta terminate events.
 */

/**
 * Processes Meta terminate events.
 */
async function processTerminateEvent(
  workspaceId: Types.ObjectId,
  event: WhatsAppCallEvent,
  contacts?: WhatsAppCallContact[],
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
    .select("phoneNumber callerName startedAt status")
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
  };

  const { callLogId } = await ensureCallLog(workspaceId, identity);

  const update: Record<string, unknown> = {
    status: isUnanswered ? "MISSED" : isRejected ? "REJECTED" : "ENDED",
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

  // Only incoming calls need agent call-ended notifications.
  if (direction === "USER_INITIATED") {
    // Always read the persisted recipients.
    // This also allows webhook retries to recover failed enqueue attempts.
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

/**
 * Processes business-initiated call progress statuses.
 */
async function processCallStatus(
  workspaceId: Types.ObjectId,
  statusEvent: WhatsAppCallStatus,
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

/**
 * Main webhook processor.
 *
 * Tenant is resolved exclusively from Meta phone_number_id.
 */
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
      await processConnectEvent(account.workspaceId, event, contacts);
      continue;
    }

    if (eventName === "terminate") {
      await processTerminateEvent(account.workspaceId, event, contacts);
      continue;
    }

    if (eventName) {
      logEvent("Unsupported call event ignored", { event: eventName });
    } else {
      logInvalidEvent("Call event has no event name");
    }
  }

  for (const statusEvent of value.statuses ?? []) {
    await processCallStatus(account.workspaceId, statusEvent);
  }
}
