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
import { createCallEndMessage } from "../modules/services/call-message.service.js";
import { findExistingContactByPhone } from "../modules/whatsapp/whatsapp-contact-resolver.service.js";

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
  "CANCELLED",
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
  const contact =
    (await findExistingContactByPhone(workspaceId, phoneNumber)) ||
    (await WhatsAppContact.findOne({
      workspaceId,
      waId: phoneNumber,
    })
      .select("_id assignedTo")
      .lean());

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
  const insertFields: Record<string, unknown> = {
    workspaceId,
    providerCallId: identity.callId,
    callSid: new mongoose.Types.ObjectId().toString(),
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
      },
    );

    const call = await CallLog.findOne({
      workspaceId,
      providerCallId: identity.callId,
    })
      .select("_id")
      .lean();

    if (!call) {
      throw new Error("Failed to create or retrieve CallLog.");
    }

    return {
      created: result.upsertedCount === 1,
      callLogId: call._id,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const existing = await CallLog.findOne({
      workspaceId,
      providerCallId: identity.callId,
    })
      .select("_id")
      .lean();

    if (!existing) throw error;

    return {
      created: false,
      callLogId: existing._id,
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
    const io = getCallSocketIO();

    if (io) {
      const sdpPayload = {
        workspaceId: wsId,
        callId,
        sdp: {
          type: "answer" as const,
          sdp: event.session.sdp,
        },
      };

      const ringingPayload = {
        workspaceId: wsId,
        callId,
      };

      if (assignedTo) {
        io.to(`user_${assignedTo}`).emit("webrtc-answer", sdpPayload);
        io.to(`user_${assignedTo}`).emit("call:ringing" as any, ringingPayload);
        io.to(`user_${assignedTo}`).emit("call-ringing" as any, ringingPayload);
      }
      io.to(wsId).emit("webrtc-answer", sdpPayload);
      io.to(`workspace_${wsId}`).emit("webrtc-answer", sdpPayload);
      io.to(wsId).emit("call:ringing" as any, ringingPayload);
      io.to(`workspace_${wsId}`).emit("call:ringing" as any, ringingPayload);
    }
  }

  logEvent("Outgoing connect event processed", { callId });
}

async function processRingingEvent(
  workspaceId: Types.ObjectId,
  event: WhatsAppCallEvent,
  phoneNumberId?: string,
): Promise<void> {
  const callId = normalizeString(event.id);
  if (!callId) return;

  const wsId = workspaceId.toString();
  const io = getCallSocketIO();

  await updateNonTerminalCall(workspaceId, callId, {
    status: "RINGING",
  });

  const call = await CallLog.findOne({
    workspaceId,
    providerCallId: callId,
  })
    .select("assignedTo")
    .lean();

  if (io) {
    const ringingData = { workspaceId: wsId, callId };
    io.to(wsId).emit("call:ringing" as any, ringingData);
    io.to(`workspace_${wsId}`).emit("call:ringing" as any, ringingData);
    if (call?.assignedTo) {
      io.to(`user_${call.assignedTo.toString()}`).emit(
        "call:ringing" as any,
        ringingData,
      );
      io.to(`user_${call.assignedTo.toString()}`).emit(
        "call-ringing" as any,
        ringingData,
      );
    }
  }

  logEvent("Call ringing event processed", { callId });
}

