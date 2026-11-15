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

export interface CreateCallEndMessageOptions {
  forceCompleted?: boolean;
  durationSeconds?: number;
}

/**
 * Inserts or updates a single unified "CALL" message in WhatsAppMessage stream
 * when a call ends or updates its lifecycle, and broadcasts it via Socket.IO.
 */
export async function createCallEndMessage(
  callLogId: Types.ObjectId | string,
  options?: CreateCallEndMessageOptions,
): Promise<void> {
  try {
    let call = null;
    if (mongoose.Types.ObjectId.isValid(callLogId)) {
      call = await CallLog.findById(callLogId);
    }
    if (!call) {
      call = await CallLog.findOne({ providerCallId: String(callLogId) });
    }
    if (!call) return;

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
      let account = null;
      if (call.phoneNumberId) {
        account = await WhatsAppAccount.findOne({
          phoneNumberId: call.phoneNumberId,
          workspaceId: call.workspaceId,
        });
      }
      if (!account) {
        account = await WhatsAppAccount.findOne({
          workspaceId: call.workspaceId,
          status: "CONNECTED",
        });
      }
      if (!account) {
        account = await WhatsAppAccount.findOne({
          workspaceId: call.workspaceId,
        });
      }

      if (!account) {
        console.warn(
          "[CallMessageService] No WhatsAppAccount found for workspace:",
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

    // 3. Compute accurate duration and answered status
    const calculatedDuration =
      options?.durationSeconds !== undefined && options.durationSeconds > 0
        ? options.durationSeconds
        : (call.durationSeconds ?? 0) > 0
          ? call.durationSeconds
          : call.answeredAt && call.endedAt
            ? Math.max(
                0,
                Math.round(
                  (new Date(call.endedAt).getTime() -
                    new Date(call.answeredAt).getTime()) /
                    1000,
                ),
              )
            : 0;

    const isExplicitlyAnswered =
      Boolean(options?.forceCompleted) ||
      call.status === "CONNECTED" ||
      call.status === "ENDED" ||
      calculatedDuration > 0 ||
      Boolean(call.answeredAt) ||
      Boolean((call as any).connectedAt);

    const isCancelled =
      call.status === "CANCELLED" &&
      !call.answeredAt &&
      calculatedDuration === 0;

    const isRejected =
      call.status === "REJECTED" &&
      !call.answeredAt &&
      calculatedDuration === 0;

    const isMissed = isCancelled || isRejected || !isExplicitlyAnswered;

    let text: string;
    let msgType: "voice_call" | "missed_call";

    if (!isMissed) {
      msgType = "voice_call";
      text = `Voice call • ${formatCallDuration(calculatedDuration)}`;
    } else if (isRejected) {
      msgType = "missed_call";
      text = "Declined voice call";
    } else if (isCancelled) {
      msgType = "missed_call";
      text = "Cancelled voice call";
    } else if (call.callType === "OUTGOING") {
      msgType = "missed_call";
      text = "Unanswered voice call";
    } else {
      msgType = "missed_call";
      text = "Missed voice call";
    }

    const direction: "OUTBOUND" | "INBOUND" =
      call.callType === "OUTGOING" ? "OUTBOUND" : "INBOUND";

    // 4. Idempotency & Upsert: Find existing call message for this call
    let existingMsg = await WhatsAppMessage.findOne({
      $or: [
        { callLogId: call._id },
        ...(call.providerCallId
          ? [{ waMessageId: call.providerCallId }]
          : []),
      ],
    });

    let messageDoc = existingMsg;

    if (existingMsg) {
      // Update existing single message in-place
      existingMsg.type = msgType;
      existingMsg.status = "DELIVERED";
      existingMsg.text = text;
      if (call.endedAt) {
        existingMsg.timestamp = call.endedAt;
      }
      if (!existingMsg.callLogId) {
        existingMsg.callLogId = call._id as any;
      }
      if (!existingMsg.waMessageId && call.providerCallId) {
        existingMsg.waMessageId = call.providerCallId;
      }
      await existingMsg.save();
    } else {
      // Insert single new message in WhatsAppMessage collection
      messageDoc = await WhatsAppMessage.create({
        workspaceId: call.workspaceId,
        conversationId: conversation._id,
        contactId: contact._id,
        whatsappAccountId: conversation.whatsappAccountId,
        direction,
        type: msgType,
        status: "DELIVERED",
        text,
        callLogId: call._id,
        waMessageId: call.providerCallId,
        timestamp: call.endedAt || new Date(),
      });
    }

    const finalMessage = messageDoc!;

    // 5. Update conversation timestamp and lastMessage preview
    conversation.lastMessageAt = finalMessage.timestamp;
    (conversation as any).lastMessage = {
      _id: finalMessage._id,
      text: finalMessage.text,
      type: finalMessage.type,
      direction: finalMessage.direction,
      status: finalMessage.status,
      timestamp: finalMessage.timestamp,
    };
    await conversation.save();

    // 6. Broadcast via Socket.IO to connected clients
    const io = getCallSocketIO();
    if (io) {
      const wsId = call.workspaceId.toString();
      const flatPayload = {
        _id: finalMessage._id.toString(),
        workspaceId: wsId,
        conversationId: conversation._id.toString(),
        contactId: contact._id.toString(),
        whatsappAccountId: conversation.whatsappAccountId.toString(),
        direction: finalMessage.direction,
        type: finalMessage.type,
        status: "DELIVERED",
        text: finalMessage.text,
        callLogId: call._id.toString(),
        waMessageId: finalMessage.waMessageId || call.providerCallId,
        timestamp: finalMessage.timestamp.toISOString(),
        createdAt: (finalMessage as any).createdAt
          ? (finalMessage as any).createdAt.toISOString()
          : finalMessage.timestamp.toISOString(),
      };

      // Emit message:updated for in-place update and new-message for initial render
      io.to(wsId).emit(
        (existingMsg ? "message:updated" : "new-message") as any,
        flatPayload,
      );
      io.to(`workspace_${wsId}`).emit(
        (existingMsg ? "message:updated" : "new-message") as any,
        flatPayload,
      );

      console.info(
        `[CallMessageService] Broadcasted single call message (${existingMsg ? "updated" : "created"} - ${msgType}) to workspace ${wsId}`,
      );
    }
  } catch (error) {
    console.error(
      "[CallMessageService] Failed to create or update call end message:",
      error,
    );
  }
}

export const syncCallMessage = createCallEndMessage;
