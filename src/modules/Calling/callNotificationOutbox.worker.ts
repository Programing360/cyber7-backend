import CallNotificationOutbox from "./CallNotificationOutbox.js";
import {
  deliverIncomingCallNotification,
  deliverCallEndedNotification,
} from "../../sockets/callSocket.js";

const MAX_ATTEMPTS = 10;
const LEASE_DURATION_MS = 30_000;

function backoffSeconds(attempts: number): number {
  return Math.min(30 * Math.pow(2, attempts), 3600);
}

export async function processCallNotificationOutbox(batchSize = 50): Promise<{
  processed: number;
  delivered: number;
  failed: number;
  skipped: number;
}> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_DURATION_MS);

  let processed = 0;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  const candidates = await CallNotificationOutbox.find({
    $or: [
      {
        status: "PENDING",
        nextAttemptAt: { $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      {
        status: "PROCESSING",
        leaseExpiresAt: { $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
    ],
  })
    .select("_id")
    .limit(batchSize)
    .lean();

  for (const candidate of candidates) {
    const record = await CallNotificationOutbox.findOneAndUpdate(
      {
        _id: candidate._id,
        $or: [
          {
            status: "PENDING",
            nextAttemptAt: { $lte: now },
            attempts: { $lt: MAX_ATTEMPTS },
          },
          {
            status: "PROCESSING",
            leaseExpiresAt: { $lte: now },
            attempts: { $lt: MAX_ATTEMPTS },
          },
        ],
      },
      {
        $set: {
          status: "PROCESSING",
          processingAt: now,
          leaseExpiresAt: leaseExpiry,
          lastAttemptAt: now,
        },
        $inc: {
          attempts: 1,
        },
      },
      { new: true },
    );

    if (!record) {
      skipped++;
      continue;
    }

    processed++;

    try {
      let acked = false;

      if (record.eventType === "INCOMING_CALL") {
        acked = await deliverIncomingCallNotification(
          record.recipientUserId.toString(),
          {
            notificationId: record.providerCallId,
            workspaceId: record.payload.workspaceId,
            callId: record.payload.callId,
            callSid: record.callLogId.toString(),
            name: record.payload.name ?? "Unknown",
            phone: record.payload.phone ?? "",
            sdpOffer: record.payload.sdpOffer,
            phoneNumberId: record.payload.phoneNumberId,
          },
        );
      }

      if (record.eventType === "CALL_ENDED") {
        acked = await deliverCallEndedNotification(
          record.recipientUserId.toString(),
          {
            notificationId: record.providerCallId,
            workspaceId: record.payload.workspaceId,
            callId: record.payload.callId,
            status: record.payload.endStatus ?? "ENDED",
          },
        );
      }

      if (acked) {
        await CallNotificationOutbox.updateOne(
          { _id: record._id },
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

        delivered++;
        continue;
      }

      const isExhausted = record.attempts >= MAX_ATTEMPTS;

      await CallNotificationOutbox.updateOne(
        { _id: record._id },
        {
          $set: {
            status: isExhausted ? "FAILED" : "PENDING",
            nextAttemptAt: new Date(
              Date.now() + backoffSeconds(record.attempts) * 1000,
            ),
            lastError: "No client ACK received within timeout.",
          },
          $unset: {
            processingAt: 1,
            leaseExpiresAt: 1,
          },
        },
      );

      if (isExhausted) {
        failed++;
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      const isExhausted = record.attempts >= MAX_ATTEMPTS;

      await CallNotificationOutbox.updateOne(
        { _id: record._id },
        {
          $set: {
            status: isExhausted ? "FAILED" : "PENDING",
            nextAttemptAt: new Date(
              Date.now() + backoffSeconds(record.attempts) * 1000,
            ),
            lastError: errorMessage.slice(0, 1000),
          },
          $unset: {
            processingAt: 1,
            leaseExpiresAt: 1,
          },
        },
      );

      if (isExhausted) failed++;

      console.error("[OutboxWorker] Delivery error:", {
        id: record._id.toString(),
        error: errorMessage,
      });
    }
  }

  console.info("[OutboxWorker] Batch complete:", {
    processed,
    delivered,
    failed,
    skipped,
  });

  return { processed, delivered, failed, skipped };
}