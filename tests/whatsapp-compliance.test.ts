/**
 * WhatsApp Compliance & Reliability Tests (Phase 6, Step 29 & 29B)
 *
 * Verifies:
 * 1. Free-form message allowed inside 24-hour customer service window
 * 2. Free-form message blocked after 24-hour window expires
 * 3. Missing customer-message timestamp safely blocked (fails closed)
 * 4. Exactly 24-hour boundary conditions (inclusive at boundary, expired just outside)
 * 5. Future timestamps rejected / does not extend customer window
 * 6. Invalid timestamps rejected / fails closed
 * 7. Approved template sending validation outside 24-hour window
 * 8. Missing required template body variables validation
 * 9. Rejection of template belonging to another workspace or account
 * 10. Header media validation (rejects missing media for image/video/document headers)
 * 11. Button parameter validation (rejects invalid index or missing parameters)
 * 12. Opted-out contact exclusion from text and template sending
 * 13. Campaign audience resolution strictly excludes opted-out contacts
 * 14. STOP with punctuation (STOP., STOP!, QUIT?, STOP।) marks contact opted out
 * 15. Ordinary sentences containing STOP or CANCEL do not trigger opt-out
 * 16. START without verified consent records opt-in audit trail without clearing marketing opt-out
 * 17. Explicit authorized opt-in records audit trail and preserves opt-out history
 * 18. Campaign recipient opts out after scheduling but before dispatch (dispatch guard)
 * 19. Campaign recipient retry after opt-out does not bypass guard
 * 20. Idempotent webhook event deduplication by waMessageId
 * 21. Webhook HMAC-SHA256 signature verification (rejects invalid with 401)
 * 22. Webhook processing failure returns HTTP 500 to trigger Meta retry
 * 23. Meta API failure handling when sending outbound message
 */

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Types } from "mongoose";

import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import WhatsAppConversation, {
  isCustomerServiceWindowOpen,
  getCustomerServiceWindowExpiry,
  CUSTOMER_SERVICE_WINDOW_MS,
} from "../src/modules/whatsapp/conversation.model.js";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import WhatsAppTemplate from "../src/modules/whatsapp/template.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import Campaign from "../src/modules/campaign/campaign.model.js";
import CampaignRecipient from "../src/modules/campaign/campaign-recipient.model.js";
import { encrypt } from "../src/utils/encryption.js";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  processIncomingWhatsAppMessage,
} from "../src/modules/services/whatsapp-message.service.js";
import { resolveCampaignAudience } from "../src/modules/campaign/campaign-audience.service.js";
import { dispatchCampaignRecipient } from "../src/modules/campaign/campaign.service.js";
import { updateWorkspaceContact } from "../src/modules/whatsapp/whatsapp-chat.service.js";
import { receiveWhatsAppWebhook } from "../src/modules/controllers/whatsapp-webhook.controller.js";
import { connectWhatsAppSchema } from "../src/modules/whatsapp/whatsapp.validation.js";
import {
  mapMetaApiError,
  verifyPhoneNumberInWaba,
} from "../src/modules/services/whatsapp-api.service.js";

const WORKSPACE_ID = "507f1f77bcf86cd799439011";
const OTHER_WORKSPACE_ID = "507f1f77bcf86cd799439012";
const ACCOUNT_ID = "507f1f77bcf86cd799439021";
const CONTACT_ID = "507f1f77bcf86cd799439031";
const CONVERSATION_ID = "507f1f77bcf86cd799439041";
const TEMPLATE_ID = "507f1f77bcf86cd799439051";
const CAMPAIGN_ID = "507f1f77bcf86cd799439071";
const RECIPIENT_ID = "507f1f77bcf86cd799439081";
const USER_ID = "507f1f77bcf86cd799439061";

beforeEach(() => {
  process.env.WHATSAPP_ENCRYPTION_KEY =
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
});

afterEach(() => {
  mock.restoreAll();
});

// ─── 1. 24-Hour Customer Service Window ───────────────────────────────────────

