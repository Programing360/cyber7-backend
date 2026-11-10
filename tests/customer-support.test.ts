import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import SupportTicket from "../src/modules/support/support-ticket.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import { supportTicketService } from "../src/modules/support/support-ticket.service.js";
import { customerSupportTicketController } from "../src/modules/support/customer-support.controller.js";
import type { WorkspaceRequest } from "../src/middlewares/require-workspace-membership.js";

describe("Workspace Customer Support Tickets — Service & Controller", () => {
  const testWorkspaceId = new mongoose.Types.ObjectId().toString();
  const testUserId = new mongoose.Types.ObjectId().toString();

  it("should create a customer support ticket with initial message", async () => {
    const origCount = SupportTicket.countDocuments;
    const origWsFind = Workspace.findById;
    const origSave = SupportTicket.prototype.save;

    try {
      SupportTicket.countDocuments = (() => Promise.resolve(2)) as any;
      Workspace.findById = ((_id: any) =>
        Promise.resolve({ name: "Acme Logistics" })) as any;

      let savedTicket: any = null;
      SupportTicket.prototype.save = function (this: any) {
        savedTicket = this;
        return Promise.resolve(this);
      };

      const ticket = await supportTicketService.createTicketAsCustomer(
        {
          workspaceId: testWorkspaceId,
          subject: "Webhook latency issues",
          category: "Technical Issue",
          priority: "HIGH",
          description: "Incoming webhooks are delayed by 5 minutes.",
          customerName: "Jane Doe",
          customerEmail: "jane@acme.com",
        },
        {
          userId: testUserId,
          userName: "Jane Doe",
          userEmail: "jane@acme.com",
        },
      );

      assert.ok(ticket);
      assert.equal(ticket.ticketNumber, "TICK-1003");
      assert.equal(ticket.workspaceName, "Acme Logistics");
      assert.equal(ticket.priority, "HIGH");
      assert.equal(ticket.status, "OPEN");
      assert.equal(ticket.messages.length, 1);
      assert.equal(ticket.messages[0].senderRole, "CUSTOMER");
      assert.equal(
        ticket.messages[0].content,
        "Incoming webhooks are delayed by 5 minutes.",
      );
    } finally {
      SupportTicket.countDocuments = origCount;
      Workspace.findById = origWsFind;
      SupportTicket.prototype.save = origSave;
    }
  });

  it("should list tickets scoped to workspace and compute stats accurately", async () => {
    const origFind = SupportTicket.find;
    const origCount = SupportTicket.countDocuments;

    try {
      const mockTickets = [
        {
          _id: new mongoose.Types.ObjectId(),
          ticketNumber: "TICK-1001",
          workspaceId: new mongoose.Types.ObjectId(testWorkspaceId),
          subject: "Issue 1",
          priority: "MEDIUM",
          status: "OPEN",
          messages: [],
          createdAt: new Date(),
        },
      ];

      SupportTicket.find = (() => ({
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: async () => mockTickets,
              }),
            }),
          }),
        }),
      })) as any;

      SupportTicket.countDocuments = ((query: any) => {
        if (query?.status === "OPEN") return Promise.resolve(1);
        if (query?.status === "IN_PROGRESS") return Promise.resolve(2);
        if (query?.status?.$in) return Promise.resolve(3);
        return Promise.resolve(6);
      }) as any;

      const result = await supportTicketService.listTickets({
        workspaceId: testWorkspaceId,
        page: 1,
        pageSize: 10,
      });

      assert.equal(result.items.length, 1);
      assert.equal(result.total, 6);
      assert.ok(result.stats);
      assert.equal(result.stats.total, 6);
      assert.equal(result.stats.open, 1);
      assert.equal(result.stats.inProgress, 2);
      assert.equal(result.stats.resolved, 3);
    } finally {
      SupportTicket.find = origFind;
      SupportTicket.countDocuments = origCount;
    }
  });

  it("should append customer reply and reopen resolved ticket", async () => {
    const origFindOne = SupportTicket.findOne;
    const origSave = SupportTicket.prototype.save;

    try {
      const mockTicketDoc: any = {
        _id: new mongoose.Types.ObjectId(),
        ticketNumber: "TICK-1002",
        workspaceId: new mongoose.Types.ObjectId(testWorkspaceId),
        status: "RESOLVED",
        priority: "MEDIUM",
        messages: [
          {
            senderId: new mongoose.Types.ObjectId(),
            senderRole: "CUSTOMER",
            content: "First question",
            createdAt: new Date(),
          },
        ],
        save: async function () {
          return this;
        },
      };

      SupportTicket.findOne = (() => Promise.resolve(mockTicketDoc)) as any;

      const updated = await supportTicketService.addMessageAsCustomer(
        "TICK-1002",
        testWorkspaceId,
        "The problem happened again today.",
        {
          userId: testUserId,
          userName: "Jane Doe",
          userEmail: "jane@acme.com",
        },
      );

      assert.equal(updated.messages.length, 2);
      assert.equal(updated.messages[1].content, "The problem happened again today.");
      assert.equal(updated.messages[1].senderRole, "CUSTOMER");
      // Reopened from RESOLVED to OPEN
      assert.equal(updated.status, "OPEN");
    } finally {
      SupportTicket.findOne = origFindOne;
      SupportTicket.prototype.save = origSave;
    }
  });

  it("should respond with 200 from customerSupportTicketController.listTickets", async () => {
    const origFind = SupportTicket.find;
    const origCount = SupportTicket.countDocuments;

    try {
      SupportTicket.find = (() => ({
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: async () => [],
              }),
            }),
          }),
        }),
      })) as any;

      SupportTicket.countDocuments = (() => Promise.resolve(0)) as any;

      let statusCode = 0;
      let responseBody: any = null;

      const req = {
        workspace: { id: testWorkspaceId, role: "OWNER" },
        user: { id: testUserId, name: "Test User", email: "test@user.com" },
        query: {},
      } as unknown as WorkspaceRequest;

      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (data: any) => {
          responseBody = data;
          return res;
        },
      } as any;

      const next = (err?: any) => {
        if (err) throw err;
      };

      await customerSupportTicketController.listTickets(req, res, next);

      assert.equal(statusCode, 200);
      assert.equal(responseBody.success, true);
      assert.ok(responseBody.data.items);
    } finally {
      SupportTicket.find = origFind;
      SupportTicket.countDocuments = origCount;
    }
  });
});

