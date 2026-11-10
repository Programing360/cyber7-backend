import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import {
  workspaceSearchController,
  workspaceNotificationsController,
} from "../src/modules/workspace/workspace-search.controller.js";
import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import Campaign from "../src/modules/campaign/campaign.model.js";
import AutomationRule from "../src/modules/whatsapp/automation-rule.model.js";
import SupportTicket from "../src/modules/support/support-ticket.model.js";
import CallLog from "../src/modules/Calling/CallLog.js";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import User from "../src/modules/auth/user.model.js";
import Subscription from "../src/modules/billing/subscription.model.js";
import type { WorkspaceRequest } from "../src/middlewares/require-workspace-membership.js";

describe("Workspace Header — Search & Notifications Controller Suite", () => {
  const testWorkspaceId = new mongoose.Types.ObjectId().toString();

  it("should return empty search results when search query is blank", async () => {
    let responseStatus = 0;
    let responseBody: any = null;

    const req = {
      workspace: { id: testWorkspaceId, role: "OWNER", membershipId: "m1" },
      query: { q: "" },
    } as unknown as WorkspaceRequest;

    const res = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(data: any) {
        responseBody = data;
        return this;
      },
    } as any;

    await workspaceSearchController(req, res, () => {});

    assert.strictEqual(responseStatus, 200);
    assert.strictEqual(responseBody.success, true);
    assert.strictEqual(responseBody.data.totalCount, 0);
    assert.deepStrictEqual(responseBody.data.contacts, []);
    assert.deepStrictEqual(responseBody.data.campaigns, []);
  });

  it("should execute runtime search across contacts, campaigns, automations, tickets, calls, and navigation", async () => {
    const origContactFind = WhatsAppContact.find;
    const origCampaignFind = Campaign.find;
    const origAutoFind = AutomationRule.find;
    const origTicketFind = SupportTicket.find;
    const origCallFind = CallLog.find;

    try {
      const mockContactId = new mongoose.Types.ObjectId();
      const mockCampaignId = new mongoose.Types.ObjectId();
      const mockAutoId = new mongoose.Types.ObjectId();
      const mockTicketId = new mongoose.Types.ObjectId();
      const mockCallId = new mongoose.Types.ObjectId();

      WhatsAppContact.find = (() => ({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: mockContactId,
                profileName: "Rahim Ahmed",
                phoneNumber: "+8801711223344",
                waId: "8801711223344",
                leadStatus: "QUALIFIED",
              },
            ],
          }),
        }),
      })) as any;

      Campaign.find = (() => ({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: mockCampaignId,
                name: "Rahim Flash Sale",
                status: "SCHEDULED",
                totalRecipients: 50,
              },
            ],
          }),
        }),
      })) as any;

      AutomationRule.find = (() => ({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: mockAutoId,
                name: "Rahim Support Routing",
                trigger: "KEYWORD_MATCH",
                action: "SEND_MESSAGE",
                isActive: true,
              },
            ],
          }),
        }),
      })) as any;

      SupportTicket.find = (() => ({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: mockTicketId,
                ticketNumber: "TICK-9999",
                subject: "Question about Rahim order",
                priority: "HIGH",
                status: "OPEN",
              },
            ],
          }),
        }),
      })) as any;

      CallLog.find = (() => ({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: mockCallId,
                callerName: "Rahim Ahmed",
                phoneNumber: "+8801711223344",
                callType: "INCOMING",
                status: "ENDED",
              },
            ],
          }),
        }),
      })) as any;

      let responseStatus = 0;
      let responseBody: any = null;

      const req = {
        workspace: { id: testWorkspaceId, role: "OWNER", membershipId: "m1" },
        query: { q: "rahim" },
      } as unknown as WorkspaceRequest;

      const res = {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json(data: any) {
          responseBody = data;
          return this;
        },
      } as any;

      await workspaceSearchController(req, res, () => {});

      assert.strictEqual(responseStatus, 200);
      assert.strictEqual(responseBody.success, true);
      assert.strictEqual(responseBody.data.contacts.length, 1);
      assert.strictEqual(responseBody.data.contacts[0].title, "Rahim Ahmed");
      assert.strictEqual(responseBody.data.campaigns.length, 1);
      assert.strictEqual(responseBody.data.automations.length, 1);
      assert.strictEqual(responseBody.data.tickets.length, 1);
      assert.strictEqual(responseBody.data.calls.length, 1);
      assert.ok(responseBody.data.totalCount >= 5);
    } finally {
      WhatsAppContact.find = origContactFind;
      Campaign.find = origCampaignFind;
      AutomationRule.find = origAutoFind;
      SupportTicket.find = origTicketFind;
      CallLog.find = origCallFind;
    }
  });

  it("should match quick navigation pages when typing navigation keywords", async () => {
    const origContactFind = WhatsAppContact.find;
    const origCampaignFind = Campaign.find;
    const origAutoFind = AutomationRule.find;
    const origTicketFind = SupportTicket.find;
    const origCallFind = CallLog.find;

    try {
      const emptyFindMock = (() => ({
        select: () => ({
          limit: () => ({
            lean: async () => [],
          }),
        }),
      })) as any;

      WhatsAppContact.find = emptyFindMock;
      Campaign.find = emptyFindMock;
      AutomationRule.find = emptyFindMock;
      SupportTicket.find = emptyFindMock;
      CallLog.find = emptyFindMock;

      let responseStatus = 0;
      let responseBody: any = null;

      const req = {
        workspace: { id: testWorkspaceId, role: "OWNER", membershipId: "m1" },
        query: { q: "settings" },
      } as unknown as WorkspaceRequest;

      const res = {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json(data: any) {
          responseBody = data;
          return this;
        },
      } as any;

      await workspaceSearchController(req, res, () => {});

      assert.strictEqual(responseStatus, 200);
      assert.strictEqual(responseBody.success, true);
      assert.ok(responseBody.data.navigation.length > 0);
      const hasSettings = responseBody.data.navigation.some((n: any) => n.url === "/settings");
      assert.ok(hasSettings, "Should match /settings in navigation");
    } finally {
      WhatsAppContact.find = origContactFind;
      Campaign.find = origCampaignFind;
      AutomationRule.find = origAutoFind;
      SupportTicket.find = origTicketFind;
      CallLog.find = origCallFind;
    }
  });

  it("should aggregate runtime notifications across messages, calls, campaigns, and trial status", async () => {
    const origWsFind = Workspace.findById;
    const origMsgFind = WhatsAppMessage.find;
    const origCallFind = CallLog.find;
    const origCmpFind = Campaign.find;
    const origTktFind = SupportTicket.find;
    const origSubFind = Subscription.findOne;
    const origUserFind = User.findById;

    try {
      const mockOwnerId = new mongoose.Types.ObjectId();
      Workspace.findById = (() => ({
        select: () => ({
          lean: async () => ({
            _id: new mongoose.Types.ObjectId(testWorkspaceId),
            name: "Test Workspace",
            ownerId: mockOwnerId,
            status: "ACTIVE",
          }),
        }),
      })) as any;

      WhatsAppMessage.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId(),
                text: "Hello, this is a customer inquiry!",
                direction: "INBOUND",
                status: "RECEIVED",
                createdAt: new Date(),
              },
            ],
          }),
        }),
      })) as any;

      CallLog.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId(),
                callerName: "Customer Lead",
                phoneNumber: "+8801999999999",
                callType: "INCOMING",
                status: "MISSED",
                createdAt: new Date(),
              },
            ],
          }),
        }),
      })) as any;

      Campaign.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId(),
                name: "Welcome Broadcast",
                status: "COMPLETED",
                deliveredCount: 45,
                totalRecipients: 50,
                updatedAt: new Date(),
              },
            ],
          }),
        }),
      })) as any;

      SupportTicket.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId(),
                ticketNumber: "1002",
                subject: "Webhook configuration help",
                status: "OPEN",
                priority: "MEDIUM",
                updatedAt: new Date(),
              },
            ],
          }),
        }),
      })) as any;

      Subscription.findOne = (() => ({
        lean: async () => null,
      })) as any;

      User.findById = (() => ({
        select: () => ({
          lean: async () => ({
            _id: mockOwnerId,
            isPaid: false,
            trialEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days remaining
            subscriptionStatus: "trial",
          }),
        }),
      })) as any;

      let responseStatus = 0;
      let responseBody: any = null;

      const req = {
        workspace: { id: testWorkspaceId, role: "OWNER", membershipId: "m1" },
      } as unknown as WorkspaceRequest;

      const res = {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json(data: any) {
          responseBody = data;
          return this;
        },
      } as any;

      await workspaceNotificationsController(req, res, () => {});

      assert.strictEqual(responseStatus, 200);
      assert.strictEqual(responseBody.success, true);
      assert.ok(responseBody.data.notifications.length >= 4);

      // Verify trial notification presence
      const hasTrial = responseBody.data.notifications.some((n: any) => n.id === "sys-trial-status");
      assert.ok(hasTrial, "Should include trial status notification");

      // Verify unread count
      assert.ok(responseBody.data.unreadCount >= 2);
    } finally {
      Workspace.findById = origWsFind;
      WhatsAppMessage.find = origMsgFind;
      CallLog.find = origCallFind;
      Campaign.find = origCmpFind;
      SupportTicket.find = origTktFind;
      Subscription.findOne = origSubFind;
      User.findById = origUserFind;
    }
  });
});