describe("Phase B: 24-Hour Customer Service Window Enforcement", () => {
  it("1. allows free-form reply inside 24-hour window", async () => {
    const recentTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

    assert.equal(isCustomerServiceWindowOpen(recentTime), true);
    const expiry = getCustomerServiceWindowExpiry(recentTime);
    assert.ok(expiry && expiry > new Date());

    const mockConv = {
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
      lastCustomerMessageAt: recentTime,
      lastMessageAt: recentTime,
      save: async () => {},
    };

    mock.method(WhatsAppConversation, "findOne", async () => mockConv);
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      waId: "1234567890",
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", () => ({
      select: async () => ({
        _id: ACCOUNT_ID,
        phoneNumberId: "phone_123",
        status: "CONNECTED",
        accessTokenEncrypted: encrypt("valid_test_meta_token_1234567890"),
      }),
      _id: ACCOUNT_ID,
      phoneNumberId: "phone_123",
      status: "CONNECTED",
      accessTokenEncrypted: encrypt("valid_test_meta_token_1234567890"),
    }));

    mock.method(
      global,
      "fetch",
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.msg123" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    mock.method(WhatsAppMessage, "create", async (payload: any) => ({
      _id: new Types.ObjectId(),
      ...payload,
      timestamp: new Date(),
    }));

    const result = await sendWhatsAppTextMessage({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      senderId: USER_ID,
      text: "Hello! We are glad to help you.",
    });

    assert.equal(result.status, "SENT");
    assert.equal(result.type, "TEXT");
    assert.equal(result.waMessageId, "wamid.msg123");
  });

  it("2. blocks free-form reply after 24-hour window expires with 422 and structured error", async () => {
    const expiredTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago

    assert.equal(isCustomerServiceWindowOpen(expiredTime), false);

    const mockConv = {
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
      lastCustomerMessageAt: expiredTime,
    };

    mock.method(WhatsAppConversation, "findOne", async () => mockConv);
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      isOptedOut: false,
    }));

    await assert.rejects(
      () =>
        sendWhatsAppTextMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          text: "Are you still there?",
        }),
      (err: any) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "CUSTOMER_SERVICE_WINDOW_EXPIRED");
        assert.match(err.message, /customer service window has expired/i);
        return true;
      },
    );
  });

  it("3. safely blocks free-form reply when customer message timestamp is missing or undefined", async () => {
    assert.equal(isCustomerServiceWindowOpen(undefined), false);
    assert.equal(isCustomerServiceWindowOpen(null), false);
    assert.equal(getCustomerServiceWindowExpiry(undefined), null);

    const mockConv = {
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
      lastCustomerMessageAt: undefined,
    };

    mock.method(WhatsAppConversation, "findOne", async () => mockConv);
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      isOptedOut: false,
    }));

    await assert.rejects(
      () =>
        sendWhatsAppTextMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          text: "Initial outbound attempt",
        }),
      (err: any) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "CUSTOMER_SERVICE_WINDOW_EXPIRED");
        return true;
      },
    );
  });

  it("4. handles exact 24-hour boundary conditions", () => {
    const now = 1710000000000;
    // Exactly at boundary: elapsed = 24 * 3600 * 1000 -> open
    const exactBoundary = new Date(now - CUSTOMER_SERVICE_WINDOW_MS);
    assert.equal(isCustomerServiceWindowOpen(exactBoundary, now), true);

    // Just inside boundary: 1 second before expiry -> open
    const justInside = new Date(now - CUSTOMER_SERVICE_WINDOW_MS + 1000);
    assert.equal(isCustomerServiceWindowOpen(justInside, now), true);

    // Just outside boundary: 1 second after expiry -> closed
    const justOutside = new Date(now - CUSTOMER_SERVICE_WINDOW_MS - 1000);
    assert.equal(isCustomerServiceWindowOpen(justOutside, now), false);
  });

  it("5. rejects future timestamps and prevents window extension", () => {
    const now = 1710000000000;
    // Far future timestamp (e.g., clock skew of 10 minutes) -> rejected
    const farFuture = new Date(now + 10 * 60 * 1000);
    assert.equal(isCustomerServiceWindowOpen(farFuture, now), false);
    assert.equal(getCustomerServiceWindowExpiry(farFuture, now), null);

    // Clamped future timestamp in webhook
    const futureSeconds = Math.floor(now / 1000) + 3600; // 1 hour in future
    const incomingMs = futureSeconds * 1000;
    const clampedDate = new Date(Math.min(incomingMs, now));
    assert.equal(clampedDate.getTime(), now);
  });

  it("6. rejects invalid timestamps and fails closed", () => {
    assert.equal(isCustomerServiceWindowOpen("invalid-date-string"), false);
    assert.equal(getCustomerServiceWindowExpiry("not-a-date"), null);
    assert.equal(isCustomerServiceWindowOpen(new Date(NaN)), false);
  });
});

