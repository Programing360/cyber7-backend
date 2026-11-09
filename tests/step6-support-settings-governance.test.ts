import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// Ensure test environment variables
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ||
  "test-jwt-access-secret-super-safe-and-long-enough-32-chars";

import SupportTicket from "../src/modules/support/support-ticket.model.js";
import PlatformSettings from "../src/modules/settings/platform-settings.model.js";
import AdminSession from "../src/modules/admin-auth/admin-session.model.js";
import User from "../src/modules/auth/user.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import AdminSecurityAuditLog from "../src/modules/admin-auth/admin-security-audit.model.js";

import {
  createTicketSchema,
  updateTicketStatusSchema,
  assignTicketSchema,
  addTicketMessageSchema,
  listTicketsQuerySchema,
} from "../src/modules/support/support-ticket.validation.js";
import { supportTicketService } from "../src/modules/support/support-ticket.service.js";

import { updatePlatformSettingsSchema } from "../src/modules/settings/platform-settings.validation.js";
import { platformSettingsService } from "../src/modules/settings/platform-settings.service.js";

import { probePaymentGatewaysHealth } from "../src/modules/billing/gateway-probe.service.js";
import { adminSessionService } from "../src/modules/admin-auth/admin-session.service.js";

import supportTicketRouter from "../src/modules/support/support-ticket.routes.js";
import platformSettingsRouter from "../src/modules/settings/platform-settings.routes.js";
import { platformAdminBillingRouter } from "../src/modules/billing/billing.routes.js";
import adminAuthRouter from "../src/modules/admin-auth/admin-auth.routes.js";
import dashboardRouter from "../src/modules/platform-admin-dashboard/dashboard.routes.js";

