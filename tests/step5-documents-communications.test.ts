import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import mongoose from "mongoose";

// Ensure test environment variables
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-jwt-access-secret-super-safe-and-long-enough-32-chars";

import Invoice from "../src/modules/billing/invoice.model.js";
import Payment from "../src/modules/billing/payment.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import AdminSecurityAuditLog from "../src/modules/admin-auth/admin-security-audit.model.js";
import { resendInvoiceEmailSchema } from "../src/modules/billing/invoice-email.validation.js";
import {
  streamInvoicePdf,
  generateInvoicePdfBuffer,
  resendInvoiceEmailService,
} from "../src/modules/billing/invoice-pdf.service.js";
import {
  streamPaymentReceiptPdf,
  getCompletedPayment,
} from "../src/modules/billing/receipt-pdf.service.js";
import { documentController } from "../src/modules/billing/document.controller.js";
import { platformAdminBillingRouter } from "../src/modules/billing/billing.routes.js";
import dashboardRouter from "../src/modules/platform-admin-dashboard/dashboard.routes.js";

/**
 * Mock Express Stream Response Helper
 */
class MockStreamResponse extends EventEmitter {
  headers: Record<string, string> = {};
  statusCode = 200;
  headersSent = false;
  chunks: Buffer[] = [];
  jsonData: any = null;

  setHeader(key: string, val: string) {
    this.headers[key.toLowerCase()] = val;
    this.headersSent = true;
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(data: any) {
    this.jsonData = data;
    return this;
  }

  write(chunk: any) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: any) {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.emit("finish");
    return this;
  }

  getBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

describe("Step 5: Document Engine & Transactional Communications Test Suite", () => {
  const adminActor = {
    adminUserId: new mongoose.Types.ObjectId().toString(),
    adminEmail: "finance.head@vexchat.app",
    sessionId: new mongoose.Types.ObjectId().toString(),
    ipAddress: "192.168.1.50",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VexAdmin/1.0",
  };

  describe("1. Validation Schemas", () => {
    it("should accept undefined/empty recipientEmail in resend schema", () => {
      const res = resendInvoiceEmailSchema.safeParse({});
      assert.ok(res.success);
      assert.strictEqual(res.data.recipientEmail, undefined);
    });

    it("should accept valid recipient email", () => {
      const res = resendInvoiceEmailSchema.safeParse({
        recipientEmail: "client.accounts@corp.bd",
      });
      assert.ok(res.success);
      assert.strictEqual(res.data.recipientEmail, "client.accounts@corp.bd");
    });

    it("should reject invalid recipient email format", () => {
      const res = resendInvoiceEmailSchema.safeParse({
        recipientEmail: "not-an-email",
      });
      assert.strictEqual(res.success, false);
    });
  });

  describe("2. Invoice PDF Streaming & Buffer Generation", () => {
    it("should stream an invoice PDF with correct headers and valid PDF magic bytes", async () => {
      const mockInvoice = {
        _id: new mongoose.Types.ObjectId(),
        invoiceNumber: "INV-2026-0001",
        workspaceId: new mongoose.Types.ObjectId(),
        paymentId: new mongoose.Types.ObjectId(),
        issuedTo: {
          userName: "Tareq Rahman",
          userEmail: "tareq@megacorp.com",
          workspaceName: "MegaCorp BD",
        },
        planCode: "BUSINESS_PRO",
        planName: "Business Pro Tier",
        billingCycle: "MONTHLY",
        periodCoveredStart: new Date("2026-11-01"),
        periodCoveredEnd: new Date("2026-12-01"),
        amount: 15000,
        currency: "BDT",
        status: "PAID",
        paymentMethod: "CITY_BANK_TRANSFER",
        paidAt: new Date("2026-11-02"),
        createdAt: new Date("2026-11-01"),
      };

      const mockPayment = {
        _id: mockInvoice.paymentId,
        amount: 15000,
        status: "COMPLETED",
        gatewayData: {
          bankTransfer: {
            bankName: "City Bank PLC",
            branchName: "Gulshan-1",
            referenceNumber: "CBL-DEP-998822",
            verifiedBy: new mongoose.Types.ObjectId(),
            verifiedAt: new Date("2026-11-02"),
          },
        },
      };

      // Mock Invoice.findOne & Payment.findById
      const origFindOne = Invoice.findOne;
      const origFindById = Payment.findById;

      Invoice.findOne = ((_query: any) => Promise.resolve(mockInvoice)) as any;
      Payment.findById = ((_id: any) => Promise.resolve(mockPayment)) as any;

      try {
        const mockRes = new MockStreamResponse() as any;
        await streamInvoicePdf(mockInvoice.invoiceNumber, mockRes);

        // Wait for doc stream to finish piping
        await new Promise((resolve) => {
          if (mockRes.chunks.length > 0 && !mockRes.writable) {
            resolve(true);
          } else {
            mockRes.on("finish", resolve);
          }
        });

        assert.strictEqual(mockRes.headers["content-type"], "application/pdf");
        assert.ok(
          mockRes.headers["content-disposition"].includes("Invoice-INV-2026-0001.pdf"),
        );

        const pdfBuffer = mockRes.getBuffer();
        assert.ok(pdfBuffer.length > 100);

        // Magic bytes check: "%PDF-" = 0x25 0x50 0x44 0x46 0x2D
        const magic = pdfBuffer.subarray(0, 5).toString("ascii");
        assert.strictEqual(magic, "%PDF-");
      } finally {
        Invoice.findOne = origFindOne;
        Payment.findById = origFindById;
      }
    });

    it("should throw 404 when invoice is not found", async () => {
      const origFindOne = Invoice.findOne;
      Invoice.findOne = ((_query: any) => Promise.resolve(null)) as any;

      try {
        await assert.rejects(
          async () => {
            const mockRes = new MockStreamResponse() as any;
            await streamInvoicePdf("NON-EXISTENT", mockRes);
          },
          /Invoice 'NON-EXISTENT' not found/i,
        );
      } finally {
        Invoice.findOne = origFindOne;
      }
    });

    it("should generate invoice PDF buffer in-memory for email attachments", async () => {
      const mockInvoice = {
        _id: new mongoose.Types.ObjectId(),
        invoiceNumber: "INV-2026-BUFFER",
        workspaceId: new mongoose.Types.ObjectId(),
        paymentId: new mongoose.Types.ObjectId(),
        issuedTo: {
          userName: "Anisur Rahman",
          userEmail: "anisur@vexchat.app",
          workspaceName: "Anisur Tech",
        },
        planCode: "STARTER",
        planName: "Starter Tier",
        billingCycle: "MONTHLY",
        periodCoveredStart: new Date(),
        periodCoveredEnd: new Date(),
        amount: 5000,
        currency: "BDT",
        status: "PAID",
        paymentMethod: "BKASH",
        createdAt: new Date(),
      };

      const buffer = await generateInvoicePdfBuffer(mockInvoice as any, null);
      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 0);
      assert.strictEqual(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
    });
  });

  describe("3. Payment Receipt PDF Streaming", () => {
    it("should reject receipt generation for non-COMPLETED payments", async () => {
      const origFindOne = Payment.findOne;
      Payment.findOne = ((_query: any) =>
        Promise.resolve({
          _id: new mongoose.Types.ObjectId(),
          status: "PENDING_VERIFICATION",
          amount: 25000,
        })) as any;

      try {
        await assert.rejects(
          async () => {
            await getCompletedPayment("PAY-PENDING");
          },
          /only available for COMPLETED payments/i,
        );
      } finally {
        Payment.findOne = origFindOne;
      }
    });

    it("should stream payment receipt PDF for COMPLETED payments with valid layout", async () => {
      const mockPayment = {
        _id: new mongoose.Types.ObjectId(),
        workspaceId: new mongoose.Types.ObjectId(),
        invoiceNumber: "INV-2026-REC",
        paymentMethod: "BKASH",
        planCode: "BUSINESS_PRO",
        planName: "Business Pro Tier",
        amount: 15000,
        currency: "BDT",
        status: "COMPLETED",
        idempotencyKey: "IDEM-REC-112233",
        gatewayData: {
          trxID: "BKASH-TRX-998877",
        },
        completedAt: new Date("2026-11-05"),
        createdAt: new Date("2026-11-05"),
      };

      const origFindOne = Payment.findOne;
      const origWorkspaceFindById = Workspace.findById;

      Payment.findOne = ((_query: any) => Promise.resolve(mockPayment)) as any;
      Workspace.findById = ((_id: any) =>
        Promise.resolve({ name: "Alpha Enterprises Ltd" })) as any;

      try {
        const mockRes = new MockStreamResponse() as any;
        await streamPaymentReceiptPdf(String(mockPayment._id), mockRes);

        await new Promise((resolve) => {
          if (mockRes.chunks.length > 0 && !mockRes.writable) {
            resolve(true);
          } else {
            mockRes.on("finish", resolve);
          }
        });

        assert.strictEqual(mockRes.headers["content-type"], "application/pdf");
        assert.ok(
          mockRes.headers["content-disposition"].includes("Receipt-INV-2026-REC.pdf"),
        );

        const pdfBuffer = mockRes.getBuffer();
        assert.ok(pdfBuffer.length > 100);
        assert.strictEqual(pdfBuffer.subarray(0, 5).toString("ascii"), "%PDF-");
      } finally {
        Payment.findOne = origFindOne;
        Workspace.findById = origWorkspaceFindById;
      }
    });
  });

  describe("4. Transactional Email Resend Service", () => {
    it("should resolve recipient, build PDF attachment, dispatch email, and record audit log", async () => {
      const mockInvoice = {
        _id: new mongoose.Types.ObjectId(),
        invoiceNumber: "INV-RESEND-01",
        workspaceId: new mongoose.Types.ObjectId(),
        paymentId: new mongoose.Types.ObjectId(),
        issuedTo: {
          userName: "Shakib Al Hasan",
          userEmail: "shakib@cricket.bd",
          workspaceName: "Shakib 75 Foundation",
        },
        planCode: "ENTERPRISE",
        planName: "Enterprise Plan",
        billingCycle: "MONTHLY",
        periodCoveredStart: new Date(),
        periodCoveredEnd: new Date(),
        amount: 50000,
        currency: "BDT",
        status: "PAID",
        paymentMethod: "CITY_BANK_TRANSFER",
        paidAt: new Date(),
        createdAt: new Date(),
      };

      const origFindOne = Invoice.findOne;
      const origPaymentFindById = Payment.findById;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      let auditSavedData: any = null;
      const mockSave = function (this: any) {
        auditSavedData = this;
        return Promise.resolve(this);
      };
      (mockSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockSave as any;

      Invoice.findOne = ((_query: any) => Promise.resolve(mockInvoice)) as any;
      Payment.findById = ((_id: any) =>
        Promise.resolve({
          _id: mockInvoice.paymentId,
          amount: 50000,
          status: "COMPLETED",
        })) as any;

      try {
        const result = await resendInvoiceEmailService(
          mockInvoice.invoiceNumber,
          { recipientEmail: "auditor@deloitte.bd" },
          adminActor,
        );

        assert.strictEqual(result.invoiceNumber, "INV-RESEND-01");
        assert.strictEqual(result.recipientEmail, "auditor@deloitte.bd");
        assert.ok(result.sentAt);

        // Verify audit log captured
        assert.ok(auditSavedData);
        assert.strictEqual(auditSavedData.eventType, "INVOICE_RESENT");
        assert.strictEqual(auditSavedData.adminEmail, "finance.head@vexchat.app");
        assert.strictEqual(
          auditSavedData.metadata?.recipientEmail,
          "auditor@deloitte.bd",
        );
        assert.strictEqual(auditSavedData.metadata?.amount, 50000);
      } finally {
        Invoice.findOne = origFindOne;
        Payment.findById = origPaymentFindById;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });

    it("should fallback to invoice.issuedTo.userEmail if no recipientEmail is provided", async () => {
      const mockInvoice = {
        _id: new mongoose.Types.ObjectId(),
        invoiceNumber: "INV-RESEND-FALLBACK",
        workspaceId: new mongoose.Types.ObjectId(),
        paymentId: new mongoose.Types.ObjectId(),
        issuedTo: {
          userName: "Mushfiqur Rahim",
          userEmail: "mushfiq@sports.bd",
          workspaceName: "MR 15 Sports",
        },
        planCode: "BUSINESS_PRO",
        planName: "Business Pro Tier",
        billingCycle: "MONTHLY",
        periodCoveredStart: new Date(),
        periodCoveredEnd: new Date(),
        amount: 15000,
        currency: "BDT",
        status: "PAID",
        paymentMethod: "BKASH",
        createdAt: new Date(),
      };

      const origFindOne = Invoice.findOne;
      const origPaymentFindById = Payment.findById;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      let capturedRecipient: string | null = null;
      const mockSaveFallback = function (this: any) {
        capturedRecipient = this.metadata?.recipientEmail;
        return Promise.resolve(this);
      };
      (mockSaveFallback as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockSaveFallback as any;

      Invoice.findOne = ((_query: any) => Promise.resolve(mockInvoice)) as any;
      Payment.findById = ((_id: any) => Promise.resolve(null)) as any;

      try {
        const result = await resendInvoiceEmailService(
          mockInvoice.invoiceNumber,
          {},
          adminActor,
        );

        assert.strictEqual(result.recipientEmail, "mushfiq@sports.bd");
        assert.strictEqual(capturedRecipient, "mushfiq@sports.bd");
      } finally {
        Invoice.findOne = origFindOne;
        Payment.findById = origPaymentFindById;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });
  });

  describe("5. Document Controller HTTP Handlers", () => {
    it("should respond with 400 when invoiceId is missing", async () => {
      const mockReq = { params: { invoiceId: "" } } as any;
      const mockRes = new MockStreamResponse() as any;

      await documentController.streamInvoicePdf(mockReq, mockRes, () => {});
      assert.strictEqual(mockRes.statusCode, 400);
      assert.strictEqual(mockRes.jsonData?.success, false);
      assert.ok(mockRes.jsonData?.error.includes("required"));
    });

    it("should respond with 404 when invoice is not found in controller", async () => {
      const mockReq = { params: { invoiceId: "NON_EXISTENT_ID" } } as any;
      const mockRes = new MockStreamResponse() as any;

      const origFindOne = Invoice.findOne;
      Invoice.findOne = ((_q: any) => Promise.resolve(null)) as any;

      try {
        await documentController.streamInvoicePdf(mockReq, mockRes, () => {});
        assert.strictEqual(mockRes.statusCode, 404);
        assert.strictEqual(mockRes.jsonData?.success, false);
        assert.ok(mockRes.jsonData?.error.includes("not found"));
      } finally {
        Invoice.findOne = origFindOne;
      }
    });

    it("should respond with 400 when receipt is requested for non-completed payment", async () => {
      const mockReq = { params: { paymentId: "PAY_INCOMPLETE" } } as any;
      const mockRes = new MockStreamResponse() as any;

      const origFindOne = Payment.findOne;
      Payment.findOne = ((_q: any) =>
        Promise.resolve({ _id: "PAY_INCOMPLETE", status: "FAILED" })) as any;

      try {
        await documentController.streamPaymentReceiptPdf(mockReq, mockRes, () => {});
        assert.strictEqual(mockRes.statusCode, 400);
        assert.strictEqual(mockRes.jsonData?.success, false);
        assert.ok(mockRes.jsonData?.error.includes("COMPLETED"));
      } finally {
        Payment.findOne = origFindOne;
      }
    });
  });

  describe("6. Route Registration & Platform Admin Architecture", () => {
    it("should register invoice streaming, receipt streaming, and email resend on platformAdminBillingRouter", () => {
      const routes = platformAdminBillingRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      const pdfRoute = routes.find((r) => r.path === "/invoices/:invoiceId/pdf");
      assert.ok(pdfRoute, "Missing /invoices/:invoiceId/pdf route");
      assert.ok(pdfRoute.methods.includes("get"));

      const receiptRoute = routes.find((r) => r.path === "/payments/:paymentId/receipt");
      assert.ok(receiptRoute, "Missing /payments/:paymentId/receipt route");
      assert.ok(receiptRoute.methods.includes("get"));

      const resendRoute = routes.find((r) => r.path === "/invoices/:invoiceId/resend");
      assert.ok(resendRoute, "Missing /invoices/:invoiceId/resend route");
      assert.ok(resendRoute.methods.includes("post"));
    });

    it("should register dashboard route aliases for documents on dashboardRouter", () => {
      const routes = dashboardRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      const dashboardPdfRoute = routes.find((r) => r.path === "/invoices/:invoiceId/pdf");
      assert.ok(dashboardPdfRoute, "Missing dashboard /invoices/:invoiceId/pdf alias");

      const dashboardReceiptRoute = routes.find((r) => r.path === "/payments/:paymentId/receipt");
      assert.ok(dashboardReceiptRoute, "Missing dashboard /payments/:paymentId/receipt alias");

      const dashboardResendRoute = routes.find((r) => r.path === "/invoices/:invoiceId/resend");
      assert.ok(dashboardResendRoute, "Missing dashboard /invoices/:invoiceId/resend alias");
    });
  });
});
