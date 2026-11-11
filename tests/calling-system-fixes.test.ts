import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import CallLog from "../src/modules/Calling/CallLog.js";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import WhatsAppConversation from "../src/modules/whatsapp/conversation.model.js";
import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import { createCallEndMessage } from "../src/modules/services/call-message.service.js";

describe("WebRTC WhatsApp Calling & Chat System Fixes Test Suite", () => {
  const workspaceId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();
  const contactId = new mongoose.Types.ObjectId();
  const conversationId = new mongoose.Types.ObjectId();
  const callId = new mongoose.Types.ObjectId();
  const testPhone = "+15559876543";

  describe("Issue 1 & 2: Schema Support for CANCELLED Status & Call Log Invariants", () => {
    it("should accept CANCELLED as a valid CallStatus enum value", () => {
      const call = new CallLog({
        _id: new mongoose.Types.ObjectId(),
        workspaceId,
        callSid: "call_cancel_test_123",
        phoneNumber: testPhone,
        callType: "OUTGOING",
        status: "CANCELLED",
        durationSeconds: 0,
      });

      const err = call.validateSync();
      assert.equal(err, undefined, "CANCELLED should be a valid CallStatus");
      assert.equal(call.status, "CANCELLED");
      assert.equal(call.durationSeconds, 0);
    });

    it("should accept voice_call and missed_call in WhatsAppMessage schema enum", () => {
      const voiceCallMsg = new WhatsAppMessage({
        _id: new mongoose.Types.ObjectId(),
        workspaceId,
        conversationId,
        contactId,
        whatsappAccountId: accountId,
        direction: "OUTBOUND",
        type: "voice_call",
        status: "DELIVERED",
        text: "Voice call (02:15)",
        timestamp: new Date(),
      });
      assert.equal(voiceCallMsg.validateSync(), undefined);

      const missedCallMsg = new WhatsAppMessage({
        _id: new mongoose.Types.ObjectId(),
        workspaceId,
        conversationId,
        contactId,
        whatsappAccountId: accountId,
        direction: "INBOUND",
        type: "missed_call",
        status: "DELIVERED",
        text: "Missed voice call",
        timestamp: new Date(),
      });
      assert.equal(missedCallMsg.validateSync(), undefined);
    });
  });

  describe("Issue 3 & 4: Call End Message Dispatcher & WhatsApp Chat Bubbles", () => {
    it("should create a missed_call message with 'Cancelled voice call' when status is CANCELLED", async () => {
      const cancelledCallId = new mongoose.Types.ObjectId();
      const mockCall = {
        _id: cancelledCallId,
        workspaceId,
        phoneNumber: testPhone,
        callType: "OUTGOING",
        status: "CANCELLED",
        durationSeconds: 0,
      };

      // Mock database queries
      const originalCallFindById = CallLog.findById;
      const originalContactFindOne = WhatsAppContact.findOne;
      const originalAccountFindOne = WhatsAppAccount.findOne;
      const originalConvFindOne = WhatsAppConversation.findOne;
      const originalMessageCreate = WhatsAppMessage.create;
      const originalMessageFindOne = WhatsAppMessage.findOne;

      let createdMessagePayload: any = null;

      try {
        CallLog.findById = (() => Promise.resolve(mockCall)) as any;

        WhatsAppMessage.findOne = (() => Promise.resolve(null)) as any;

        WhatsAppContact.findOne = (() =>
          Promise.resolve({
            _id: contactId,
            workspaceId,
            phoneNumber: testPhone,
          })) as any;

        WhatsAppAccount.findOne = (() =>
          Promise.resolve({
            _id: accountId,
            workspaceId,
            status: "CONNECTED",
          })) as any;

        const mockConvDoc = {
          _id: conversationId,
          workspaceId,
          contactId,
          whatsappAccountId: accountId,
          lastMessageAt: new Date(),
          save: async () => mockConvDoc,
        };

        WhatsAppConversation.findOne = (() => Promise.resolve(mockConvDoc)) as any;

        WhatsAppMessage.create = ((payload: any) => {
          createdMessagePayload = payload;
          return Promise.resolve({
            ...payload,
            _id: new mongoose.Types.ObjectId(),
            timestamp: payload.timestamp || new Date(),
          });
        }) as any;

        await createCallEndMessage(cancelledCallId);

        assert.ok(createdMessagePayload, "A message should be created");
        assert.equal(createdMessagePayload.type, "missed_call");
        assert.equal(createdMessagePayload.direction, "OUTBOUND");
        assert.equal(createdMessagePayload.text, "Cancelled voice call");
      } finally {
        CallLog.findById = originalCallFindById;
        WhatsAppContact.findOne = originalContactFindOne;
        WhatsAppAccount.findOne = originalAccountFindOne;
        WhatsAppConversation.findOne = originalConvFindOne;
        WhatsAppMessage.create = originalMessageCreate;
        WhatsAppMessage.findOne = originalMessageFindOne;
      }
    });

    it("should create a voice_call message with formatted duration for completed calls", async () => {
      const completedCallId = new mongoose.Types.ObjectId();
      const mockCall = {
        _id: completedCallId,
        workspaceId,
        phoneNumber: testPhone,
        callType: "OUTGOING",
        status: "ENDED",
        durationSeconds: 125, // 02:05
      };

      const originalCallFindById = CallLog.findById;
      const originalContactFindOne = WhatsAppContact.findOne;
      const originalAccountFindOne = WhatsAppAccount.findOne;
      const originalConvFindOne = WhatsAppConversation.findOne;
      const originalMessageCreate = WhatsAppMessage.create;
      const originalMessageFindOne = WhatsAppMessage.findOne;

      let createdMessagePayload: any = null;

      try {
        CallLog.findById = (() => Promise.resolve(mockCall)) as any;

        WhatsAppMessage.findOne = (() => Promise.resolve(null)) as any;

        WhatsAppContact.findOne = (() =>
          Promise.resolve({
            _id: contactId,
            workspaceId,
            phoneNumber: testPhone,
          })) as any;

        WhatsAppAccount.findOne = (() =>
          Promise.resolve({
            _id: accountId,
            workspaceId,
            status: "CONNECTED",
          })) as any;

        const mockConvDoc = {
          _id: conversationId,
          workspaceId,
          contactId,
          whatsappAccountId: accountId,
          lastMessageAt: new Date(),
          save: async () => mockConvDoc,
        };

        WhatsAppConversation.findOne = (() => Promise.resolve(mockConvDoc)) as any;

        WhatsAppMessage.create = ((payload: any) => {
          createdMessagePayload = payload;
          return Promise.resolve({
            ...payload,
            _id: new mongoose.Types.ObjectId(),
            timestamp: payload.timestamp || new Date(),
          });
        }) as any;

        await createCallEndMessage(completedCallId);

        assert.ok(createdMessagePayload, "A message should be created");
        assert.equal(createdMessagePayload.type, "voice_call");
        assert.equal(createdMessagePayload.direction, "OUTBOUND");
        assert.equal(createdMessagePayload.text, "Voice call • 02:05");
      } finally {
        CallLog.findById = originalCallFindById;
        WhatsAppContact.findOne = originalContactFindOne;
        WhatsAppAccount.findOne = originalAccountFindOne;
        WhatsAppConversation.findOne = originalConvFindOne;
        WhatsAppMessage.create = originalMessageCreate;
        WhatsAppMessage.findOne = originalMessageFindOne;
      }
    });
  });

  describe("Issue 5: WhatsApp Voice Message & Media Proxy Infrastructure", () => {
    it("should instantiate an AUDIO WhatsAppMessage with mediaId and audio/ogg mimeType", () => {
      const audioMsg = new WhatsAppMessage({
        _id: new mongoose.Types.ObjectId(),
        workspaceId,
        conversationId,
        contactId,
        whatsappAccountId: accountId,
        direction: "INBOUND",
        type: "AUDIO",
        status: "DELIVERED",
        mediaId: "wa_media_audio_12345",
        mediaMimeType: "audio/ogg; codecs=opus",
        timestamp: new Date(),
      });

      const err = audioMsg.validateSync();
      assert.equal(err, undefined, "AUDIO should be a valid WhatsAppMessageType");
      assert.equal(audioMsg.type, "AUDIO");
      assert.equal(audioMsg.mediaId, "wa_media_audio_12345");
      assert.equal(audioMsg.mediaMimeType, "audio/ogg; codecs=opus");
    });
  });
});