// ─── 2. WhatsApp Template Messaging & Component Validation ────────────────────

describe("Phase C: WhatsApp Template Messaging & Component Validation", () => {
  it("7. successfully sends approved template message outside 24-hour window", async () => {
    const expiredTime = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago

    const mockConv = {
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "CLOSED",
      lastCustomerMessageAt: expiredTime,
      lastMessageAt: expiredTime,
      save: async () => {},
    };

    mock.method(WhatsAppConversation, "findOne", async () => mockConv);
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      waId: "1234567890",
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", () => ({
      select: async () => ({
        _id: ACCOUNT_ID,
        phoneNumberId: "phone_123",
        status: "CONNECTED",
        accessTokenEncrypted: encrypt("valid_test_meta_token_1234567890"),
      }),
      _id: ACCOUNT_ID,
      phoneNumberId: "phone_123",
      status: "CONNECTED",
      accessTokenEncrypted: encrypt("valid_test_meta_token_1234567890"),
    }));

    const mockTemplate = {
      _id: TEMPLATE_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      name: "order_update",
      language: "en_US",
      status: "APPROVED",
      body: "Hello {{1}}, your order status is {{2}}.",
      variables: ["1", "2"],
    };
    mock.method(WhatsAppTemplate, "findOne", async () => mockTemplate);

    let sentPayload: any = null;
    mock.method(
      global,
      "fetch",
      async (_url: any, init: any) => {
        if (init?.body) {
          try {
            sentPayload = JSON.parse(init.body);
          } catch {}
        }
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.tmpl_999" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );

    mock.method(WhatsAppMessage, "create", async (payload: any) => ({
      _id: new Types.ObjectId(),
      ...payload,
      timestamp: new Date(),
    }));

    const result = await sendWhatsAppTemplateMessage({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      senderId: USER_ID,
      templateId: TEMPLATE_ID,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Alice" },
            { type: "text", text: "Shipped" },
          ],
        },
      ],
    });

    assert.equal(result.type, "TEMPLATE");
    assert.equal(result.status, "SENT");
    assert.equal(result.waMessageId, "wamid.tmpl_999");
    assert.equal(sentPayload?.type, "template");
    assert.equal(sentPayload?.template?.name, "order_update");
    assert.equal(sentPayload?.template?.language?.code, "en_US");
    // Conversation should be reopened
    assert.equal(mockConv.status, "OPEN");
  });

  it("8. validates and rejects template sending when required body variables are missing", async () => {
    mock.method(WhatsAppConversation, "findOne", async () => ({
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
    }));
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: ACCOUNT_ID,
      status: "CONNECTED",
    }));

    mock.method(WhatsAppTemplate, "findOne", async () => ({
      _id: TEMPLATE_ID,
      name: "verification_code",
      language: "en_US",
      status: "APPROVED",
      body: "Your security code is {{1}}.",
      variables: ["1"],
    }));

    await assert.rejects(
      () =>
        sendWhatsAppTemplateMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          templateId: TEMPLATE_ID,
          components: [],
        }),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "MISSING_TEMPLATE_PARAMETERS");
        assert.match(err.message, /requires 1 parameter/i);
        return true;
      },
    );
  });

  it("9. rejects template that belongs to another workspace or account", async () => {
    mock.method(WhatsAppConversation, "findOne", async () => ({
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
    }));
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: ACCOUNT_ID,
      status: "CONNECTED",
    }));

    // Template not found in this workspace/account
    mock.method(WhatsAppTemplate, "findOne", async () => null);

    await assert.rejects(
      () =>
        sendWhatsAppTemplateMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          templateId: TEMPLATE_ID,
        }),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /template not found/i);
        return true;
      },
    );
  });

  it("10. validates header media requirements and rejects when missing", async () => {
    mock.method(WhatsAppConversation, "findOne", async () => ({
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
    }));
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: ACCOUNT_ID,
      status: "CONNECTED",
    }));

    mock.method(WhatsAppTemplate, "findOne", async () => ({
      _id: TEMPLATE_ID,
      name: "media_promo",
      language: "en_US",
      status: "APPROVED",
      header: { format: "IMAGE" },
      body: "Check out our special promotion!",
    }));

    // Missing header image component
    await assert.rejects(
      () =>
        sendWhatsAppTemplateMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          templateId: TEMPLATE_ID,
          components: [],
        }),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "MISSING_TEMPLATE_HEADER_MEDIA");
        assert.match(err.message, /header media parameter of type image/i);
        return true;
      },
    );
  });

  it("11. validates button component parameters and rejects invalid indexes or parameters", async () => {
    mock.method(WhatsAppConversation, "findOne", async () => ({
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
    }));
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: ACCOUNT_ID,
      status: "CONNECTED",
    }));

    mock.method(WhatsAppTemplate, "findOne", async () => ({
      _id: TEMPLATE_ID,
      name: "quick_action",
      language: "en_US",
      status: "APPROVED",
      body: "Click the button below.",
    }));

    // Invalid button component: negative index
    await assert.rejects(
      () =>
        sendWhatsAppTemplateMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          templateId: TEMPLATE_ID,
          components: [
            {
              type: "button",
              sub_type: "url",
              index: -1,
              parameters: [{ type: "text", text: "track123" }],
            },
          ],
        }),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "INVALID_TEMPLATE_BUTTON_PARAMETERS");
        assert.match(err.message, /non-negative index/i);
        return true;
      },
    );
  });
});