describe("Step 6: Support Desk Infrastructure & Platform Governance Test Suite", () => {
  const adminActor = {
    adminUserId: new mongoose.Types.ObjectId().toString(),
    adminEmail: "superadmin@vexchat.app",
    sessionId: new mongoose.Types.ObjectId().toString(),
    ipAddress: "10.0.0.1",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VexAdmin/1.0",
  };

  describe("1. Support Desk Validation Schemas", () => {
    it("should validate createTicketSchema correctly", () => {
      const valid = createTicketSchema.safeParse({
        workspaceId: new mongoose.Types.ObjectId().toString(),
        workspaceName: "Apex Retail",
        customerName: "Kazi Anis",
        customerEmail: "anis@apex.bd",
        subject: "WhatsApp webhook delivery issue",
        priority: "HIGH",
        initialMessage: "Our incoming webhook messages stopped arriving at 10 AM.",
      });
      assert.ok(valid.success);
      assert.strictEqual(valid.data.priority, "HIGH");

      const invalidEmail = createTicketSchema.safeParse({
        workspaceId: new mongoose.Types.ObjectId().toString(),
        customerName: "Kazi Anis",
        customerEmail: "invalid-email-address",
        subject: "Short",
        initialMessage: "Msg",
      });
      assert.strictEqual(invalidEmail.success, false);
    });

    it("should validate updateTicketStatusSchema", () => {
      const validStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
      for (const st of validStatuses) {
        const res = updateTicketStatusSchema.safeParse({ status: st });
        assert.ok(res.success);
      }

      const invalid = updateTicketStatusSchema.safeParse({
        status: "INVALID_STATUS",
      });
      assert.strictEqual(invalid.success, false);
    });

    it("should validate assignTicketSchema with valid admin ID and null", () => {
      const validId = assignTicketSchema.safeParse({
        assignedAdminId: new mongoose.Types.ObjectId().toString(),
      });
      assert.ok(validId.success);

      const validNull = assignTicketSchema.safeParse({
        assignedAdminId: null,
      });
      assert.ok(validNull.success);

      const invalid = assignTicketSchema.safeParse({
        assignedAdminId: "bad-id",
      });
      assert.strictEqual(invalid.success, false);
    });

    it("should validate addTicketMessageSchema and list query parameters", () => {
      const validMsg = addTicketMessageSchema.safeParse({
        content: "Investigating the webhook failure right now.",
        attachments: [
          { filename: "log.txt", url: "https://vexchat.io/logs/log.txt" },
        ],
      });
      assert.ok(validMsg.success);

      const queryValid = listTicketsQuerySchema.safeParse({
        page: "2",
        pageSize: "25",
        status: "OPEN",
        priority: "URGENT",
        search: "webhook",
      });
      assert.ok(queryValid.success);
      assert.strictEqual(queryValid.data.page, 2);
      assert.strictEqual(queryValid.data.pageSize, 25);
    });
  });

  describe("2. Support Ticket Lifecycle Service", () => {
    it("should create a support ticket with auto-generated ticketNumber and initial message", async () => {
      const wsId = new mongoose.Types.ObjectId();
      const origCount = SupportTicket.countDocuments;
      const origWsFind = Workspace.findById;
      const origSave = SupportTicket.prototype.save;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      let savedTicket: any = null;
      let auditLogCaptured: any = null;

      SupportTicket.countDocuments = (() => Promise.resolve(4)) as any;
      Workspace.findById = ((_id: any) =>
        Promise.resolve({ name: "Square Pharmaceuticals" })) as any;

      SupportTicket.prototype.save = function () {
        savedTicket = this;
        return Promise.resolve(this);
      } as any;

      const mockAuditSave = function (this: any) {
        auditLogCaptured = this;
        return Promise.resolve(this);
      };
      (mockAuditSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockAuditSave as any;

      try {
        const ticket = await supportTicketService.createTicket(
          {
            workspaceId: String(wsId),
            customerName: "Nafis Fuad",
            customerEmail: "fuad@square.bd",
            subject: "Billing invoice issue",
            priority: "URGENT",
            initialMessage: "We were charged twice for this billing cycle.",
            attachments: [],
          },
          adminActor,
        );

        assert.ok(ticket);
        assert.ok(ticket.ticketNumber.startsWith("TICK-"));
        assert.strictEqual(ticket.workspaceName, "Square Pharmaceuticals");
        assert.strictEqual(ticket.status, "OPEN");
        assert.strictEqual(ticket.messages.length, 1);
        assert.strictEqual(ticket.messages[0].senderRole, "PLATFORM_ADMIN");
        assert.strictEqual(
          ticket.messages[0].content,
          "We were charged twice for this billing cycle.",
        );

        assert.ok(auditLogCaptured);
        assert.strictEqual(
          auditLogCaptured.eventType,
          "SUPPORT_TICKET_CREATED",
        );
        assert.strictEqual(
          auditLogCaptured.metadata?.priority,
          "URGENT",
        );
      } finally {
        SupportTicket.countDocuments = origCount;
        Workspace.findById = origWsFind;
        SupportTicket.prototype.save = origSave;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });

    it("should assign a ticket to an admin and record audit log", async () => {
      const adminId = new mongoose.Types.ObjectId();
      const mockTicket = {
        _id: new mongoose.Types.ObjectId(),
        ticketNumber: "TICK-1005",
        assignedAdmin: null as any,
        save: function () {
          return Promise.resolve(this);
        },
      };

      const origFindOne = SupportTicket.findOne;
      const origUserFind = User.findById;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      let auditCaptured: any = null;
      SupportTicket.findOne = ((_q: any) => Promise.resolve(mockTicket)) as any;
      User.findById = ((_id: any) =>
        Promise.resolve({ _id: adminId, email: "agent@vexchat.app" })) as any;

      const mockAuditSave = function (this: any) {
        auditCaptured = this;
        return Promise.resolve(this);
      };
      (mockAuditSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockAuditSave as any;

      try {
        const res = await supportTicketService.assignTicket(
          "TICK-1005",
          String(adminId),
          adminActor,
        );

        assert.strictEqual(String(res.assignedAdmin), String(adminId));
        assert.ok(auditCaptured);
        assert.strictEqual(
          auditCaptured.eventType,
          "SUPPORT_TICKET_ASSIGNED",
        );
      } finally {
        SupportTicket.findOne = origFindOne;
        User.findById = origUserFind;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });

    it("should update ticket status to RESOLVED and record audit log", async () => {
      const mockTicket = {
        _id: new mongoose.Types.ObjectId(),
        ticketNumber: "TICK-1008",
        status: "IN_PROGRESS",
        save: function () {
          return Promise.resolve(this);
        },
      };

      const origFindOne = SupportTicket.findOne;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      let auditCaptured: any = null;
      SupportTicket.findOne = ((_q: any) => Promise.resolve(mockTicket)) as any;

      const mockAuditSave = function (this: any) {
        auditCaptured = this;
        return Promise.resolve(this);
      };
      (mockAuditSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockAuditSave as any;

      try {
        const res = await supportTicketService.updateStatus(
          "TICK-1008",
          "RESOLVED",
          adminActor,
        );

        assert.strictEqual(res.status, "RESOLVED");
        assert.ok(auditCaptured);
        assert.strictEqual(
          auditCaptured.eventType,
          "SUPPORT_TICKET_STATUS_UPDATED",
        );
        assert.strictEqual(auditCaptured.metadata?.previousStatus, "IN_PROGRESS");
        assert.strictEqual(auditCaptured.metadata?.newStatus, "RESOLVED");
      } finally {
        SupportTicket.findOne = origFindOne;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });

    it("should append reply message and auto-advance status from OPEN to IN_PROGRESS", async () => {
      const mockTicket = {
        _id: new mongoose.Types.ObjectId(),
        ticketNumber: "TICK-1010",
        status: "OPEN",
        messages: [] as any[],
        save: function () {
          return Promise.resolve(this);
        },
      };

      const origFindOne = SupportTicket.findOne;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      SupportTicket.findOne = ((_q: any) => Promise.resolve(mockTicket)) as any;

      let auditCaptured: any = null;
      const mockAuditSave = function (this: any) {
        auditCaptured = this;
        return Promise.resolve(this);
      };
      (mockAuditSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockAuditSave as any;

      try {
        const res = await supportTicketService.addMessage(
          "TICK-1010",
          {
            content: "We have issued a credit refund to your ledger balance.",
          },
          adminActor,
        );

        assert.strictEqual(res.status, "IN_PROGRESS");
        assert.strictEqual(res.messages.length, 1);
        assert.strictEqual(res.messages[0].senderRole, "PLATFORM_ADMIN");
        assert.ok(auditCaptured);
        assert.strictEqual(
          auditCaptured.eventType,
          "SUPPORT_TICKET_MESSAGE_ADDED",
        );
      } finally {
        SupportTicket.findOne = origFindOne;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });
  });

  describe("3. Dynamic Platform Settings (Singleton Pattern)", () => {
    it("should initialize and return default singleton platform settings if absent", async () => {
      const origFindOne = PlatformSettings.findOne;
      const origSave = PlatformSettings.prototype.save;

      PlatformSettings.findOne = ((_q: any) => Promise.resolve(null)) as any;
      PlatformSettings.prototype.save = function () {
        return Promise.resolve(this);
      } as any;

      try {
        const settings = await platformSettingsService.getSettings();
        assert.ok(settings);
        assert.strictEqual(settings.key, "GLOBAL_CONFIG");
        assert.strictEqual(settings.currency, "BDT");
        assert.strictEqual(settings.sessionPolicies.idleTimeoutMinutes, 15);
        assert.strictEqual(settings.sessionPolicies.absoluteLifetimeHours, 8);
        assert.strictEqual(
          settings.sessionPolicies.highValueStepUpThresholdBdt,
          50000,
        );
        assert.strictEqual(settings.gatewayToggles.bkashDirect, true);
        assert.strictEqual(settings.gatewayToggles.cityBankTransfer, true);
      } finally {
        PlatformSettings.findOne = origFindOne;
        PlatformSettings.prototype.save = origSave;
      }
    });

    it("should update system policies and gateway toggles and log PLATFORM_SETTINGS_UPDATED", async () => {
      const mockSettings = {
        key: "GLOBAL_CONFIG",
        currency: "BDT",
        sessionPolicies: {
          idleTimeoutMinutes: 15,
          absoluteLifetimeHours: 8,
          highValueStepUpThresholdBdt: 50000,
        },
        gatewayToggles: {
          bkashDirect: true,
          cityBankTransfer: true,
          portPosCards: true,
        },
        updatedBy: null as any,
        save: function () {
          return Promise.resolve(this);
        },
      };

      const origFindOne = PlatformSettings.findOne;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      PlatformSettings.findOne = ((_q: any) =>
        Promise.resolve(mockSettings)) as any;

      let auditCaptured: any = null;
      const mockAuditSave = function (this: any) {
        auditCaptured = this;
        return Promise.resolve(this);
      };
      (mockAuditSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockAuditSave as any;

      try {
        const updated = await platformSettingsService.updateSettings(
          {
            sessionPolicies: {
              idleTimeoutMinutes: 30,
              highValueStepUpThresholdBdt: 100000,
            },
            gatewayToggles: {
              portPosCards: false,
            },
          },
          adminActor,
        );

        assert.strictEqual(updated.sessionPolicies.idleTimeoutMinutes, 30);
        assert.strictEqual(
          updated.sessionPolicies.highValueStepUpThresholdBdt,
          100000,
        );
        assert.strictEqual(updated.sessionPolicies.absoluteLifetimeHours, 8); // preserved
        assert.strictEqual(updated.gatewayToggles.portPosCards, false);
        assert.strictEqual(updated.gatewayToggles.bkashDirect, true); // preserved

        assert.ok(auditCaptured);
        assert.strictEqual(
          auditCaptured.eventType,
          "PLATFORM_SETTINGS_UPDATED",
        );
      } finally {
        PlatformSettings.findOne = origFindOne;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });
  });

  describe("4. Non-Intrusive Payment Gateway Health Probe", () => {
    it("should execute non-intrusive probe returning latency, status, and modes", async () => {
      const report = await probePaymentGatewaysHealth();

      assert.ok(report.success);
      assert.ok(report.timestamp);
      assert.ok(
        report.overallStatus === "HEALTHY" || report.overallStatus === "DEGRADED",
      );

      assert.ok(report.gateways.bkash);
      assert.ok(
        ["HEALTHY", "DEGRADED", "DOWN"].includes(report.gateways.bkash.status),
      );
      assert.ok(typeof report.gateways.bkash.latencyMs === "number");
      assert.ok(report.gateways.bkash.mode.includes("CHECKOUT_URL"));

      assert.ok(report.gateways.cityBank);
      assert.ok(
        ["HEALTHY", "DEGRADED"].includes(report.gateways.cityBank.status),
      );
      assert.ok(typeof report.gateways.cityBank.latencyMs === "number");
    });
  });

  describe("5. Session Purge Utility", () => {
    it("should purge expired/revoked sessions and record ADMIN_SESSIONS_PURGED", async () => {
      const origDeleteMany = AdminSession.deleteMany;
      const origAuditSave = AdminSecurityAuditLog.prototype.save;

      AdminSession.deleteMany = ((_query: any) =>
        Promise.resolve({ deletedCount: 14 })) as any;

      let auditCaptured: any = null;
      const mockAuditSave = function (this: any) {
        auditCaptured = this;
        return Promise.resolve(this);
      };
      (mockAuditSave as any).mock = true;
      AdminSecurityAuditLog.prototype.save = mockAuditSave as any;

      try {
        const count = await adminSessionService.purgeSessions(adminActor);
        assert.strictEqual(count, 14);

        assert.ok(auditCaptured);
        assert.strictEqual(
          auditCaptured.eventType,
          "ADMIN_SESSIONS_PURGED",
        );
        assert.strictEqual(auditCaptured.metadata?.purgedCount, 14);
      } finally {
        AdminSession.deleteMany = origDeleteMany;
        AdminSecurityAuditLog.prototype.save = origAuditSave;
      }
    });
  });

  describe("6. Router Configuration & Platform Mounting", () => {
    it("should have supportTicketRouter routes mounted", () => {
      const routes = supportTicketRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      assert.ok(routes.some((r) => r.path === "/tickets" && r.methods.includes("get")));
      assert.ok(routes.some((r) => r.path === "/tickets" && r.methods.includes("post")));
      assert.ok(
        routes.some(
          (r) =>
            r.path === "/tickets/:ticketId/assign" && r.methods.includes("patch"),
        ),
      );
      assert.ok(
        routes.some(
          (r) =>
            r.path === "/tickets/:ticketId/status" && r.methods.includes("patch"),
        ),
      );
      assert.ok(
        routes.some(
          (r) =>
            r.path === "/tickets/:ticketId/messages" &&
            r.methods.includes("post"),
        ),
      );
    });

    it("should have platformSettingsRouter routes mounted", () => {
      const routes = platformSettingsRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      assert.ok(routes.some((r) => r.path === "/" && r.methods.includes("get")));
      assert.ok(routes.some((r) => r.path === "/" && r.methods.includes("patch")));
    });

    it("should have gateway health probe route mounted on platformAdminBillingRouter", () => {
      const routes = platformAdminBillingRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      assert.ok(
        routes.some(
          (r) => r.path === "/gateways/health" && r.methods.includes("get"),
        ),
      );
    });

    it("should have sessions purge mounted on adminAuthRouter", () => {
      const routes = adminAuthRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      assert.ok(
        routes.some(
          (r) => r.path === "/sessions/purge" && r.methods.includes("post"),
        ),
      );
    });

    it("should have dashboard aliases mounted on dashboardRouter", () => {
      const routes = dashboardRouter.stack
        .filter((r) => r.route)
        .map((r) => ({
          path: r.route?.path,
          methods: Object.keys(r.route?.methods || {}),
        }));

      assert.ok(
        routes.some(
          (r) =>
            r.path === "/billing/gateways/health" && r.methods.includes("get"),
        ),
      );
      assert.ok(
        routes.some(
          (r) =>
            r.path === "/auth/sessions/purge" && r.methods.includes("post"),
        ),
      );
    });
  });
});

