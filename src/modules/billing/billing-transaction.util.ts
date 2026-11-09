import mongoose, { type ClientSession } from "mongoose";
import { AppError } from "../../utils/app-error.js";

/**
 * Runs an atomic operation inside a MongoDB transaction.
 *
 * Fail-Closed Production Behavior:
 * - In production environments (`NODE_ENV === "production"`), payment completion strictly requires a working MongoDB replica set transaction.
 * - If session or transaction initialization fails in production, it throws an AppError and fails closed.
 * - Silent non-transactional fallback is strictly forbidden in production.
 * - Non-production fallback is allowed only in test/development when disconnected or running on standalone runners.
 * - Bounded retries (up to 3 attempts with exponential backoff) are applied only for transient errors (e.g. WriteConflict).
 */
export async function runWithTransaction<T>(
  work: (session?: ClientSession) => Promise<T>,
): Promise<T> {
  const isProduction = process.env.NODE_ENV === "production";

  // In non-production environments (e.g. unit tests or disconnected local runners), allow stubs to run
  if (!isProduction && mongoose.connection.readyState !== 1) {
    return work(undefined);
  }

  let session: ClientSession;
  try {
    session = await mongoose.startSession();
  } catch (err: unknown) {
    if (!isProduction) {
      return work(undefined);
    }
    console.error("[BILLING_TRANSACTION_ERROR] Failed to start MongoDB session:", err);
    throw new AppError(
      "Billing service is temporarily unavailable. Please retry in a few moments.",
      500,
    );
  }

  try {
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        session.startTransaction();
        const result = await work(session);
        if (session.inTransaction()) {
          await session.commitTransaction();
        }
        return result;
      } catch (err: any) {
        if (session.inTransaction()) {
          try {
            await session.abortTransaction();
          } catch (abortErr) {
            console.error("[BILLING_TRANSACTION_ABORT_ERROR]:", abortErr);
          }
        }

        // Test/local fallback: if running on standalone MongoDB without replica set
        if (!isProduction) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("replica set member") ||
            msg.includes("Transactions are not supported")
          ) {
            return work(undefined);
          }
        }

        // Retry transient transaction errors (like WriteConflict)
        const isTransient =
          err?.hasErrorLabel?.("TransientTransactionError") ||
          err?.errorLabels?.includes?.("TransientTransactionError") ||
          err?.message?.includes("WriteConflict");

        if (isTransient && attempt < MAX_RETRIES) {
          const backoffMs = Math.min(
            100 * Math.pow(2, attempt) + Math.random() * 50,
            500,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        throw err;
      }
    }

    throw new AppError(
      "Payment transaction could not be completed due to high concurrency. Please retry.",
      500,
    );
  } finally {
    await session.endSession();
  }
}