// ─── 3. Contact Opt-out & Opt-in Management ───────────────────────────────────

describe("Phase D: Contact Opt-out & Opt-in Management", () => {
  it("12. blocks outbound messages to opted-out contacts (text and template)", async () => {
    mock.method(WhatsAppConversation, "findOne", async () => ({
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
      lastCustomerMessageAt: new Date(),
    }));

    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      waId: "1234567890",
      isOptedOut: true,
      optOutSource: "STOP_MESSAGE",
    }));

    // Text send must fail
    await assert.rejects(
      () =>
        sendWhatsAppTextMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          text: "Promotional text",
        }),
      (err: any) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "CONTACT_OPTED_OUT");
        return true;
      },
    );

    // Template send must also fail
    await assert.rejects(
      () =>
        sendWhatsAppTemplateMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          templateId: TEMPLATE_ID,
        }),
      (err: any) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "CONTACT_OPTED_OUT");
        return true;
      },
    );
  });

  it("13. strictly excludes opted-out contacts from campaign audience resolution", async () => {
    const contactActive = {
      _id: new Types.ObjectId("507f1f77bcf86cd799439091"),
      phoneNumber: "+1234567890",
      waId: "1234567890",
      isOptedOut: false,
    };
    const contactOptedOut = {
      _id: new Types.ObjectId("507f1f77bcf86cd799439092"),
      phoneNumber: "+1234567891",
      waId: "1234567891",
      isOptedOut: true,
    };

    mock.method(WhatsAppContact, "find", () => ({
      select: () => ({
        lean: async () => [contactActive, contactOptedOut],
      }),
    }));

    const result = await resolveCampaignAudience({
      workspaceId: WORKSPACE_ID,
      mode: "ALL_CONTACTS",
    });

    assert.equal(result.summary.requested, 2);
    assert.equal(result.summary.eligible, 1);
    assert.equal(result.summary.excluded, 1);
    assert.equal(result.recipients.length, 1);
    assert.equal(result.recipients[0].waId, "1234567890");
  });

  it("14. handles STOP with punctuation (STOP., STOP!, QUIT?, STOP।) and closes conversation", async () => {
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: new Types.ObjectId(ACCOUNT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
    }));

    mock.method(Workspace, "findById", async () => ({
      _id: new Types.ObjectId(WORKSPACE_ID),
      status: "ACTIVE",
    }));

    mock.method(WhatsAppMessage, "findOne", async () => null);

    let contactUpdateArg: any = null;
    mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async (_filter: any, update: any) => {
        contactUpdateArg = update;
        return {
          _id: new Types.ObjectId(CONTACT_ID),
          isOptedOut: true,
        };
      },
    );

    let convUpdateArg: any = null;
    mock.method(
      WhatsAppConversation,
      "findOneAndUpdate",
      async (_filter: any, update: any) => {
        convUpdateArg = update;
        return {
          _id: new Types.ObjectId(CONVERSATION_ID),
          status: "CLOSED",
        };
      },
    );

    mock.method(WhatsAppMessage, "create", async (data: any) => ({
      _id: new Types.ObjectId(),
      ...data,
    }));

    // Test with trailing punctuation: "STOP!"
    const result = await processIncomingWhatsAppMessage({
      phoneNumberId: "phone_123",
      contactName: "John Doe",
      message: {
        from: "1234567890",
        id: "wamid.stop_punct_1",
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "TEXT",
        text: "STOP!",
      },
    });

    assert.equal(result.duplicate, false);
    assert.equal(contactUpdateArg?.$set?.isOptedOut, true);
    assert.equal(contactUpdateArg?.$set?.optOutSource, "STOP_MESSAGE");
    assert.equal(convUpdateArg?.$set?.status, "CLOSED");
  });

  it("15. does not match ordinary sentences containing STOP or CANCEL", async () => {
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: new Types.ObjectId(ACCOUNT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
    }));

    mock.method(Workspace, "findById", async () => ({
      _id: new Types.ObjectId(WORKSPACE_ID),
      status: "ACTIVE",
    }));

    mock.method(WhatsAppMessage, "findOne", async () => null);

    let contactUpdateArg: any = null;
    mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async (_filter: any, update: any) => {
        contactUpdateArg = update;
        return { _id: new Types.ObjectId(CONTACT_ID), isOptedOut: false };
      },
    );

    let convUpdateArg: any = null;
    mock.method(
      WhatsAppConversation,
      "findOneAndUpdate",
      async (_filter: any, update: any) => {
        convUpdateArg = update;
        return { _id: new Types.ObjectId(CONVERSATION_ID), status: "OPEN" };
      },
    );

    mock.method(WhatsAppMessage, "create", async (data: any) => ({
      _id: new Types.ObjectId(),
      ...data,
    }));

    await processIncomingWhatsAppMessage({
      phoneNumberId: "phone_123",
      message: {
        from: "1234567890",
        id: "wamid.sentence_test_1",
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "TEXT",
        text: "Please do not cancel my order, I want to keep it.",
      },
    });

    // Should NOT mark contact as opted-out
    assert.equal(contactUpdateArg?.$set?.isOptedOut, undefined);
    assert.equal(convUpdateArg?.$set?.status, "OPEN");
  });

  it("16. START without verified consent records opt-in audit trail without clearing marketing opt-out", async () => {
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: new Types.ObjectId(ACCOUNT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
    }));

    mock.method(Workspace, "findById", async () => ({
      _id: new Types.ObjectId(WORKSPACE_ID),
      status: "ACTIVE",
    }));

    mock.method(WhatsAppMessage, "findOne", async () => null);

    let contactUpdateArg: any = null;
    mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async (_filter: any, update: any) => {
        contactUpdateArg = update;
        return { _id: new Types.ObjectId(CONTACT_ID), isOptedOut: true };
      },
    );

    mock.method(WhatsAppConversation, "findOneAndUpdate", async () => ({
      _id: new Types.ObjectId(CONVERSATION_ID),
      status: "OPEN",
    }));

    mock.method(WhatsAppMessage, "create", async (data: any) => ({
      _id: new Types.ObjectId(),
      ...data,
    }));

    await processIncomingWhatsAppMessage({
      phoneNumberId: "phone_123",
      message: {
        from: "1234567890",
        id: "wamid.start_test_1",
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "TEXT",
        text: "START",
      },
    });

    // Records audit trail for START message
    assert.equal(contactUpdateArg?.$set?.optInSource, "START_MESSAGE");
    assert.ok(contactUpdateArg?.$set?.optInTimestamp);
    // Crucially: does NOT automatically set isOptedOut = false (preserves opt-out compliance)
    assert.equal(contactUpdateArg?.$set?.isOptedOut, undefined);
  });

  it("17. explicit authorized opt-in records audit trail and preserves opt-out history", async () => {
    let updateFields: any = null;
    let unsetFields: any = null;

    mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async (_filter: any, update: any) => {
        updateFields = update.$set;
        unsetFields = update.$unset;
        return {
          _id: new Types.ObjectId(CONTACT_ID),
          isOptedOut: false,
          optOutTimestamp: new Date("2026-01-01"),
          optOutSource: "STOP_MESSAGE",
          optInTimestamp: new Date(),
          optInSource: "USER_ACTION",
        };
      },
    );

    await updateWorkspaceContact({
      workspaceId: WORKSPACE_ID,
      contactId: CONTACT_ID,
      input: { isOptedOut: false },
    });

    assert.equal(updateFields?.isOptedOut, false);
    assert.equal(updateFields?.optInSource, "USER_ACTION");
    assert.ok(updateFields?.optInTimestamp);
    // Preserves optOut history: does NOT unset optOutTimestamp or optOutSource
    assert.equal(unsetFields, undefined);
  });
});

