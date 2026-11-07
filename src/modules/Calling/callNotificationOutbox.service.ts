import type { Types } from "mongoose";

import CallNotificationOutbox from "./CallNotificationOutbox.js";
import { deliverCallEndedNotification, deliverIncomingCallNotification } from "../../sockets/callSocket.js";


export type IncomingCallPayload = {
  workspaceId: string;
  callId: string;
  name: string;
  phone: string;
  sdpOffer?: string; // WebRTC SDP Offer
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

/**
 * Removes duplicate recipient IDs.
 */
function getUniqueRecipientIds(
  recipientUserIds: Types.ObjectId[],
): Types.ObjectId[] {
  return [
    ...new Map(recipientUserIds.map((id) => [id.toString(), id])).values(),
  ];
}

/**
 * Persist incoming-call notifications and instantly dispatch via Socket.IO.
 */
export async function enqueueIncomingCallNotifications(
  params: CommonNotificationParams & {
    payload: IncomingCallPayload;
  },
): Promise<void> {
  const { workspaceId, callLogId, providerCallId, recipientUserIds, payload } =
    params;

  if (recipientUserIds.length === 0) return;

  const uniqueRecipientIds = getUniqueRecipientIds(recipientUserIds);

  // ১. আউটবক্স ডাটাবেজে ব্যাকআপ হিসেবে সংরক্ষণ
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
            payload,
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    {
      ordered: false,
    },
  );

  // ২. তাৎক্ষণিকভাবে কানেক্টেড ইউজারদের সকেটে ইনকামিং কল ইমিট পাঠানো
  const socketData = {
    notificationId: providerCallId,
    workspaceId: workspaceId.toString(),
    callId: providerCallId,
    callSid: callLogId.toString(),
    name: payload.name,
    phone: payload.phone,
    sdpOffer: payload.sdpOffer,
  };

  await Promise.allSettled(
    uniqueRecipientIds.map(async (recipientUserId) => {
      const delivered = await deliverIncomingCallNotification(
        recipientUserId.toString(),
        socketData,
      );

      if (delivered) {
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
          },
        );
      }
    }),
  );
}

/**
 * Persist call-ended notifications and instantly dispatch via Socket.IO.
 */
export async function enqueueCallEndedNotifications(
  params: CommonNotificationParams & {
    payload: CallEndedPayload;
  },
): Promise<void> {
  const { workspaceId, callLogId, providerCallId, recipientUserIds, payload } =
    params;

  if (recipientUserIds.length === 0) return;

  const uniqueRecipientIds = getUniqueRecipientIds(recipientUserIds);

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
              workspaceId: payload.workspaceId,
              callId: payload.callId,
              endStatus: payload.endStatus,
            },
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    {
      ordered: false,
    },
  );

  const socketData = {
    notificationId: providerCallId,
    workspaceId: workspaceId.toString(),
    callId: providerCallId,
    status: payload.endStatus,
  };

  await Promise.allSettled(
    uniqueRecipientIds.map(async (recipientUserId) => {
      const delivered = await deliverCallEndedNotification(
        recipientUserId.toString(),
        socketData,
      );

      if (delivered) {
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
          },
        );
      }
    }),
  );
}
