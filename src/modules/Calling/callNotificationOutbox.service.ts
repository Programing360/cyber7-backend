import type { Types } from "mongoose";
import CallNotificationOutbox from "./CallNotificationOutbox.js";
import {
  deliverCallEndedNotification,
  deliverIncomingCallNotification,
  getCallSocketIO,
} from "../../sockets/callSocket.js";

export type IncomingCallPayload = {
  workspaceId: string;
  callId: string;
  name: string;
  phone: string;
  sdpOffer?: string;
  phoneNumberId?: string;
};

export type CallEndedStatus = "MISSED" | "REJECTED" | "ENDED";

export type CallEndedPayload = {
  workspaceId: string;
  callId: string;
  endStatus: CallEndedStatus;
};

type CommonNotificationParams = {
  workspaceId: Types.ObjectId;
  callLogId: Types.ObjectId;
  providerCallId: string;
  recipientUserIds: Types.ObjectId[];
};

function getUniqueRecipientIds(
  recipientUserIds: Types.ObjectId[],
): Types.ObjectId[] {
  return [
    ...new Map(recipientUserIds.map((id) => [id.toString(), id])).values(),
  ];
}

export async function enqueueIncomingCallNotifications(
  params: CommonNotificationParams & {
    payload: IncomingCallPayload;
  },
): Promise<void> {
  const { workspaceId, callLogId, providerCallId, recipientUserIds, payload } =
    params;

  const wsId = workspaceId.toString();
  const uniqueRecipientIds = getUniqueRecipientIds(recipientUserIds);

  const socketData = {
    notificationId: providerCallId,
    workspaceId: wsId,
    callId: providerCallId,
    callSid: callLogId.toString(),
    name: payload.name,
    phone: payload.phone,
    sdpOffer: payload.sdpOffer,
    phoneNumberId: payload.phoneNumberId,
  };

  // Recipient না থাকলে শুধু workspace-scoped fallback।
  // Global io.emit() ব্যবহার করা যাবে না।
  if (uniqueRecipientIds.length === 0) {
    const io = getCallSocketIO();

    io?.to(`workspace_${wsId}`).emit("incoming-call", socketData);
    return;
  }

  // আগে Outbox-এ persist করব, তারপর immediate delivery চেষ্টা করব।
  await CallNotificationOutbox.bulkWrite(
    uniqueRecipientIds.map((recipientUserId) => ({
      updateOne: {
        filter: {
          workspaceId,
          providerCallId,
          recipientUserId,
          eventType: "INCOMING_CALL",
        },
        update: {
          $setOnInsert: {
            workspaceId,
            callLogId,
            providerCallId,
            recipientUserId,
            eventType: "INCOMING_CALL",
            status: "PENDING",
            payload: {
              workspaceId: wsId,
              callId: providerCallId,
              name: payload.name,
              phone: payload.phone,
              sdpOffer: payload.sdpOffer,
              phoneNumberId: payload.phoneNumberId,
            },
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  await Promise.allSettled(
    uniqueRecipientIds.map(async (recipientUserId) => {
      const delivered = await deliverIncomingCallNotification(
        recipientUserId.toString(),
        socketData,
      );

      if (!delivered) return;

      await CallNotificationOutbox.updateOne(
        {
          workspaceId,
          providerCallId,
          recipientUserId,
          eventType: "INCOMING_CALL",
        },
        {
          $set: {
            status: "DELIVERED",
            deliveredAt: new Date(),
          },
          $unset: {
            processingAt: 1,
            leaseExpiresAt: 1,
            lastError: 1,
          },
        },
      );
    }),
  );
}

export async function enqueueCallEndedNotifications(
  params: CommonNotificationParams & {
    payload: CallEndedPayload;
  },
): Promise<void> {
  const { workspaceId, callLogId, providerCallId, recipientUserIds, payload } =
    params;

  const wsId = workspaceId.toString();
  const uniqueRecipientIds = getUniqueRecipientIds(recipientUserIds);

  const socketData = {
    notificationId: providerCallId,
    workspaceId: wsId,
    callId: providerCallId,
    status: payload.endStatus,
  };

  if (uniqueRecipientIds.length === 0) {
    const io = getCallSocketIO();

    io?.to(`workspace_${wsId}`).emit("incoming-call-ended", socketData);
    return;
  }

  await CallNotificationOutbox.bulkWrite(
    uniqueRecipientIds.map((recipientUserId) => ({
      updateOne: {
        filter: {
          workspaceId,
          providerCallId,
          recipientUserId,
          eventType: "CALL_ENDED",
        },
        update: {
          $setOnInsert: {
            workspaceId,
            callLogId,
            providerCallId,
            recipientUserId,
            eventType: "CALL_ENDED",
            status: "PENDING",
            payload: {
              workspaceId: wsId,
              callId: providerCallId,
              endStatus: payload.endStatus,
            },
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  await Promise.allSettled(
    uniqueRecipientIds.map(async (recipientUserId) => {
      const delivered = await deliverCallEndedNotification(
        recipientUserId.toString(),
        socketData,
      );

      if (!delivered) return;

      await CallNotificationOutbox.updateOne(
        {
          workspaceId,
          providerCallId,
          recipientUserId,
          eventType: "CALL_ENDED",
        },
        {
          $set: {
            status: "DELIVERED",
            deliveredAt: new Date(),
          },
          $unset: {
            processingAt: 1,
            leaseExpiresAt: 1,
            lastError: 1,
          },
        },
      );
    }),
  );
}
