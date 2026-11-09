import mongoose, { Types } from "mongoose";
import WhatsAppMessage from "../whatsapp/message.model.js";
import WhatsAppConversation from "../whatsapp/conversation.model.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import CallLog, { type ICallLog } from "../Calling/CallLog.js";
import { getCallSocketIO } from "../../sockets/callSocket.js";

/**
 * Format duration safely as MM:SS or HH:MM:SS
 */
export function formatCallDuration(seconds?: number | null): string {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * Inserts a system "CALL" message into WhatsAppMessage stream when a call ends
 * and broadcasts it via Socket.IO to the workspace room.
 */
export async function createCallEndMessage(
  callLogId: Types.ObjectId | string,
): Promise<void> {
  try {
    const call = await CallLog.findById(callLogId);
    if (!call) return;

    // Idempotency: Prevent duplicate message
    const existingMsg = await WhatsAppMessage.findOne({
      callLogId: call._id,
    });
    if (existingMsg) {
      return;
    }

    const rawNumber = call.phoneNumber || "";
    const cleanNumber = rawNumber.replace(/\D/g, "") || rawNumber;

    if (!cleanNumber) {
      console.warn(
        "[CallMessageService] Cannot create message: Missing phone number for call",
        call._id,
      );
      return;
    }

    // 1. Resolve or find WhatsAppContact
    let contact = null;
    if (call.contactId && mongoose.Types.ObjectId.isValid(call.contactId)) {
      contact = await WhatsAppContact.findOne({
        _id: call.contactId,
        workspaceId: call.workspaceId,
      });
    }

    if (!contact) {
      contact = await WhatsAppContact.findOne({
        workspaceId: call.workspaceId,
        $or: [
          { phoneNumber: rawNumber },
          { phoneNumber: cleanNumber },
          { waId: cleanNumber },
        ],
      });
    }

    if (!contact) {
      contact = await WhatsAppContact.create({
        workspaceId: call.workspaceId,
        phoneNumber: cleanNumber,
        waId: cleanNumber,
        profileName:
          call.callerName && call.callerName !== "Unknown"
            ? call.callerName
            : undefined,
      });
    }

    // 2. Resolve or find WhatsAppConversation
    let conversation = await WhatsAppConversation.findOne({
      workspaceId: call.workspaceId,
      contactId: contact._id,
    });

    if (!conversation) {
      const account = await WhatsAppAccount.findOne({
        workspaceId: call.workspaceId,
        status: "CONNECTED",
      });

      if (!account) {
        console.warn(
          "[CallMessageService] No connected WhatsAppAccount found for workspace:",
          call.workspaceId,
        );
        return;
      }

      conversation = await WhatsAppConversation.create({
        workspaceId: call.workspaceId,
        whatsappAccountId: account._id,
        contactId: contact._id,
        status: "OPEN",
        lastMessageAt: call.endedAt || new Date(),
      });
    }

    // 3. Determine direction, call status, and message text
    const direction: "OUTBOUND" | "INBOUND" =
      call.callType === "OUTGOING" ? "OUTBOUND" : "INBOUND";

    const isMissed =
      call.callType === "MISSED" ||
      call.status === "MISSED" ||
      call.status === "REJECTED" ||
      (call.durationSeconds ?? 0) <= 0;

    let text: string;
    if (isMissed) {
      if (call.status === "REJECTED") {
        text = "Declined voice call";
      } else if (call.callType === "OUTGOING") {
        text = "Unanswered voice call";
      } else {
        text = "Missed voice call";
      }
    } else {
      text = `Voice call • ${formatCallDuration(call.durationSeconds)}`;
    }

    // 4. Insert message in WhatsAppMessage collection
    const message = await WhatsAppMessage.create({
      workspaceId: call.workspaceId,
      conversationId: conversation._id,
      contactId: contact._id,
      whatsappAccountId: conversation.whatsappAccountId,
      direction,
      type: "CALL",
      status: "DELIVERED",
      text,
      callLogId: call._id,
      timestamp: call.endedAt || new Date(),
    });

    // 5. Update conversation timestamp and lastMessage preview
    conversation.lastMessageAt = message.timestamp;
    (conversation as any).lastMessage = {
      _id: message._id,
      text: message.text,
      type: message.type,
      direction: message.direction,
      status: message.status,
      timestamp: message.timestamp,
    };
    await conversation.save();

    // 6. Broadcast via Socket.IO ("new-message")
    // 🔥 ফিক্স: ফ্রন্টএন্ডের সাথে মিলিয়ে ফ্ল্যাট অবজেক্ট পাঠানো
    const io = getCallSocketIO();
    if (io) {
      const wsId = call.workspaceId.toString();
      const flatPayload = {
        _id: message._id.toString(),
        workspaceId: wsId,
        conversationId: conversation._id.toString(),
        contactId: contact._id.toString(),
        whatsappAccountId: conversation.whatsappAccountId.toString(),
        direction: message.direction,
        type: "CALL" as const,
        status: "DELIVERED",
        text: message.text,
        callLogId: call._id.toString(),
        timestamp: message.timestamp.toISOString(),
        createdAt: (message as any).createdAt
          ? (message as any).createdAt.toISOString()
          : message.timestamp.toISOString(),
      };

      io.to(wsId).emit("new-message" as any, flatPayload);
      io.to(`workspace_${wsId}`).emit("new-message" as any, flatPayload);
      console.info(
        `[CallMessageService] Broadcasted call end message to workspace ${wsId}`,
      );
    }
  } catch (error) {
    console.error(
      "[CallMessageService] Failed to create call end message:",
      error,
    );
  }
}
