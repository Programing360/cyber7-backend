/**
 * Outbox Dispatcher — Atomic Poll-and-Deliver Worker
 *
 * Deployment-platform notes
 * ─────────────────────────
 * The backend is deployed on Vercel (serverless). A bare `setInterval` is
 * unsuitable because Vercel functions are ephemeral and have no persistent
 * process. Instead this module exports a single stateless function,
 * `processCallNotificationOutbox`, that:
 *
 *   1. Atomically leases up to `batchSize` PENDING (or stale PROCESSING)
 *      outbox records using a MongoDB `findOneAndUpdate` per record.
 *   2. Attempts Socket.IO delivery for each claimed record.
 *   3. Marks DELIVERED on ACK success, or reschedules with bounded
 *      exponential backoff on failure.
 *
 * To drive this function use one of:
 *   a) A Vercel Cron Job via `vercel.json` → calls the internal HTTP route
 *      `POST /api/internal/process-call-notifications` (see calling.routes.ts).
 *   b) A BullMQ repeatable job on a persistent worker process (if you later
 *      add a dedicated worker dyno/VM).
 *   c) A direct call during the same request lifecycle (e.g., after webhook
 *      processing) for sub-second delivery in development.
 *
 * Security note
 * ─────────────
 * The HTTP cron endpoint must be protected by CRON_SECRET. Never call it
 * from unauthenticated or external paths.
 */

import CallNotificationOutbox from "./CallNotificationOutbox.js";
import {
  deliverIncomingCallNotification,
  deliverCallEndedNotification,
} from "../../sockets/callSocket.js";

/**
 * Maximum delivery attempts before a notification is permanently failed.
 */
const MAX_ATTEMPTS = 10;

/**
 * Worker lease duration (ms). After this window a stale PROCESSING record
 * is eligible for reclaim by the next worker invocation.
 */
const LEASE_DURATION_MS = 30_000; // 30 s

/**
 * Bounded exponential backoff (seconds) for retry scheduling.
 *
 * backoffSeconds(0) = 30 s
 * backoffSeconds(3) = 240 s
 * backoffSeconds(9) = capped at 3600 s (1 h)
 */
function backoffSeconds(attempts: number): number {
  return Math.min(30 * Math.pow(2, attempts), 3600);
}

/**
 * Process one batch of pending outbox notifications.
 *
 * @param batchSize Maximum records to process per invocation (default 50).
 * @returns Summary of processed, delivered, failed, and skipped counts.
 */
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

  /**
   * Query: PENDING records due for delivery, OR stale PROCESSING records
   * whose lease has expired (crash recovery).
   */
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
    /**
     * Atomic lease claim.
     * Only one worker can transition a record from PENDING → PROCESSING.
     * The filter re-checks the same conditions used in the initial query.
     */
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
        $inc: { attempts: 1 },
      },
      { new: true },
    );

    if (!record) {
      // Another worker claimed this record first — skip gracefully.
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
            notificationId: record._id.toString(),
            workspaceId: record.payload.workspaceId,
            callId: record.payload.callId,
            callSid: record.callLogId
              ? record.callLogId.toString()
              : record.payload.callId,
            name: record.payload.name ?? "Unknown",
            phone: record.payload.phone ?? "",
            sdpOffer: (record.payload as any).sdpOffer,
          },
        );
      } else if (record.eventType === "CALL_ENDED") {
        acked = await deliverCallEndedNotification(
          record.recipientUserId.toString(),
          {
            notificationId: record._id.toString(),
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
              lastError: undefined,
            },
          },
        );
        delivered++;
      } else {
        // No client ACK — reschedule with backoff.
        const nextAttemptSeconds = backoffSeconds(record.attempts);
        const nextAttemptAt = new Date(Date.now() + nextAttemptSeconds * 1000);

        const isExhausted = record.attempts >= MAX_ATTEMPTS;

        await CallNotificationOutbox.updateOne(
          { _id: record._id },
          {
            $set: {
              status: isExhausted ? "FAILED" : "PENDING",
              nextAttemptAt,
              lastError: "No client ACK received within timeout.",
              processingAt: undefined,
              leaseExpiresAt: undefined,
            },
          },
        );

        if (isExhausted) {
          failed++;
          console.warn("[OutboxWorker] Notification exhausted max attempts:", {
            id: record._id.toString(),
            eventType: record.eventType,
            recipientUserId: record.recipientUserId.toString(),
          });
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      const nextAttemptSeconds = backoffSeconds(record.attempts);
      const nextAttemptAt = new Date(Date.now() + nextAttemptSeconds * 1000);
      const isExhausted = record.attempts >= MAX_ATTEMPTS;

      console.error("[OutboxWorker] Delivery error:", {
        id: record._id.toString(),
        error: errorMessage,
      });

      await CallNotificationOutbox.updateOne(
        { _id: record._id },
        {
          $set: {
            status: isExhausted ? "FAILED" : "PENDING",
            nextAttemptAt,
            lastError: errorMessage.slice(0, 1000),
            processingAt: undefined,
            leaseExpiresAt: undefined,
          },
        },
      );

      if (isExhausted) failed++;
    }
  }

  if (processed > 0 || skipped > 0) {
    console.info("[OutboxWorker] Batch complete:", {
      processed,
      delivered,
      failed,
      skipped,
    });
  }

  return { processed, delivered, failed, skipped };
}
