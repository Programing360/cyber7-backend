import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// Ensure required environment variables for test execution
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-jwt-access-secret-super-safe-and-long-enough-32-chars";

import {
  generateStepUpToken,
  verifyStepUpToken,
} from "../src/utils/jwt.js";
import {
  adminApproveTransferSchema,
  adminRejectTransferSchema,
  adminRefundPaymentSchema,
} from "../src/modules/billing/billing.validation.js";
import { billingService } from "../src/modules/billing/billing.service.js";
import Payment from "../src/modules/billing/payment.model.js";
import { platformAdminBillingRouter } from "../src/modules/billing/billing.routes.js";
import { AppError } from "../src/utils/app-error.js";

describe("Step 2: Financial Mutations & Ledger Integrity Test Suite", () => {
  describe("High-Value Step-Up Authorization Token Utility", () => {
    const adminId = new mongoose.Types.ObjectId().toString();

    it("should generate a valid step-up token that verifies successfully", () => {
      const token = generateStepUpToken(adminId);
      assert.ok(typeof token === "string" && token.length > 20);

      const isValid = verifyStepUpToken(token, adminId);
      assert.strictEqual(isValid, true);
    });

    it("should reject step-up verification if adminUserId does not match", () => {
      const token = generateStepUpToken(adminId);
      const differentAdminId = new mongoose.Types.ObjectId().toString();

      const isValid = verifyStepUpToken(token, differentAdminId);
      assert.strictEqual(isValid, false);
    });

    it("should reject malformed or tampered step-up tokens", () => {
      assert.strictEqual(verifyStepUpToken("invalid.token.string", adminId), false);
      assert.strictEqual(verifyStepUpToken("", adminId), false);
      assert.strictEqual(verifyStepUpToken("random-bearer-token", adminId), false);
    });
  });

  describe("Administrative Financial Mutation Validation Schemas", () => {
    it("should accept valid payload for adminApproveTransferSchema with notes and stepUpToken", () => {
      const valid1 = adminApproveTransferSchema.safeParse({
        notes: "Verified against City Bank portal statement",
      });
      assert.ok(valid1.success);
      assert.strictEqual(valid1.data.notes, "Verified against City Bank portal statement");

      const valid2 = adminApproveTransferSchema.safeParse({
        adminNotes: "Approved by finance manager",
        stepUpToken: "sample.jwt.token",
      });
      assert.ok(valid2.success);
      assert.strictEqual(valid2.data.adminNotes, "Approved by finance manager");
      assert.strictEqual(valid2.data.stepUpToken, "sample.jwt.token");

      // Optional payload is also allowed
      const validEmpty = adminApproveTransferSchema.safeParse({});
      assert.ok(validEmpty.success);
    });

    it("should validate adminRejectTransferSchema requiring a reason", () => {
      const valid1 = adminRejectTransferSchema.safeParse({
        reason: "Fake bank transfer slip with unverified transaction ID",
      });
      assert.ok(valid1.success);

      const valid2 = adminRejectTransferSchema.safeParse({
        rejectionReason: "Amount deposited does not match invoice",
      });
      assert.ok(valid2.success);

      const invalidEmpty = adminRejectTransferSchema.safeParse({});
      assert.strictEqual(invalidEmpty.success, false);

      const invalidBlank = adminRejectTransferSchema.safeParse({ reason: "   " });
      assert.strictEqual(invalidBlank.success, false);
    });

    it("should validate adminRefundPaymentSchema requiring min 3 character reason", () => {
      const valid = adminRefundPaymentSchema.safeParse({
        reason: "Double billing refund requested by client",
        refundAmount: 5000,
      });
      assert.ok(valid.success);
      assert.strictEqual(valid.data.refundAmount, 5000);

      const invalidShort = adminRefundPaymentSchema.safeParse({
        reason: "no",
      });
      assert.strictEqual(invalidShort.success, false);

      const invalidAmount = adminRefundPaymentSchema.safeParse({
        reason: "Double billing refund",
        refundAmount: -100,
      });
      assert.strictEqual(invalidAmount.success, false);
    });
  });

  describe("High-Value Transfer Guard (>= 50,000 BDT)", () => {
    const adminUser = {
      id: new mongoose.Types.ObjectId().toString(),
      email: "finance.super@vexchat.app",
    };

    it("should fail closed (403 STEP_UP_REQUIRED) when payment amount >= 50,000 BDT and stepUpToken is missing", async () => {
      // Mock Payment.findById to return a high-value pending payment
      const originalFindById = Payment.findById;
      try {
        (Payment as any).findById = () => ({
          _id: new mongoose.Types.ObjectId(),
          amount: 60000,
          currency: "BDT",
          paymentMethod: "CITY_BANK_TRANSFER",
          status: "PENDING_VERIFICATION",
        });

        await assert.rejects(
          async () => {
            await billingService.approveBankTransfer({
              paymentId: new mongoose.Types.ObjectId().toString(),
              adminUser,
              adminNotes: "Approving 60k high-value payment",
              // stepUpToken is missing
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 403);
            assert.strictEqual(err.code, "STEP_UP_REQUIRED");
            return true;
          },
        );
      } finally {
        Payment.findById = originalFindById;
      }
    });

    it("should fail closed (403 INVALID_STEP_UP_TOKEN) when payment amount >= 50,000 BDT and stepUpToken is invalid", async () => {
      const originalFindById = Payment.findById;
      try {
        (Payment as any).findById = () => ({
          _id: new mongoose.Types.ObjectId(),
          amount: 75000,
          currency: "BDT",
          paymentMethod: "CITY_BANK_TRANSFER",
          status: "PENDING_VERIFICATION",
        });

        await assert.rejects(
          async () => {
            await billingService.approveBankTransfer({
              paymentId: new mongoose.Types.ObjectId().toString(),
              adminUser,
              adminNotes: "Approving 75k transfer",
              stepUpToken: "corrupted.token.payload",
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 403);
            assert.strictEqual(err.code, "INVALID_STEP_UP_TOKEN");
            return true;
          },
        );
      } finally {
        Payment.findById = originalFindById;
      }
    });

    it("should allow high-value transfer when valid stepUpToken is provided", async () => {
      const validToken = generateStepUpToken(adminUser.id);
      const originalFindById = Payment.findById;
      const originalFindOneAndUpdate = Payment.findOneAndUpdate;

      try {
        (Payment as any).findById = () => ({
          _id: new mongoose.Types.ObjectId(),
          amount: 90000,
          currency: "BDT",
          paymentMethod: "CITY_BANK_TRANSFER",
          status: "PENDING_VERIFICATION",
        });

        (Payment as any).findOneAndUpdate = () => {
          throw new Error("TRANSACTION_REACHED_SUCCESSFULLY");
        };

        // Test that it passes validation and proceeds to transaction execution
        await assert.rejects(
          async () => {
            await billingService.approveBankTransfer({
              paymentId: new mongoose.Types.ObjectId().toString(),
              adminUser,
              adminNotes: "Approved high-value tier",
              stepUpToken: validToken,
            });
          },
          (err: any) => {
            assert.strictEqual(err.message, "TRANSACTION_REACHED_SUCCESSFULLY");
            return true;
          },
        );
      } finally {
        Payment.findById = originalFindById;
        Payment.findOneAndUpdate = originalFindOneAndUpdate;
      }
    });
  });

  describe("Payment State Consistency & Pre-condition Guards", () => {
    const adminUser = {
      id: new mongoose.Types.ObjectId().toString(),
      email: "finance.admin@vexchat.app",
    };

    it("should reject approval if payment is not in PENDING_VERIFICATION status", async () => {
      const originalFindById = Payment.findById;
      try {
        (Payment as any).findById = () => ({
          _id: new mongoose.Types.ObjectId(),
          amount: 15000,
          paymentMethod: "CITY_BANK_TRANSFER",
          status: "COMPLETED", // already completed
        });

        await assert.rejects(
          async () => {
            await billingService.approveBankTransfer({
              paymentId: new mongoose.Types.ObjectId().toString(),
              adminUser,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 400);
            assert.ok(err.message.includes("Cannot approve bank transfer with status COMPLETED"));
            return true;
          },
        );
      } finally {
        Payment.findById = originalFindById;
      }
    });

    it("should reject approval if paymentMethod is not CITY_BANK_TRANSFER", async () => {
      const originalFindById = Payment.findById;
      try {
        (Payment as any).findById = () => ({
          _id: new mongoose.Types.ObjectId(),
          amount: 5000,
          paymentMethod: "BKASH",
          status: "PENDING_VERIFICATION",
        });

        await assert.rejects(
          async () => {
            await billingService.approveBankTransfer({
              paymentId: new mongoose.Types.ObjectId().toString(),
              adminUser,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 400);
            assert.ok(err.message.includes("Payment is not a City Bank transfer"));
            return true;
          },
        );
      } finally {
        Payment.findById = originalFindById;
      }
    });

    it("should reject refund if payment is not in COMPLETED status", async () => {
      const originalFindById = Payment.findById;
      try {
        (Payment as any).findById = () => ({
          _id: new mongoose.Types.ObjectId(),
          amount: 10000,
          status: "PENDING", // not completed
        });

        await assert.rejects(
          async () => {
            await billingService.refundPayment({
              paymentId: new mongoose.Types.ObjectId().toString(),
              adminUser,
              reason: "Customer dispute",
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 400);
            assert.ok(err.message.includes("Cannot refund payment with status: PENDING"));
            return true;
          },
        );
      } finally {
        Payment.findById = originalFindById;
      }
    });
  });

  describe("Platform Admin Billing Router Configuration", () => {
    it("should have unquarantined administrative routes mounted", () => {
      const routes = platformAdminBillingRouter.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods),
        }));

      // Verify the 4 essential platform admin billing endpoints are registered:
      const paths = routes.map((r) => r.path);
      assert.ok(paths.includes("/bank-transfers/pending"), "Must include /bank-transfers/pending");
      assert.ok(
        paths.includes("/bank-transfers/:paymentId/approve"),
        "Must include /bank-transfers/:paymentId/approve",
      );
      assert.ok(
        paths.includes("/bank-transfers/:paymentId/reject"),
        "Must include /bank-transfers/:paymentId/reject",
      );
      assert.ok(
        paths.includes("/payments/:paymentId/refund"),
        "Must include /payments/:paymentId/refund",
      );
    });
  });
});
