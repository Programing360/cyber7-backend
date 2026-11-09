import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import User from "../src/modules/auth/user.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import Payment from "../src/modules/billing/payment.model.js";
import { isSessionInvalidated } from "../src/middlewares/authenticate-admin-session.js";

describe("Step 1: Data Contracts, Schema Enhancements & Security Foundations", () => {
  describe("User Schema Enhancements", () => {
    it("should instantiate a User document with default tokenInvalidBefore and suspendedReason as null", () => {
      const doc = new User({
        name: "Test Admin",
        email: "test.admin@vexchat.io",
        password: "hashedPassword123",
      });

      assert.strictEqual(doc.tokenInvalidBefore, null);
      assert.strictEqual(doc.suspendedReason, null);
      assert.strictEqual(doc.isActive, true);
      assert.strictEqual(doc.platformRole, "USER");
      assert.strictEqual(doc.role, "user");
    });

    it("should allow persisting tokenInvalidBefore and suspendedReason", () => {
      const invalidationTime = new Date("2026-11-08T10:00:00Z");
      const doc = new User({
        name: "Suspended Admin",
        email: "suspended@vexchat.io",
        password: "hashedPassword123",
        tokenInvalidBefore: invalidationTime,
        suspendedReason: "Suspicious login attempts detected from unrecognized ASN",
        isActive: false,
      });

      assert.strictEqual(doc.tokenInvalidBefore?.toISOString(), invalidationTime.toISOString());
      assert.strictEqual(
        doc.suspendedReason,
        "Suspicious login attempts detected from unrecognized ASN",
      );
      assert.strictEqual(doc.isActive, false);
    });
  });

  describe("Workspace Schema Enhancements", () => {
    it("should instantiate a Workspace document with default customLimits, suspensionReason, and suspendedAt as null", () => {
      const doc = new Workspace({
        name: "Acme Corp",
        slug: "acme-corp",
        nameNormalized: "acmecorp",
        ownerId: new mongoose.Types.ObjectId(),
      });

      assert.strictEqual(doc.status, "ACTIVE");
      assert.strictEqual(doc.suspensionReason, null);
      assert.strictEqual(doc.suspendedAt, null);
      assert.ok(doc.customLimits !== undefined);
      assert.strictEqual(doc.customLimits?.maxWhatsAppNumbers, null);
      assert.strictEqual(doc.customLimits?.maxTeamMembers, null);
    });

    it("should allow configuring customLimits and suspension fields", () => {
      const suspendedDate = new Date("2026-11-08T09:30:00Z");
      const doc = new Workspace({
        name: "Enterprise Beta",
        slug: "enterprise-beta",
        nameNormalized: "enterprisebeta",
        ownerId: new mongoose.Types.ObjectId(),
        status: "SUSPENDED",
        suspensionReason: "Overdue invoice exceeding 14 days grace period",
        suspendedAt: suspendedDate,
        customLimits: {
          maxWhatsAppNumbers: 5,
          maxTeamMembers: 25,
        },
      });

      assert.strictEqual(doc.status, "SUSPENDED");
      assert.strictEqual(
        doc.suspensionReason,
        "Overdue invoice exceeding 14 days grace period",
      );
      assert.strictEqual(doc.suspendedAt?.toISOString(), suspendedDate.toISOString());
      assert.strictEqual(doc.customLimits?.maxWhatsAppNumbers, 5);
      assert.strictEqual(doc.customLimits?.maxTeamMembers, 25);
    });
  });

  describe("Payment Schema Enhancements", () => {
    it("should accept status REFUNDED and store refundMetadata", () => {
      const adminId = new mongoose.Types.ObjectId();
      const refundDate = new Date("2026-11-08T10:15:00Z");

      const doc = new Payment({
        workspaceId: new mongoose.Types.ObjectId(),
        initiatedBy: new mongoose.Types.ObjectId(),
        paymentMethod: "CITY_BANK_TRANSFER",
        planCode: "BUSINESS_PRO",
        planName: "Business Pro",
        amount: 7400,
        currency: "BDT",
        status: "REFUNDED",
        idempotencyKey: "refund-test-key-001",
        invoiceNumber: "INV-2026-TEST-001",
        refundMetadata: {
          refundedAt: refundDate,
          refundedBy: adminId,
          refundReason: "Accidental double transfer by client",
          refundAmount: 7400,
        },
      });

      assert.strictEqual(doc.status, "REFUNDED");
      assert.ok(doc.refundMetadata);
      assert.strictEqual(doc.refundMetadata.refundAmount, 7400);
      assert.strictEqual(
        doc.refundMetadata.refundReason,
        "Accidental double transfer by client",
      );
      assert.strictEqual(doc.refundMetadata.refundedBy?.toString(), adminId.toString());
      assert.strictEqual(doc.refundMetadata.refundedAt?.toISOString(), refundDate.toISOString());
    });

    it("should accept bank transfer verification metadata in gatewayData", () => {
      const verifierId = new mongoose.Types.ObjectId();
      const verifiedTime = new Date("2026-11-08T08:00:00Z");

      const doc = new Payment({
        workspaceId: new mongoose.Types.ObjectId(),
        initiatedBy: new mongoose.Types.ObjectId(),
        paymentMethod: "CITY_BANK_TRANSFER",
        planCode: "STARTER",
        planName: "Starter",
        amount: 3000,
        currency: "BDT",
        status: "COMPLETED",
        idempotencyKey: "bank-test-key-002",
        invoiceNumber: "INV-2026-TEST-002",
        gatewayData: {
          bankTransfer: {
            bankName: "City Bank",
            accountName: "Client Business Ltd",
            branchName: "Gulshan-1",
            referenceNumber: "CBL-DEP-994821",
            verifiedBy: verifierId,
            verifiedAt: verifiedTime,
            adminNotes: "Deposit verified in corporate bank statement",
            rejectionReason: undefined,
          },
        },
      });

      const bt = doc.gatewayData?.bankTransfer;
      assert.ok(bt);
      assert.strictEqual(bt.verifiedBy?.toString(), verifierId.toString());
      assert.strictEqual(bt.verifiedAt?.toISOString(), verifiedTime.toISOString());
      assert.strictEqual(bt.adminNotes, "Deposit verified in corporate bank statement");
    });
  });

  describe("Session Invalidation Security Helper", () => {
    it("should identify session older than tokenInvalidBefore as invalidated", () => {
      const sessionCreated = new Date("2026-11-08T09:00:00Z");
      const invalidBefore = new Date("2026-11-08T09:30:00Z");

      assert.strictEqual(isSessionInvalidated(sessionCreated, invalidBefore), true);
    });

    it("should identify session created after tokenInvalidBefore as valid", () => {
      const sessionCreated = new Date("2026-11-08T10:00:00Z");
      const invalidBefore = new Date("2026-11-08T09:30:00Z");

      assert.strictEqual(isSessionInvalidated(sessionCreated, invalidBefore), false);
    });

    it("should return false if tokenInvalidBefore is null or undefined", () => {
      const sessionCreated = new Date("2026-11-08T10:00:00Z");

      assert.strictEqual(isSessionInvalidated(sessionCreated, null), false);
      assert.strictEqual(isSessionInvalidated(sessionCreated, undefined), false);
    });
  });
});