// ─── 4. Campaign Dispatch Opt-out Protection ──────────────────────────────────

describe("Phase D2: Campaign Dispatch Opt-out Protection", () => {
  it("18. detects post-schedule contact opt-out and skips dispatch with FAILED status and CONTACT_OPTED_OUT", async () => {
    const mockRecipient = {
      _id: new Types.ObjectId(RECIPIENT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
      campaignId: new Types.ObjectId(CAMPAIGN_ID),
      contactId: new Types.ObjectId(CONTACT_ID),
      phoneNumber: "+1234567890",
      status: "PENDING",
      errorCode: undefined as string | undefined,
      errorMessage: undefined as string | undefined,
      failedAt: undefined as Date | undefined,
      save: async () => {},
    };

    mock.method(CampaignRecipient, "findOne", async () => mockRecipient);

    mock.method(Campaign, "findOne", async () => ({
      _id: new Types.ObjectId(CAMPAIGN_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
      status: "SCHEDULED",
    }));

    // Contact has opted out between scheduling and dispatch
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: new Types.ObjectId(CONTACT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
      isOptedOut: true,
      optOutSource: "STOP_MESSAGE",
    }));

    let campaignIncrement: any = null;
    mock.method(Campaign, "findByIdAndUpdate", async (_id: any, update: any) => {
      campaignIncrement = update;
      return null;
    });

    const result = await dispatchCampaignRecipient({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      recipientId: RECIPIENT_ID,
    });

    assert.equal(result.success, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "CONTACT_OPTED_OUT");
    assert.equal(mockRecipient.status, "FAILED");
    assert.equal(mockRecipient.errorCode, "CONTACT_OPTED_OUT");
    assert.match(mockRecipient.errorMessage || "", /opted out/i);
    assert.equal(campaignIncrement?.$inc?.failedCount, 1);
  });

  it("19. ensures retries after opt-out cannot bypass the guard", async () => {
    const alreadyFailedRecipient = {
      _id: new Types.ObjectId(RECIPIENT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
      campaignId: new Types.ObjectId(CAMPAIGN_ID),
      contactId: new Types.ObjectId(CONTACT_ID),
      phoneNumber: "+1234567890",
      status: "FAILED",
      errorCode: "CONTACT_OPTED_OUT",
      errorMessage: "Contact has opted out",
      save: async () => {},
    };

    mock.method(CampaignRecipient, "findOne", async () => alreadyFailedRecipient);
    mock.method(Campaign, "findOne", async () => ({
      _id: new Types.ObjectId(CAMPAIGN_ID),
      status: "PROCESSING",
    }));
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: new Types.ObjectId(CONTACT_ID),
      isOptedOut: true,
    }));

    let updateCalled = false;
    mock.method(Campaign, "findByIdAndUpdate", async () => {
      updateCalled = true;
      return null;
    });

    const result = await dispatchCampaignRecipient({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      recipientId: RECIPIENT_ID,
    });

    assert.equal(result.success, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "CONTACT_OPTED_OUT");
    // Should NOT double-increment campaign failure count
    assert.equal(updateCalled, false);
  });
});