async function processCallAcceptedEvent(
  workspaceId: Types.ObjectId,
  event: WhatsAppCallEvent,
  phoneNumberId?: string,
): Promise<void> {
  const callId = normalizeString(event.id);
  if (!callId) return;

  const wsId = workspaceId.toString();
  const io = getCallSocketIO();

  const call = await CallLog.findOne({
    workspaceId,
    providerCallId: callId,
  })
    .select("_id callType assignedTo ringingUserIds")
    .lean();

  const answeredAt = parseMetaDate(event.timestamp) ?? new Date();

  if (call?.callType === "OUTGOING") {
    await updateNonTerminalCall(workspaceId, callId, {
      status: "CONNECTED",
      answeredAt,
    });

    const assignedTo = call.assignedTo?.toString() || "";

    if (io) {
      const acceptedData = {
        workspaceId: wsId,
        callId,
        assignedTo,
      };

      if (assignedTo) {
        io.to(`user_${assignedTo}`).emit("call-accepted", acceptedData);
        io.to(`user_${assignedTo}`).emit("call:accepted" as any, acceptedData);
        io.to(`user_${assignedTo}`).emit("call:connected" as any, acceptedData);
        io.to(`user_${assignedTo}`).emit("call-connected" as any, acceptedData);
      }
      io.to(wsId).emit("call-accepted", acceptedData);
      io.to(`workspace_${wsId}`).emit("call-accepted", acceptedData);
      io.to(`workspace_${wsId}`).emit("call:connected" as any, acceptedData);
    }

    logEvent("Outgoing call accepted", { callId, assignedTo });
    return;
  }

  // Incoming call accepted:
  if (call?.callType === "INCOMING") {
    if (call.assignedTo) {
      await updateNonTerminalCall(workspaceId, callId, {
        status: "CONNECTED",
        answeredAt,
      });

      const assignedTo = call.assignedTo.toString();
      if (io) {
        const acceptedData = {
          workspaceId: wsId,
          callId,
          assignedTo,
        };
        io.to(`user_${assignedTo}`).emit("call-accepted", acceptedData);
        io.to(`user_${assignedTo}`).emit("call:connected" as any, acceptedData);
      }
    } else {
      // Incoming call accepted on mobile device!
      await updateNonTerminalCall(workspaceId, callId, {
        status: "ENDED",
        answeredAt,
      });

      if (io) {
        const answeredElsewhereData = {
          workspaceId: wsId,
          callId,
          reason: "answered_elsewhere",
        };
        io.to(wsId).emit("call:answered_elsewhere" as any, answeredElsewhereData);
        io.to(`workspace_${wsId}`).emit(
          "call:answered_elsewhere" as any,
          answeredElsewhereData,
        );
        io.to(wsId).emit("call-taken", {
          workspaceId: wsId,
          callId,
          assignedTo: "mobile",
        });
        io.to(`workspace_${wsId}`).emit("call-taken", {
          workspaceId: wsId,
          callId,
          assignedTo: "mobile",
        });
        io.to(wsId).emit("incoming-call-ended", {
          notificationId: callId,
          workspaceId: wsId,
          callId,
          status: "ENDED",
        });
        io.to(`workspace_${wsId}`).emit("incoming-call-ended", {
          notificationId: callId,
          workspaceId: wsId,
          callId,
          status: "ENDED",
        });

        for (const uid of call.ringingUserIds ?? []) {
          io.to(`user_${uid.toString()}`).emit(
            "call:answered_elsewhere" as any,
            answeredElsewhereData,
          );
          io.to(`user_${uid.toString()}`).emit("call-taken", {
            workspaceId: wsId,
            callId,
            assignedTo: "mobile",
          });
          io.to(`user_${uid.toString()}`).emit("incoming-call-ended", {
            notificationId: callId,
            workspaceId: wsId,
            callId,
            status: "ENDED",
          });
        }
      }

      await createCallEndMessage(call._id, { forceCompleted: true });
      logEvent("Incoming call answered on mobile device (ACCEPTED event)", {
        callId,
      });
    }
  }
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
  const reason = normalizeString(event.reason)?.toLowerCase() || "";
  const duration = normalizeDuration(event.duration);

  const isAnsweredElsewhere =
    reason.includes("elsewhere") ||
    reason.includes("claimed") ||
    reason === "accepted_elsewhere" ||
    reason === "answered_elsewhere" ||
    metaStatus === "ACCEPTED_ELSEWHERE" ||
    metaStatus === "ANSWERED_ELSEWHERE" ||
    metaStatus === "CONNECTED_ELSEWHERE";

  const isRejected =
    metaStatus === "REJECTED" ||
    reason === "rejected" ||
    reason === "declined";

  const isCancelled =
    metaStatus === "CANCELED" ||
    metaStatus === "CANCELLED" ||
    reason === "canceled" ||
    reason === "cancelled" ||
    reason === "timeout";

  // A call was answered ONLY if explicitly confirmed answered by recipient
  const hasAnsweredTimestamp = Boolean(existingCall?.answeredAt);
  const wasAnswered =
    isAnsweredElsewhere ||
    hasAnsweredTimestamp ||
    (existingCall?.status === "CONNECTED" && duration !== undefined && duration > 0);

  const endedAt =
    parseMetaDate(event.end_time) ??
    parseMetaDate(event.timestamp) ??
    new Date();

  const startedAt =
    parseMetaDate(event.start_time) ??
    existingCall?.startedAt ??
    parseMetaDate(event.timestamp) ??
    endedAt;

  // Strict Duration Invariant:
  // If call was never answered, duration MUST be 0 (never calculate endedAt - startedAt ringing time).
  // If answered, duration is calculated from endedAt - answeredAt.
  const calculatedDuration =
    wasAnswered
      ? duration !== undefined && duration > 0
        ? duration
        : existingCall?.answeredAt
          ? Math.max(
              1,
              Math.floor(
                (endedAt.getTime() - new Date(existingCall.answeredAt).getTime()) /
                  1000,
              ),
            )
          : 0
      : 0;

  const isUnanswered = !wasAnswered;

  const callType: CallType =
    direction === "USER_INITIATED" && isUnanswered
      ? "MISSED"
      : getCallType(direction);

  const endStatus: "MISSED" | "REJECTED" | "ENDED" | "CANCELLED" = isRejected
    ? "REJECTED"
    : wasAnswered
      ? "ENDED"
      : isCancelled || direction === "BUSINESS_INITIATED"
        ? "CANCELLED"
        : "MISSED";

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
    status: endStatus === "CANCELLED" ? "CANCELLED" : endStatus,
    endedAt,
    callType,
    callerName,
    phoneNumber: resolvedPhoneNumber,
    durationSeconds: calculatedDuration,
    ...(isAnsweredElsewhere && !existingCall?.answeredAt ? { answeredAt: endedAt } : {}),
  };

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
  const io = getCallSocketIO();

  if (direction === "USER_INITIATED") {
    const recipientUserIds = existingCall?.ringingUserIds ?? [];

    if (isAnsweredElsewhere) {
      if (io) {
        const answeredElsewhereData = {
          workspaceId: wsId,
          callId,
          reason: "answered_elsewhere",
        };
        io.to(wsId).emit("call:answered_elsewhere" as any, answeredElsewhereData);
        io.to(`workspace_${wsId}`).emit(
          "call:answered_elsewhere" as any,
          answeredElsewhereData,
        );
        io.to(wsId).emit("call-taken", {
          workspaceId: wsId,
          callId,
          assignedTo: "mobile",
        });
        io.to(`workspace_${wsId}`).emit("call-taken", {
          workspaceId: wsId,
          callId,
          assignedTo: "mobile",
        });
        io.to(wsId).emit("incoming-call-ended", {
          notificationId: callId,
          workspaceId: wsId,
          callId,
          status: "ENDED",
        });
        io.to(`workspace_${wsId}`).emit("incoming-call-ended", {
          notificationId: callId,
          workspaceId: wsId,
          callId,
          status: "ENDED",
        });
        for (const uid of recipientUserIds) {
          io.to(`user_${uid.toString()}`).emit(
            "call:answered_elsewhere" as any,
            answeredElsewhereData,
          );
          io.to(`user_${uid.toString()}`).emit("call-taken", {
            workspaceId: wsId,
            callId,
            assignedTo: "mobile",
          });
          io.to(`user_${uid.toString()}`).emit("incoming-call-ended", {
            notificationId: callId,
            workspaceId: wsId,
            callId,
            status: "ENDED",
          });
        }
      }
    } else {
      if (io) {
        const termPayload = {
          notificationId: callId,
          workspaceId: wsId,
          callId,
          status: endStatus,
        };
        io.to(wsId).emit("incoming-call-ended", termPayload);
        io.to(`workspace_${wsId}`).emit("incoming-call-ended", termPayload);
        for (const uid of recipientUserIds) {
          io.to(`user_${uid.toString()}`).emit("incoming-call-ended", termPayload);
        }
      }
    }

    await enqueueCallEndedNotifications({
      workspaceId,
      callLogId,
      providerCallId: callId,
      recipientUserIds,
      payload: {
        workspaceId: wsId,
        callId,
        endStatus: endStatus === "CANCELLED" ? "MISSED" : endStatus,
      },
    });
  } else {
    if (io) {
      const termPayload = {
        notificationId: callId,
        workspaceId: wsId,
        callId,
        status: endStatus,
      };
      io.to(wsId).emit("incoming-call-ended", termPayload);
      io.to(`workspace_${wsId}`).emit("incoming-call-ended", termPayload);
      if (existingCall?.assignedTo) {
        io.to(`user_${existingCall.assignedTo.toString()}`).emit(
          "incoming-call-ended",
          termPayload,
        );
      }
    }
  }

  // Create or update chat history message bubble & notify inbox
  await createCallEndMessage(callLogId, {
    forceCompleted: wasAnswered,
    durationSeconds: calculatedDuration,
  });

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

  if (status === "RINGING") {
    const recipient = normalizeString(statusEvent.recipient_id);

    if (recipient) {
      await ensureCallLog(workspaceId, {
        callId,
        phoneNumber: recipient,
        callerName: "Unknown",
        callType: "OUTGOING",
        startedAt: timestamp,
        phoneNumberId,
      });
    }

    await updateNonTerminalCall(workspaceId, callId, {
      status: "RINGING",
    });

    const call = await CallLog.findOne({
      workspaceId,
      providerCallId: callId,
    })
      .select("assignedTo")
      .lean();

    if (io) {
      const ringingData = { workspaceId: wsId, callId };
      io.to(wsId).emit("call:ringing" as any, ringingData);
      io.to(`workspace_${wsId}`).emit("call:ringing" as any, ringingData);
      if (call?.assignedTo) {
        io.to(`user_${call.assignedTo.toString()}`).emit(
          "call:ringing" as any,
          ringingData,
        );
        io.to(`user_${call.assignedTo.toString()}`).emit(
          "call-ringing" as any,
          ringingData,
        );
      }
    }

    logEvent("Call status RINGING processed", { callId });
    return;
  }

  if (status === "ACCEPTED" || status === "CONNECTED") {
    const call = await CallLog.findOne({
      workspaceId,
      providerCallId: callId,
    })
      .select("_id callType assignedTo ringingUserIds")
      .lean();

    if (call?.callType === "OUTGOING") {
      await updateNonTerminalCall(workspaceId, callId, {
        status: "CONNECTED",
        answeredAt: new Date(),
      });

      const assignedTo = call.assignedTo?.toString() || "";

      if (io) {
        const acceptedData = {
          workspaceId: wsId,
          callId,
          assignedTo,
        };

        if (assignedTo) {
          io.to(`user_${assignedTo}`).emit("call-accepted", acceptedData);
          io.to(`user_${assignedTo}`).emit("call:accepted" as any, acceptedData);
          io.to(`user_${assignedTo}`).emit("call:connected" as any, acceptedData);
          io.to(`user_${assignedTo}`).emit("call-connected" as any, acceptedData);
        }
        io.to(wsId).emit("call-accepted", acceptedData);
        io.to(`workspace_${wsId}`).emit("call-accepted", acceptedData);
        io.to(`workspace_${wsId}`).emit("call:connected" as any, acceptedData);
      }

      logEvent("Outgoing call accepted", { callId, assignedTo });
      return;
    }

    if (call?.callType === "INCOMING") {
      if (call.assignedTo) {
        await updateNonTerminalCall(workspaceId, callId, {
          status: "CONNECTED",
          answeredAt: new Date(),
        });

        const assignedTo = call.assignedTo.toString();
        if (io) {
          const acceptedData = {
            workspaceId: wsId,
            callId,
            assignedTo,
          };
          io.to(`user_${assignedTo}`).emit("call-accepted", acceptedData);
          io.to(`user_${assignedTo}`).emit("call:connected" as any, acceptedData);
        }
      } else {
        // Incoming call answered on mobile device!
        await updateNonTerminalCall(workspaceId, callId, {
          status: "ENDED",
          answeredAt: new Date(),
        });

        if (io) {
          const answeredElsewhereData = {
            workspaceId: wsId,
            callId,
            reason: "answered_elsewhere",
          };
          io.to(wsId).emit("call:answered_elsewhere" as any, answeredElsewhereData);
          io.to(`workspace_${wsId}`).emit(
            "call:answered_elsewhere" as any,
            answeredElsewhereData,
          );
          io.to(wsId).emit("call-taken", {
            workspaceId: wsId,
            callId,
            assignedTo: "mobile",
          });
          io.to(`workspace_${wsId}`).emit("call-taken", {
            workspaceId: wsId,
            callId,
            assignedTo: "mobile",
          });
          io.to(wsId).emit("incoming-call-ended", {
            notificationId: callId,
            workspaceId: wsId,
            callId,
            status: "ENDED",
          });
          io.to(`workspace_${wsId}`).emit("incoming-call-ended", {
            notificationId: callId,
            workspaceId: wsId,
            callId,
            status: "ENDED",
          });

          for (const uid of call.ringingUserIds ?? []) {
            io.to(`user_${uid.toString()}`).emit(
              "call:answered_elsewhere" as any,
              answeredElsewhereData,
            );
            io.to(`user_${uid.toString()}`).emit("call-taken", {
              workspaceId: wsId,
              callId,
              assignedTo: "mobile",
            });
            io.to(`user_${uid.toString()}`).emit("incoming-call-ended", {
              notificationId: callId,
              workspaceId: wsId,
              callId,
              status: "ENDED",
            });
          }
        }

        await createCallEndMessage(call._id, { forceCompleted: true });
        logEvent("Incoming call answered on mobile device (ACCEPTED status)", {
          callId,
        });
      }
      return;
    }
  }

  if (
    status === "ACCEPTED_ELSEWHERE" ||
    status === "ANSWERED_ELSEWHERE" ||
    status === "CONNECTED_ELSEWHERE"
  ) {
    const call = await CallLog.findOne({
      workspaceId,
      providerCallId: callId,
    })
      .select("_id callType ringingUserIds")
      .lean();

    await updateNonTerminalCall(workspaceId, callId, {
      status: "ENDED",
      answeredAt: new Date(),
    });

    if (io) {
      const answeredElsewhereData = {
        workspaceId: wsId,
        callId,
        reason: "answered_elsewhere",
      };
      io.to(wsId).emit("call:answered_elsewhere" as any, answeredElsewhereData);
      io.to(`workspace_${wsId}`).emit(
        "call:answered_elsewhere" as any,
        answeredElsewhereData,
      );
      io.to(wsId).emit("call-taken", {
        workspaceId: wsId,
        callId,
        assignedTo: "mobile",
      });
      io.to(`workspace_${wsId}`).emit("call-taken", {
        workspaceId: wsId,
        callId,
        assignedTo: "mobile",
      });
      io.to(wsId).emit("incoming-call-ended", {
        notificationId: callId,
        workspaceId: wsId,
        callId,
        status: "ENDED",
      });
      io.to(`workspace_${wsId}`).emit("incoming-call-ended", {
        notificationId: callId,
        workspaceId: wsId,
        callId,
        status: "ENDED",
      });

      for (const uid of call?.ringingUserIds ?? []) {
        io.to(`user_${uid.toString()}`).emit(
          "call:answered_elsewhere" as any,
          answeredElsewhereData,
        );
        io.to(`user_${uid.toString()}`).emit("call-taken", {
          workspaceId: wsId,
          callId,
          assignedTo: "mobile",
        });
        io.to(`user_${uid.toString()}`).emit("incoming-call-ended", {
          notificationId: callId,
          workspaceId: wsId,
          callId,
          status: "ENDED",
        });
      }
    }

    if (call?._id) {
      await createCallEndMessage(call._id, { forceCompleted: true });
    }

    logEvent("Call answered elsewhere processed", { callId });
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
      .select("_id assignedTo ringingUserIds")
      .lean();

    if (call?._id) {
      await createCallEndMessage(call._id);
    }

    if (io) {
      const rejPayload = {
        notificationId: callId,
        workspaceId: wsId,
        callId,
        status: "REJECTED" as const,
      };
      io.to(wsId).emit("incoming-call-ended", rejPayload);
      io.to(`workspace_${wsId}`).emit("incoming-call-ended", rejPayload);
      if (call?.assignedTo) {
        io.to(`user_${call.assignedTo.toString()}`).emit(
          "incoming-call-ended",
          rejPayload,
        );
      }
      for (const uid of call?.ringingUserIds ?? []) {
        io.to(`user_${uid.toString()}`).emit("incoming-call-ended", rejPayload);
      }
    }

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
    console.error(
      "❌ [Calling Webhook] No connected account found for phone number ID:",
      phoneNumberId,
    );
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

    if (eventName === "ringing") {
      await processRingingEvent(
        account.workspaceId,
        event,
        phoneNumberId,
      );
      continue;
    }

    if (
      eventName === "accepted" ||
      eventName === "answered" ||
      eventName === "connected"
    ) {
      await processCallAcceptedEvent(
        account.workspaceId,
        event,
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
