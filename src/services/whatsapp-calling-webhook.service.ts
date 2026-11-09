import mongoose, { type Types } from "mongoose";
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
import { getCallSocketIO } from "../sockets/callSocket.js";
import { decrypt } from "../utils/encryption.js";

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

export async function acceptMetaCallWithSdp(
  phoneNumberId: string,
  callId: string,
  sdpAnswer: string,
  accessToken?: string,
): Promise<boolean> {
  const token =
    accessToken ||
    process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
    process.env.META_SYSTEM_USER_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN;

  if (!token) {
    console.error(
      "[Calling Webhook] Cannot accept call: No access token found.",
    );
    return false;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/calls`,
      {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "accept",
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

    logEvent("Meta call accepted successfully via Graph API", { callId });
    return response.status === 200;
  } catch (error: any) {
    console.error(
      "[Calling Webhook] Failed to accept call with Meta:",
      error.response?.data || error.message,
    );
    return false;
  }
}

export async function terminateMetaCall(
  phoneNumberId: string,
  callId: string,
  accessToken?: string,
): Promise<boolean> {
  const token =
    accessToken ||
    process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
    process.env.META_SYSTEM_USER_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN;

  if (!token) {
    console.error(
      "[Calling Webhook] Cannot terminate call: No access token found.",
    );
    return false;
  }

  if (/^[a-f\d]{24}$/i.test(callId)) {
    console.warn(
      "[Calling Webhook] Skipping terminate for MongoDB ID:",
      callId,
    );
    return false;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/calls`,
      {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "terminate",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    logEvent("Meta call terminated successfully via Graph API", { callId });
    return response.status === 200;
  } catch (error: any) {
    console.warn(
      "[Calling Webhook] Meta terminate call failed/already ended:",
      error.response?.data?.error?.message || error.message,
    );
    return false;
  }
}

export async function initiateMetaOutgoingCall(
  phoneNumberId: string,
  toPhoneNumber: string,
  sdpOffer: string,
  accessToken?: string,
): Promise<{ success: boolean; callId?: string; sdpAnswer?: string }> {
  const token =
    accessToken ||
    process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
    process.env.META_SYSTEM_USER_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN;

  if (!token) {
    console.error(
      "[Calling Webhook] Cannot initiate call: No access token found.",
    );
    return { success: false };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/calls`,
      {
        messaging_product: "whatsapp",
        to: toPhoneNumber,
        action: "connect",
        session: {
          sdp_type: "offer",
          sdp: sdpOffer,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    const callId = response.data?.calls?.[0]?.id || response.data?.id;
    const sdpAnswer =
      response.data?.calls?.[0]?.session?.sdp || response.data?.session?.sdp;

    return {
      success: true,
      callId,
      sdpAnswer,
    };
  } catch (error: any) {
    console.error(
      "[Calling Webhook] Failed to initiate call with Meta:",
      error.response?.data || error.message,
    );
    return { success: false };
  }
}

async function resolveWhatsAppAccount(
  phoneNumberId: string,
): Promise<ResolvedAccount | null> {
  const cleanPhoneId = phoneNumberId.trim();
  const account = await WhatsAppAccount.findOne({
    phoneNumberId: cleanPhoneId,
    status: "CONNECTED",
  })
    .select("_id workspaceId phoneNumberId +accessTokenEncrypted")
    .lean();

  if (!account?.workspaceId) return null;

  const workspace = await Workspace.findOne({
    _id: account.workspaceId,
    status: "ACTIVE",
  })
    .select("_id")
    .lean();

  if (!workspace) return null;

  let token: string | undefined;
  if (account.accessTokenEncrypted) {
    try {
      token = decrypt(account.accessTokenEncrypted);
    } catch (decryptErr) {
      console.error(
        "[Calling Webhook] Failed to decrypt account access token:",
        decryptErr,
      );
    }
  }

  if (!token) {
    token =
      process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
      process.env.META_SYSTEM_USER_TOKEN ||
      process.env.WHATSAPP_ACCESS_TOKEN;
  }

  return {
    workspaceId: workspace._id,
    accessToken: token,
    phoneNumberId: cleanPhoneId,
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
  const callLogId = new mongoose.Types.ObjectId();

  const insertFields: Record<string, unknown> = {
    _id: callLogId,
    workspaceId,
    providerCallId: identity.callId,
    callSid: callLogId.toString(),
    callerName: identity.callerName,
    phoneNumber: identity.phoneNumber,
    phoneNumberId: identity.phoneNumberId,
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
    const existing = await CallLog.findOne({
      workspaceId,
      providerCallId: identity.callId,
    }).select("_id");

    if (existing) {
      return { created: false, callLogId: existing._id };
    }

    const created = await CallLog.create(insertFields);
    return { created: true, callLogId: created._id };
  } catch (error) {
    const fallback = await CallLog.findOne({
      workspaceId,
      providerCallId: identity.callId,
    }).select("_id");

    if (fallback) {
      return { created: false, callLogId: fallback._id };
    }
    throw error;
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

// async function processConnectEvent(
//   workspaceId: Types.ObjectId,
//   event: WhatsAppCallEvent,
//   contacts: WhatsAppCallContact[] | undefined,
//   phoneNumberId: string,
// ): Promise<void> {
//   const callId = normalizeString(event.id);
//   const direction = normalizeDirection(event.direction);
//   const from = normalizeString(event.from);
//   const to = normalizeString(event.to);

//   if (!callId || !direction || !from || !to) {
//     logInvalidEvent("Connect event has missing identity fields");
//     return;
//   }

//   const phoneNumber = getRemotePhoneNumber(direction, from, to);

//   if (!phoneNumber) {
//     logInvalidEvent("Connect event has no remote phone number");
//     return;
//   }

//   const callerName = getContactName(contacts, phoneNumber);

//   const identity: CallIdentity = {
//     callId,
//     phoneNumber,
//     callerName,
//     callType: getCallType(direction),
//     startedAt: parseMetaDate(event.timestamp) ?? new Date(),
//     phoneNumberId,
//   };

//   const wsId = workspaceId.toString();
//   const io = getCallSocketIO();

//   // ১. ইনকামিং কল (কাস্টমার কল করেছে)
//   if (direction === "USER_INITIATED") {
//     const recipients = await resolveIncomingRecipients(
//       workspaceId,
//       phoneNumber,
//     );

//     const result = await ensureCallLog(workspaceId, identity, recipients);

//     const incomingPayload = {
//       notificationId: callId,
//       callId, // Meta providerCallId (wacid-...)
//       callSid: result.callLogId.toString(), // Database MongoDB _id
//       name: callerName,
//       phone: phoneNumber,
//       workspaceId: wsId,
//       sdpOffer: event.session?.sdp,
//       phoneNumberId,
//     };

//     console.info(
//       `[Calling Webhook DIRECT] 🚀 Broadcasting incoming-call for ${phoneNumber}`,
//     );

//     // 🔥 সরাসরি কোনোরকম বাধা ছাড়াই কানেক্টেড ব্রাউজারে পাঠানো
//     if (io) {
//       io.emit("incoming-call", incomingPayload);
//       io.to(wsId).emit("incoming-call", incomingPayload);
//       io.to(`workspace_${wsId}`).emit("incoming-call", incomingPayload);
//       for (const uid of recipients.userIds) {
//         io.to(`user_${uid.toString()}`).emit("incoming-call", incomingPayload);
//       }
//     } else {
//       console.error("❌ [Calling Webhook] Critical: io instance is NULL!");
//     }

//     try {
//       await enqueueIncomingCallNotifications({
//         workspaceId,
//         callLogId: result.callLogId,
//         providerCallId: callId,
//         recipientUserIds: recipients.userIds,
//         payload: incomingPayload,
//       });
//     } catch (enqueueErr) {
//       console.warn("[Calling Webhook] Enqueue notice error:", enqueueErr);
//     }

//     return;
//   }

//   // ২. আউটগোয়িং কল (ডায়ালিং চলছে)
//   await ensureCallLog(workspaceId, identity);

//   await updateNonTerminalCall(workspaceId, callId, {
//     callerName,
//     phoneNumber,
//     status: "RINGING",
//   });

//   logEvent("Outgoing connect event processed", { callId });

//   // 🔥 আউটগোয়িং কলের WebRTC Answer আসলে ব্রাউজারকে অডিও চালু করার নির্দেশ
//   if (event.session?.sdp && io) {
//     const answerPayload = {
//       workspaceId: wsId,
//       callId,
//       sdp: {
//         type: "answer" as const,
//         sdp: event.session.sdp,
//       },
//     };

//     io.emit("webrtc-answer", answerPayload);
//     io.to(wsId).emit("webrtc-answer", answerPayload);
//     io.to(`workspace_${wsId}`).emit("webrtc-answer", answerPayload);

//     io.emit("call-accepted", { workspaceId: wsId, callId, assignedTo: "" });
//     io.to(wsId).emit("call-accepted", {
//       workspaceId: wsId,
//       callId,
//       assignedTo: "",
//     });
//   }
// }

async function processConnectEvent(
  workspaceId: Types.ObjectId,
  event: WhatsAppCallEvent,
  contacts: WhatsAppCallContact[] | undefined,
  phoneNumberId: string,
): Promise<void> {
  const callId = normalizeString(event.id);
  const direction = normalizeDirection(event.direction);
  const from = normalizeString(event.from);
  const to = normalizeString(event.to);

  // console.log("🔎 [processConnectEvent] Parsed Fields:", {
  //   callId,
  //   direction,
  //   from,
  //   to,
  //   hasSdpOffer: Boolean(event.session?.sdp),
  // });

  if (!callId || !direction || !from || !to) {
    console.warn("⚠️ [processConnectEvent] DROPPED: Missing identity fields!");
    logInvalidEvent("Connect event has missing identity fields");
    return;
  }

  const phoneNumber = getRemotePhoneNumber(direction, from, to);

  if (!phoneNumber) {
    console.warn("⚠️ [processConnectEvent] DROPPED: No remote phone number!");
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

  const wsId = workspaceId.toString();
  if (direction === "USER_INITIATED") {
    const recipients = await resolveIncomingRecipients(
      workspaceId,
      phoneNumber,
    );

    const result = await ensureCallLog(workspaceId, identity, recipients);

    // Duplicate Meta webhook হলে দ্বিতীয়বার notification পাঠাব না।
    if (!result.created) {
      logEvent("Duplicate incoming connect event ignored", { callId });
      return;
    }

    const incomingPayload = {
      notificationId: callId,
      callId,
      callSid: result.callLogId.toString(),
      name: callerName,
      phone: phoneNumber,
      workspaceId: wsId,
      sdpOffer: event.session?.sdp,
      phoneNumberId,
    };

    await enqueueIncomingCallNotifications({
      workspaceId,
      callLogId: result.callLogId,
      providerCallId: callId,
      recipientUserIds: recipients.userIds,
      payload: incomingPayload,
    });

    logEvent("Incoming call notification queued", {
      callId,
      recipients: recipients.userIds.length,
      hasSdpOffer: Boolean(event.session?.sdp),
    });

    return;
  }

  // ২. আউটগোয়িং কল (ডায়ালিং চলছে)
  // console.log(
  //   "📱 [processConnectEvent] >>> BUSINESS_INITIATED (OUTGOING CALL) <<<",
  // );

  const result = await ensureCallLog(workspaceId, identity);

  await updateNonTerminalCall(workspaceId, callId, {
    callerName,
    phoneNumber,
    status: "RINGING",
  });

  logEvent("Outgoing connect event processed", { callId });

  if (event.session?.sdp) {
    const call = await CallLog.findOne({
      _id: result.callLogId,
      workspaceId,
    })
      .select("assignedTo")
      .lean();

    const assignedTo = call?.assignedTo?.toString();

    if (assignedTo) {
      const io = getCallSocketIO();

      if (io) {
        io.to(`user_${assignedTo}`).emit("webrtc-answer", {
          workspaceId: wsId,
          callId,
          sdp: {
            type: "answer",
            sdp: event.session.sdp,
          },
        });

        io.to(`user_${assignedTo}`).emit("call-accepted", {
          workspaceId: wsId,
          callId,
          assignedTo,
        });
      }
    }
  }

  logEvent("Outgoing connect event processed", { callId });
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
    .select(
      "phoneNumber callerName startedAt status phoneNumberId ringingUserIds assignedTo",
    )
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

  const wsId = workspaceId.toString();

  if (direction === "USER_INITIATED") {
    const recipientUserIds = existingCall?.ringingUserIds ?? [];

    await enqueueCallEndedNotifications({
      workspaceId,
      callLogId,
      providerCallId: callId,
      recipientUserIds,
      payload: {
        workspaceId: wsId,
        callId,
        endStatus,
      },
    });
  } else if (existingCall?.assignedTo) {
    const io = getCallSocketIO();

    io?.to(`user_${existingCall.assignedTo.toString()}`).emit(
      "incoming-call-ended",
      {
        notificationId: callId,
        workspaceId: wsId,
        callId,
        status: endStatus,
      },
    );
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
  const wsId = workspaceId.toString();
  const io = getCallSocketIO();
  console.log(status, "callId", callId);
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

    const call = await CallLog.findOne({
      workspaceId,
      providerCallId: callId,
    })
      .select("assignedTo")
      .lean();

    if (call?.assignedTo) {
      const io = getCallSocketIO();

      io?.to(`user_${call.assignedTo.toString()}`).emit("call-accepted", {
        workspaceId: wsId,
        callId,
        assignedTo: call.assignedTo.toString(),
      });
    }

    logEvent("Outgoing call accepted", { callId });

    return;
  }

  if (status === "REJECTED") {
    await updateNonTerminalCall(workspaceId, callId, {
      status: "REJECTED",
      endedAt: timestamp,
    });

    const call = await CallLog.findOne({
      workspaceId,
      providerCallId: callId,
    })
      .select("assignedTo")
      .lean();

    if (call?.assignedTo) {
      const io = getCallSocketIO();

      io?.to(`user_${call.assignedTo.toString()}`).emit("incoming-call-ended", {
        notificationId: callId,
        workspaceId: wsId,
        callId,
        status: "REJECTED",
      });
    }

    return;
  }

  logEvent("Unsupported call status ignored", { status });
}

// export async function processWhatsAppCallingWebhook(
//   value: WhatsAppCallingWebhookValue,
// ): Promise<void> {
//   // console.log("hello");
//   const phoneNumberId = normalizeString(value.metadata?.phone_number_id);
//   // console.log(phoneNumberId);
//   if (!phoneNumberId) {
//     logInvalidEvent("Missing metadata.phone_number_id");
//     return;
//   }

//   const account = await resolveWhatsAppAccount(phoneNumberId);

//   if (!account) {
//     logEvent(
//       "No connected account or active workspace found for phone number ID",
//       {
//         phoneNumberId,
//       },
//     );
//     return;
//   }

//   const contacts = value.contacts ?? [];

//   for (const event of value.calls ?? []) {
//     const eventName = normalizeString(event.event)?.toLowerCase();

//     console.log(eventName);

//     if (eventName === "connect") {
//       await processConnectEvent(
//         account.workspaceId,
//         event,
//         contacts,
//         phoneNumberId,
//       );
//       continue;
//     }

//     if (eventName === "terminate") {
//       await processTerminateEvent(
//         account.workspaceId,
//         event,
//         contacts,
//         phoneNumberId,
//       );
//       continue;
//     }

//     if (eventName) {
//       logEvent("Unsupported call event ignored", { event: eventName });
//     } else {
//       logInvalidEvent("Call event has no event name");
//     }
//   }

//   for (const statusEvent of value.statuses ?? []) {
//     await processCallStatus(account.workspaceId, statusEvent, phoneNumberId);
//   }
// }

export async function processWhatsAppCallingWebhook(
  value: WhatsAppCallingWebhookValue,
): Promise<void> {
  const phoneNumberId = normalizeString(value.metadata?.phone_number_id);

  console.log("\n========================================================");
  console.log("📥 [Calling Webhook] Webhook Received!");
  console.log("📱 [Calling Webhook] Phone Number ID:", phoneNumberId);
  console.log(
    "📦 [Calling Webhook] Calls Array Length:",
    value.calls?.length || 0,
  );
  console.log(
    "📊 [Calling Webhook] Statuses Array Length:",
    value.statuses?.length || 0,
  );

  if (!phoneNumberId) {
    logInvalidEvent("Missing metadata.phone_number_id");
    return;
  }

  const account = await resolveWhatsAppAccount(phoneNumberId);

  if (!account) {
    console.error(
      "❌ [Calling Webhook] No connected account found for phone number ID:",
      phoneNumberId,
    );
    return;
  }

  console.log(
    "🏢 [Calling Webhook] Resolved Workspace ID:",
    account.workspaceId.toString(),
  );

  const contacts = value.contacts ?? [];

  for (const event of value.calls ?? []) {
    const eventName = normalizeString(event.event)?.toLowerCase();
    console.log(
      `🔍 [Calling Webhook] Processing event: "${eventName}" | Call ID: ${event.id} | Direction: ${event.direction}`,
    );

    if (eventName === "connect") {
      console.log("🚀 [Calling Webhook] ROUTING TO => processConnectEvent()");
      await processConnectEvent(
        account.workspaceId,
        event,
        contacts,
        phoneNumberId,
      );
      continue;
    }

    if (eventName === "terminate") {
      console.log("🛑 [Calling Webhook] ROUTING TO => processTerminateEvent()");
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
  console.log("========================================================\n");
}