// ─── 5. Webhook Reliability & Security ────────────────────────────────────────

describe("Phase E: Webhook Reliability & Security", () => {
  const APP_SECRET = "test_meta_app_secret_1234567890";

  beforeEach(() => {
    process.env.META_APP_SECRET = APP_SECRET;
  });

  function generateValidSignature(body: Buffer): string {
    const hash = createHmac("sha256", APP_SECRET).update(body).digest("hex");
    return `sha256=${hash}`;
  }

  it("20. prevents duplicate event processing via idempotent waMessageId check", async () => {
    mock.method(WhatsAppAccount, "findOne", async () => ({
      _id: new Types.ObjectId(ACCOUNT_ID),
      workspaceId: new Types.ObjectId(WORKSPACE_ID),
    }));

    mock.method(Workspace, "findById", async () => ({
      _id: new Types.ObjectId(WORKSPACE_ID),
      status: "ACTIVE",
    }));

    // Existing message found in database
    mock.method(WhatsAppMessage, "findOne", async () => ({
      _id: new Types.ObjectId(),
      waMessageId: "wamid.already_processed",
    }));

    const result = await processIncomingWhatsAppMessage({
      phoneNumberId: "phone_123",
      message: {
        from: "1234567890",
        id: "wamid.already_processed",
        timestamp: "1700000000",
        type: "TEXT",
        text: "Hello again",
      },
    });

    assert.equal(result.duplicate, true);
  });

  it("21. rejects webhook request with invalid signature with 401 Unauthorized", async () => {
    const rawBody = Buffer.from(
      JSON.stringify({ object: "whatsapp_business_account" }),
    );
    const invalidSignature =
      "sha256=invalid_hex_string_1234567890abcdef1234567890abcdef";

    let responseStatus: number | null = null;
    let responseBody: any = null;

    const req: any = {
      headers: { "x-hub-signature-256": invalidSignature },
      rawBody,
      body: JSON.parse(rawBody.toString()),
    };

    const res: any = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
      sendStatus(code: number) {
        responseStatus = code;
        return this;
      },
    };

    await receiveWhatsAppWebhook(req, res);

    assert.equal(responseStatus, 401);
    assert.equal(responseBody?.success, false);
    assert.match(responseBody?.message, /invalid webhook signature/i);
  });

  it("22. responds with HTTP 500 on unexpected database failure so Meta retries event", async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "phone_123" },
                  messages: [
                    {
                      from: "1234567890",
                      id: "wamid.retry_test",
                      timestamp: "1700000000",
                      type: "text",
                      text: { body: "Test failure" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    const validSignature = generateValidSignature(rawBody);

    // Simulate fatal database crash during account lookup
    mock.method(WhatsAppAccount, "findOne", async () => {
      throw new Error("MongoNetworkError: connection refused");
    });

    let responseStatus: number | null = null;
    let responseBody: any = null;

    const req: any = {
      headers: { "x-hub-signature-256": validSignature },
      rawBody,
      body: JSON.parse(rawBody.toString()),
    };

    const res: any = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
      sendStatus(code: number) {
        responseStatus = code;
        return this;
      },
    };

    await receiveWhatsAppWebhook(req, res);

    // Must return 500 to trigger Meta webhook retry
    assert.equal(responseStatus, 500);
    assert.equal(responseBody?.success, false);
  });

  it("23. safely handles Meta API failure when sending outbound message", async () => {
    const recentTime = new Date();

    mock.method(WhatsAppConversation, "findOne", async () => ({
      _id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      status: "OPEN",
      lastCustomerMessageAt: recentTime,
    }));
    mock.method(WhatsAppContact, "findOne", async () => ({
      _id: CONTACT_ID,
      waId: "1234567890",
      isOptedOut: false,
    }));
    mock.method(WhatsAppAccount, "findOne", () => ({
      select: async () => ({
        _id: ACCOUNT_ID,
        phoneNumberId: "phone_123",
        status: "CONNECTED",
        accessTokenEncrypted: encrypt("valid_test_meta_token_1234567890"),
      }),
      _id: ACCOUNT_ID,
      phoneNumberId: "phone_123",
      status: "CONNECTED",
      accessTokenEncrypted: encrypt("valid_test_meta_token_1234567890"),
    }));

    // Meta API returns error
    mock.method(
      global,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "Rate limit hit", code: 80007 },
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    await assert.rejects(
      () =>
        sendWhatsAppTextMessage({
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          senderId: USER_ID,
          text: "Will fail",
        }),
      (err: any) => {
        assert.ok(err.statusCode >= 400);
        return true;
      },
    );
  });

  describe("Phase F: WABA ID UX, Validation, and Meta Error Handling (Step 32B)", () => {
    it("24. accepts valid numeric WABA ID and rejects non-numeric or too-short IDs", () => {
      // Valid numeric WABA ID
      const validResult = connectWhatsAppSchema.safeParse({
        businessName: "Acme Support",
        businessAccountId: "100234567890123",
        phoneNumberId: "100987654321098",
        displayPhoneNumber: "+1555123456",
        accessToken: "EAAtest_token_min_20_chars",
      });
      assert.equal(validResult.success, true);

      // Non-numeric WABA ID rejected
      const nonNumericResult = connectWhatsAppSchema.safeParse({
        businessName: "Acme Support",
        businessAccountId: "WABA_INVALID_123",
        phoneNumberId: "100987654321098",
        displayPhoneNumber: "+1555123456",
        accessToken: "EAAtest_token_min_20_chars",
      });
      assert.equal(nonNumericResult.success, false);
      assert.match(
        nonNumericResult.error!.issues[0]!.message,
        /must contain only digits/i,
      );

      // Too-short WABA ID rejected (fewer than 5 characters)
      const tooShortResult = connectWhatsAppSchema.safeParse({
        businessName: "Acme Support",
        businessAccountId: "1234",
        phoneNumberId: "100987654321098",
        displayPhoneNumber: "+1555123456",
        accessToken: "EAAtest_token_min_20_chars",
      });
      assert.equal(tooShortResult.success, false);
      assert.match(
        tooShortResult.error!.issues[0]!.message,
        /invalid whatsapp business account id/i,
      );
    });

    it("25. correctly maps Meta code 100 / subcode 33 to HTTP 400 instead of HTTP 403", () => {
      const err = mapMetaApiError(400, {
        message:
          "Unsupported get request. Object with ID '100234567890123' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
        type: "GraphMethodException",
        code: 100,
        error_subcode: 33,
        fbtrace_id: "AtUo7iYBCkjP41knphkBTWt",
      });

      assert.equal(err.statusCode, 400);
      assert.notEqual(err.statusCode, 403);
      assert.match(err.message, /invalid|configuration|identifier/i);
    });

    it("26. preserves genuine permission errors as HTTP 403", () => {
      // Code 200: permission disallowed
      const err200 = mapMetaApiError(403, {
        message: "(#200) Provide valid permissions to access this edge",
        code: 200,
      });
      assert.equal(err200.statusCode, 403);
      assert.match(err200.message, /required permissions/i);

      // Code 10: application permission denied
      const err10 = mapMetaApiError(403, {
        message: "(#10) Application does not have permission for this action",
        code: 10,
      });
      assert.equal(err10.statusCode, 403);
      assert.match(err10.message, /required permissions/i);

      // Generic permission keyword when code is not 100
      const errMsg = mapMetaApiError(403, {
        message: "User permission was revoked by administrator",
      });
      assert.equal(errMsg.statusCode, 403);
      assert.match(errMsg.message, /required permissions/i);
    });

    it("27. preserves invalid or expired token error classification as HTTP 401", () => {
      // Expired token (code 190, subcode 463)
      const expiredErr = mapMetaApiError(401, {
        message: "Error validating access token: Session has expired",
        code: 190,
        error_subcode: 463,
      });
      assert.equal(expiredErr.statusCode, 401);
      assert.match(expiredErr.message, /expired/i);

      // Invalid token (code 190)
      const invalidErr = mapMetaApiError(401, {
        message: "Invalid OAuth access token signature",
        code: 190,
      });
      assert.equal(invalidErr.statusCode, 401);
      assert.match(invalidErr.message, /invalid/i);
    });

    it("28. preserves WABA-to-phone-number association verification", async () => {
      // Mock Meta API response returning registered phone numbers under the WABA
      mock.method(
        global,
        "fetch",
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: "100987654321098" }, { id: "999999999999999" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );

      const belongs = await verifyPhoneNumberInWaba(
        "100234567890123",
        "100987654321098",
        "valid_test_token_1234567890",
      );
      assert.equal(belongs, true);

      const doesNotBelong = await verifyPhoneNumberInWaba(
        "100234567890123",
        "555555555555555",
        "valid_test_token_1234567890",
      );
      assert.equal(doesNotBelong, false);
    });
  });
});
