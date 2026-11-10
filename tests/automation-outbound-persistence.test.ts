import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import { broadcastNewMessage } from "../src/modules/services/whatsapp-message.service.js";

describe("Automation Outbound Message Persistence & Schema Integrity", () => {
  it("should instantiate an OUTBOUND message document with senderId='automation'", () => {
    const workspaceId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const whatsappAccountId = new Types.ObjectId();

    const message = new WhatsAppMessage({
      workspaceId,
      conversationId,
      contactId,
      whatsappAccountId,
      waMessageId: "wamid.HBgLMTIzNDU2Nzg5MA==",
      direction: "OUTBOUND",
      type: "TEXT",
      status: "SENT",
      text: "Hello! This is an automated welcome reply.",
      senderId: "automation",
      timestamp: new Date(),
    });

    assert.equal(message.direction, "OUTBOUND");
    assert.equal(message.status, "SENT");
    assert.equal(message.type, "TEXT");
    assert.equal(message.senderId, "automation");
    assert.equal(message.waMessageId, "wamid.HBgLMTIzNDU2Nzg5MA==");
    assert.equal(message.text, "Hello! This is an automated welcome reply.");

    // Validate that Mongoose schema validation passes without CastError on senderId='automation'
    const validationError = message.validateSync();
    assert.equal(validationError, undefined);
  });

  it("should instantiate an OUTBOUND message with a valid ObjectId user senderId", () => {
    const workspaceId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const whatsappAccountId = new Types.ObjectId();
    const agentUserId = new Types.ObjectId();

    const message = new WhatsAppMessage({
      workspaceId,
      conversationId,
      contactId,
      whatsappAccountId,
      waMessageId: "wamid.AGENT_REPLY_12345",
      direction: "OUTBOUND",
      type: "TEXT",
      status: "SENT",
      text: "Hello from human support agent!",
      senderId: agentUserId,
      timestamp: new Date(),
    });

    assert.equal(message.direction, "OUTBOUND");
    assert.equal(message.senderId?.toString(), agentUserId.toString());
    const validationError = message.validateSync();
    assert.equal(validationError, undefined);
  });

  it("should instantiate an OUTBOUND template message with senderId='automation'", () => {
    const workspaceId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const whatsappAccountId = new Types.ObjectId();

    const message = new WhatsAppMessage({
      workspaceId,
      conversationId,
      contactId,
      whatsappAccountId,
      waMessageId: "wamid.TEMPLATE_REPLY_54321",
      direction: "OUTBOUND",
      type: "TEMPLATE",
      status: "SENT",
      text: "Welcome to VexChat! Click below to confirm.",
      templateName: "welcome_onboarding",
      templateLanguage: "en",
      senderId: "automation",
      timestamp: new Date(),
    });

    assert.equal(message.direction, "OUTBOUND");
    assert.equal(message.type, "TEMPLATE");
    assert.equal(message.senderId, "automation");
    assert.equal(message.templateName, "welcome_onboarding");
    const validationError = message.validateSync();
    assert.equal(validationError, undefined);
  });

  it("should gracefully execute broadcastNewMessage without crashing when socket is uninitialized", () => {
    const workspaceId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const whatsappAccountId = new Types.ObjectId();

    const message = new WhatsAppMessage({
      _id: new Types.ObjectId(),
      workspaceId,
      conversationId,
      contactId,
      whatsappAccountId,
      waMessageId: "wamid.TEST_SOCKET_BROADCAST",
      direction: "OUTBOUND",
      type: "TEXT",
      status: "SENT",
      text: "Automated real-time broadcast test",
      senderId: "automation",
      timestamp: new Date(),
    });

    // Should not throw even if socket server is offline/null in unit test environment
    assert.doesNotThrow(() => {
      broadcastNewMessage(workspaceId, message);
    });
  });
});

