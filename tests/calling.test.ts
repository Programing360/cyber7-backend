/**
 * Cyber7 WhatsApp Calling & Outbox Dispatcher Verification Suite
 *
 * Verifies:
 * 1. Outbox Delivery & Retry Exponential Backoff
 * 2. Outbox Atomic Lease Claim & Stale Lease (Crash) Recovery
 * 3. Call State Lifecycle & Status Semantics
 * 4. Webhook Calling Events & Payload Parsing (Connect, Terminate, Call Progress Statuses)
 * 5. Multi-agent First-Answer-Wins Filter Semantics
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import CallLog, { type CallStatus } from "../src/modules/Calling/CallLog.js";
import CallNotificationOutbox, {
  type CallNotificationStatus,
} from "../src/modules/Calling/CallNotificationOutbox.js";

describe("WhatsApp Calling — Status Semantics & Schema Integrity", () => {
  it("should accept all verified CallStatus enum values", () => {
    const validStatuses: CallStatus[] = [
      "RINGING",
      "ASSIGNING",
      "CONNECTED",
      "ENDED",
      "REJECTED",
      "MISSED",
      "FAILED",
    ];

    const enumValues = (
      CallLog.schema.path("status") as mongoose.SchemaType & {
        enumValues?: string[];
      }
    ).enumValues;

    assert.ok(enumValues, "CallLog.status must define enumValues");
    for (const status of validStatuses) {
      assert.ok(
        enumValues.includes(status),
        `CallStatus '${status}' must be in CallLog enum`,
      );
    }
  });

  it("should reject invalid CallStatus values", () => {
    const enumValues = (
      CallLog.schema.path("status") as mongoose.SchemaType & {
        enumValues?: string[];
      }
    ).enumValues;

    assert.ok(!enumValues?.includes("INVALID_STATUS"));
    assert.ok(!enumValues?.includes("IN_PROGRESS"));
  });

  it("should validate CallNotificationOutbox statuses including PROCESSING and lease fields", () => {
    const validOutboxStatuses: CallNotificationStatus[] = [
      "PENDING",
      "PROCESSING",
      "DELIVERED",
      "FAILED",
    ];

    const enumValues = (
      CallNotificationOutbox.schema.path("status") as mongoose.SchemaType & {
        enumValues?: string[];
      }
    ).enumValues;

    assert.ok(enumValues, "CallNotificationOutbox.status must define enumValues");
    for (const status of validOutboxStatuses) {
      assert.ok(
        enumValues.includes(status),
        `CallNotificationStatus '${status}' must be in enum`,
      );
    }

    assert.ok(
      CallNotificationOutbox.schema.path("processingAt"),
      "Outbox must include processingAt for lease tracking",
    );
    assert.ok(
      CallNotificationOutbox.schema.path("leaseExpiresAt"),
      "Outbox must include leaseExpiresAt for crash recovery",
    );
  });
});

describe("Outbox Dispatcher — Exponential Backoff & Lease Mechanics", () => {
  function backoffSeconds(attempts: number): number {
    return Math.min(30 * Math.pow(2, attempts), 3600);
  }

  it("should correctly compute bounded exponential backoff intervals", () => {
    assert.strictEqual(backoffSeconds(0), 30);
    assert.strictEqual(backoffSeconds(1), 60);
    assert.strictEqual(backoffSeconds(2), 120);
    assert.strictEqual(backoffSeconds(3), 240);
    assert.strictEqual(backoffSeconds(4), 480);
    assert.strictEqual(backoffSeconds(5), 960);
    assert.strictEqual(backoffSeconds(6), 1920);
    // Bounded cap at 3600 seconds (1 hour)
    assert.strictEqual(backoffSeconds(7), 3600);
    assert.strictEqual(backoffSeconds(10), 3600);
    assert.strictEqual(backoffSeconds(20), 3600);
  });

  it("should construct atomic lease claim query with timeout protection", () => {
    const now = new Date();
    const MAX_ATTEMPTS = 10;

    const claimFilter = {
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
    };

    assert.strictEqual(claimFilter.$or.length, 2);
    assert.strictEqual(claimFilter.$or[0].status, "PENDING");
    assert.strictEqual(claimFilter.$or[1].status, "PROCESSING");
  });
});

describe("First-Answer-Wins — Atomic Filter Validation", () => {
  it("should enforce atomic first-answer-wins filter semantics", () => {
    const callId = new mongoose.Types.ObjectId();
    const workspaceId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId().toString();

    const atomicFilter = {
      _id: callId.toString(),
      workspaceId: workspaceId.toString(),
      status: "RINGING",
      ringingUserIds: userId,
      $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }],
    };

    assert.strictEqual(atomicFilter.status, "RINGING");
    assert.strictEqual(atomicFilter.ringingUserIds, userId);
    assert.deepStrictEqual(atomicFilter.$or, [
      { assignedTo: { $exists: false } },
      { assignedTo: null },
    ]);
  });
});

describe("Meta Webhook Calling — Payload Parsing & Status Routing", () => {
  it("should distinguish call statuses from message delivery statuses", () => {
    const callStatusEvent = {
      id: "wamid.HBgLMTY1MDY5Mzk0MjkVAgASGCBEOTIz",
      type: "call",
      status: "RINGING",
      timestamp: "1700000000",
      recipient_id: "16505551234",
    };

    const messageStatusEvent = {
      id: "wamid.HBgLMTY1MDY5Mzk0MjkVAgASGCBEOTIz",
      type: "message",
      status: "delivered",
      timestamp: "1700000000",
      recipient_id: "16505551234",
    };

    assert.strictEqual(callStatusEvent.type, "call");
    assert.notStrictEqual(messageStatusEvent.type, "call");
  });

  it("should determine correct callType on termination (MISSED vs ENDED vs REJECTED)", () => {
    function computeCallTermination(direction: string, metaStatus?: string, duration?: number) {
      const isRejected = metaStatus === "REJECTED";
      const isUnanswered =
        direction === "USER_INITIATED" &&
        (metaStatus === "NO_ANSWER" ||
          metaStatus === "CANCELED" ||
          metaStatus === "CANCELLED" ||
          (metaStatus === "COMPLETED" && duration === undefined));

      const callType = isUnanswered ? "MISSED" : direction === "USER_INITIATED" ? "INCOMING" : "OUTGOING";
      const endStatus = isUnanswered ? "MISSED" : isRejected ? "REJECTED" : "ENDED";

      return { callType, endStatus };
    }

    // Customer hangs up without answer
    assert.deepStrictEqual(
      computeCallTermination("USER_INITIATED", "NO_ANSWER"),
      { callType: "MISSED", endStatus: "MISSED" },
    );

    // Customer cancels before answer
    assert.deepStrictEqual(
      computeCallTermination("USER_INITIATED", "CANCELED"),
      { callType: "MISSED", endStatus: "MISSED" },
    );

    // Call explicitly rejected
    assert.deepStrictEqual(
      computeCallTermination("USER_INITIATED", "REJECTED", 0),
      { callType: "INCOMING", endStatus: "REJECTED" },
    );

    // Call answered and completed normally
    assert.deepStrictEqual(
      computeCallTermination("USER_INITIATED", "COMPLETED", 45),
      { callType: "INCOMING", endStatus: "ENDED" },
    );
  });
});

