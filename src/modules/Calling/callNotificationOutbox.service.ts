import type { Types } from "mongoose";

import CallNotificationOutbox from "./CallNotificationOutbox.js";

type IncomingCallPayload = {
  workspaceId: string;
  callId: string;
  name: string;
  phone: string;
};

type CallEndedStatus = "MISSED" | "REJECTED" | "ENDED";

type CallEndedPayload = {
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
 * Persist incoming-call notifications.
 *
 * The unique index prevents duplicate records for the
 * same workspace, provider call, recipient and event.
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
}

/**
 * Persist call-ended notifications for previously eligible recipients.
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
}
