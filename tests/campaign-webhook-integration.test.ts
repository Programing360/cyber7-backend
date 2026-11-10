/**
 * Cyber7 / VexChat Campaign & Webhook Status Synchronization Test Suite
 *
 * Verifies:
 * 1. Campaign Recipient Dispatching with Meta Cloud API (mocked Meta wamid response).
 * 2. Persistence of providerMessageId (wamid) onto CampaignRecipient.
 * 3. Synchronization of Meta Webhook statuses:
 *    - "delivered" -> transitions recipient to DELIVERED, sets deliveredAt, increments campaign.deliveredCount.
 *    - "read"      -> transitions recipient to READ, sets readAt, increments campaign.readCount.
 *    - "failed"    -> transitions recipient to FAILED, sets failedAt, increments campaign.failedCount.
 * 4. Idempotency (duplicate webhook payloads do not re-increment counters).
 * 5. Out-of-order status resilience (precedence enforcement so late DELIVERED does not overwrite READ).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import mongoose from "mongoose";

// Setup required encryption key & Meta app secret for token & webhook signature verification during test
if (!process.env.WHATSAPP_ENCRYPTION_KEY) {
  process.env.WHATSAPP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}
process.env.META_APP_SECRET = process.env.META_APP_SECRET || "test_meta_app_secret_1234567890";

import { encrypt } from "../src/utils/encryption.js";
import Campaign from "../src/modules/campaign/campaign.model.js";
import CampaignRecipient from "../src/modules/campaign/campaign-recipient.model.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import WhatsAppTemplate from "../src/modules/whatsapp/template.model.js";
import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import {
  dispatchCampaignRecipient,
  updateCampaignRecipientStatusFromWebhook,
} from "../src/modules/campaign/campaign.service.js";
import {
  processCampaignRecipientJob,
  processScheduledCampaignBatch,
} from "../src/modules/campaign/campaign.worker.js";
import { receiveWhatsAppWebhook } from "../src/modules/controllers/whatsapp-webhook.controller.js";

describe("Campaign & Webhook Status Sync Pipeline Integration Suite", () => {
  const workspaceId = new mongoose.Types.ObjectId();
  const campaignId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();
  const templateId = new mongoose.Types.ObjectId();
  const contactId = new mongoose.Types.ObjectId();
  const recipientId = new mongoose.Types.ObjectId();

  const testPhone = "+15551234567";
  const expectedWamid = "wamid.TEST_CAMPAIGN_MSG_98765";

  describe("1. Campaign Dispatch & Provider Message ID (wamid) Capturing", () => {
    it("should dispatch a recipient, invoke Meta API, set status=SENT, and store providerMessageId", async () => {
      // Mock Campaign doc
      const mockCampaign = {
        _id: campaignId,
        workspaceId,
        whatsappAccountId: accountId,
        templateId,
        status: "PROCESSING",
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        failedCount: 0,
        save: async function () {
          return this;
        },
      };

      // Mock Recipient doc
      const mockRecipient = {
        _id: recipientId,
        workspaceId,
        campaignId,
        contactId,
        phoneNumber: testPhone,
        status: "PROCESSING",
        providerMessageId: undefined,
        sentAt: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        save: async function () {
          return this;
        },
      };

      // Mock Contact doc (not opted out)
      const mockContact = {
        _id: contactId,
        workspaceId,
        isOptedOut: false,
        waId: testPhone,
      };

      // Mock WhatsApp Account (CONNECTED with encrypted token)
      const mockAccount = {
        _id: accountId,
        workspaceId,
        phoneNumberId: "phone_num_id_123",
        status: "CONNECTED",
        accessTokenEncrypted: encrypt("EAABtest_token_meta_12345"),
        select: function () {
          return this;
        },
      };

      // Mock WhatsApp Template (APPROVED)
      const mockTemplate = {
        _id: templateId,
        workspaceId,
        name: "promotional_discount_v1",
        language: "en_US",
        status: "APPROVED",
      };

      // Save originals
      const origRecipientFindOneAndUpdate = CampaignRecipient.findOneAndUpdate;
      const origContactFindOne = WhatsAppContact.findOne;
      const origCampaignFindOne = Campaign.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;
      const origAccountFindOne = WhatsAppAccount.findOne;
      const origTemplateFindOne = WhatsAppTemplate.findOne;
      const origFetch = globalThis.fetch;

      let capturedRequestPayload: any = null;
      let capturedRequestUrl = "";

      try {
        // Stub DB lookups
        (CampaignRecipient as any).findOneAndUpdate = async () => mockRecipient;
        (WhatsAppContact as any).findOne = async () => mockContact;
        (Campaign as any).findOne = async () => mockCampaign;
        (WhatsAppAccount as any).findOne = () => ({
          select: () => mockAccount,
          ...mockAccount,
        });
        (WhatsAppTemplate as any).findOne = async () => mockTemplate;

        (Campaign as any).findByIdAndUpdate = async (
          _id: any,
          update: any,
        ) => {
          if (update.$inc?.sentCount) {
            mockCampaign.sentCount += update.$inc.sentCount;
          }
          return mockCampaign;
        };

        // Stub globalThis.fetch for official Meta Graph API request
        globalThis.fetch = async (url: any, opts: any) => {
          capturedRequestUrl = String(url);
          capturedRequestPayload = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({
              messaging_product: "whatsapp",
              contacts: [{ input: testPhone, wa_id: testPhone.replace(/\D/g, "") }],
              messages: [{ id: expectedWamid }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        // Execute dispatch
        const result = await dispatchCampaignRecipient({
          workspaceId: workspaceId.toString(),
          campaignId: campaignId.toString(),
          recipientId: recipientId.toString(),
        });

        // 1. Assert Meta API was invoked with template message payload
        assert.ok(result.success, "Dispatch should succeed");
        assert.strictEqual(result.providerMessageId, expectedWamid);
        assert.ok(
          capturedRequestUrl.includes("/messages"),
          "Url should target messages endpoint",
        );
        assert.strictEqual(capturedRequestPayload.type, "template");
        assert.strictEqual(
          capturedRequestPayload.template.name,
          "promotional_discount_v1",
        );

        // 2. Assert Recipient was updated with wamid and SENT status
        assert.strictEqual(mockRecipient.status, "SENT");
        assert.strictEqual(mockRecipient.providerMessageId, expectedWamid);
        assert.ok(mockRecipient.sentAt instanceof Date);

        // 3. Assert Campaign sentCount was incremented
        assert.strictEqual(mockCampaign.sentCount, 1);
      } finally {
        CampaignRecipient.findOneAndUpdate = origRecipientFindOneAndUpdate;
        WhatsAppContact.findOne = origContactFindOne;
        Campaign.findOne = origCampaignFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
        WhatsAppAccount.findOne = origAccountFindOne;
        WhatsAppTemplate.findOne = origTemplateFindOne;
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("2. Webhook Status Synchronization (Delivered & Read)", () => {
    it("should process 'delivered' webhook: update recipient status to DELIVERED, set deliveredAt, and increment campaign.deliveredCount", async () => {
      const mockCampaign = {
        _id: campaignId,
        sentCount: 1,
        deliveredCount: 0,
        readCount: 0,
        failedCount: 0,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "SENT",
        deliveredAt: undefined as Date | undefined,
        readAt: undefined as Date | undefined,
        failedAt: undefined as Date | undefined,
        save: async function () {
          return this;
        },
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;

      try {
        (CampaignRecipient as any).findOne = async (query: any) => {
          if (query.providerMessageId === expectedWamid) {
            return mockRecipient;
          }
          return null;
        };

        (Campaign as any).findByIdAndUpdate = async (
          _id: any,
          update: any,
        ) => {
          if (update.$inc?.deliveredCount) {
            mockCampaign.deliveredCount += update.$inc.deliveredCount;
          }
          return mockCampaign;
        };

        const syncResult = await updateCampaignRecipientStatusFromWebhook({
          providerMessageId: expectedWamid,
          status: "DELIVERED",
          timestamp: "1731170000",
        });

        assert.strictEqual(syncResult.updated, true);
        assert.strictEqual(mockRecipient.status, "DELIVERED");
        assert.ok(mockRecipient.deliveredAt instanceof Date);
        assert.strictEqual(mockCampaign.deliveredCount, 1);
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
      }
    });

    it("should process 'read' webhook: update recipient status to READ, set readAt, and increment campaign.readCount", async () => {
      const mockCampaign = {
        _id: campaignId,
        sentCount: 1,
        deliveredCount: 1,
        readCount: 0,
        failedCount: 0,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "DELIVERED",
        deliveredAt: new Date(1731170000 * 1000),
        readAt: undefined as Date | undefined,
        failedAt: undefined as Date | undefined,
        save: async function () {
          return this;
        },
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;

      try {
        (CampaignRecipient as any).findOne = async (query: any) => {
          if (query.providerMessageId === expectedWamid) {
            return mockRecipient;
          }
          return null;
        };

        (Campaign as any).findByIdAndUpdate = async (
          _id: any,
          update: any,
        ) => {
          if (update.$inc?.readCount) {
            mockCampaign.readCount += update.$inc.readCount;
          }
          return mockCampaign;
        };

        const syncResult = await updateCampaignRecipientStatusFromWebhook({
          providerMessageId: expectedWamid,
          status: "READ",
          timestamp: "1731170120",
        });

        assert.strictEqual(syncResult.updated, true);
        assert.strictEqual(mockRecipient.status, "READ");
        assert.ok(mockRecipient.readAt instanceof Date);
        assert.strictEqual(mockCampaign.readCount, 1);
        // Delivered count remains 1
        assert.strictEqual(mockCampaign.deliveredCount, 1);
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
      }
    });

    it("should handle direct 'read' webhook when 'delivered' was skipped by Meta (backfill delivery)", async () => {
      const mockCampaign = {
        _id: campaignId,
        sentCount: 1,
        deliveredCount: 0,
        readCount: 0,
        failedCount: 0,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "SENT",
        deliveredAt: undefined as Date | undefined,
        readAt: undefined as Date | undefined,
        save: async function () {
          return this;
        },
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;

      try {
        (CampaignRecipient as any).findOne = async () => mockRecipient;

        (Campaign as any).findByIdAndUpdate = async (
          _id: any,
          update: any,
        ) => {
          if (update.$inc?.deliveredCount) {
            mockCampaign.deliveredCount += update.$inc.deliveredCount;
          }
          if (update.$inc?.readCount) {
            mockCampaign.readCount += update.$inc.readCount;
          }
          return mockCampaign;
        };

        const syncResult = await updateCampaignRecipientStatusFromWebhook({
          providerMessageId: expectedWamid,
          status: "READ",
          timestamp: "1731170200",
        });

        assert.strictEqual(syncResult.updated, true);
        assert.strictEqual(mockRecipient.status, "READ");
        assert.ok(mockRecipient.readAt instanceof Date);
        assert.ok(mockRecipient.deliveredAt instanceof Date, "Should backfill deliveredAt");
        assert.strictEqual(mockCampaign.deliveredCount, 1, "Should backfill deliveredCount");
        assert.strictEqual(mockCampaign.readCount, 1);
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
      }
    });
  });

  describe("3. Idempotency & Status Precedence Protection", () => {
    it("should ignore duplicate 'delivered' webhooks without inflating deliveredCount", async () => {
      const mockCampaign = {
        _id: campaignId,
        deliveredCount: 1,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "DELIVERED",
        deliveredAt: new Date(1731170000 * 1000),
        save: async function () {
          return this;
        },
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;

      let updateCount = 0;
      try {
        (CampaignRecipient as any).findOne = async () => mockRecipient;
        (Campaign as any).findByIdAndUpdate = async () => {
          updateCount += 1;
        };

        const result = await updateCampaignRecipientStatusFromWebhook({
          providerMessageId: expectedWamid,
          status: "DELIVERED",
          timestamp: "1731170005",
        });

        assert.strictEqual(result.updated, false);
        assert.strictEqual(result.reason, "DUPLICATE_STATUS");
        assert.strictEqual(updateCount, 0, "Campaign counters must not be touched on duplicate");
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
      }
    });

    it("should reject status downgrade (e.g. late DELIVERED after message is already READ)", async () => {
      const mockCampaign = {
        _id: campaignId,
        readCount: 1,
        deliveredCount: 1,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "READ",
        readAt: new Date(1731170100 * 1000),
        deliveredAt: new Date(1731170050 * 1000),
        save: async function () {
          return this;
        },
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;

      let campaignUpdated = false;
      try {
        (CampaignRecipient as any).findOne = async () => mockRecipient;
        (Campaign as any).findByIdAndUpdate = async () => {
          campaignUpdated = true;
        };

        const result = await updateCampaignRecipientStatusFromWebhook({
          providerMessageId: expectedWamid,
          status: "DELIVERED",
          timestamp: "1731170080",
        });

        assert.strictEqual(result.updated, false);
        assert.strictEqual(result.reason, "LOWER_RANK");
        assert.strictEqual(mockRecipient.status, "READ", "Status must remain READ");
        assert.strictEqual(campaignUpdated, false);
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
      }
    });

    it("should record 'failed' webhook: set status=FAILED, capture error code/message, and increment failedCount", async () => {
      const mockCampaign = {
        _id: campaignId,
        failedCount: 0,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "SENT",
        failedAt: undefined as Date | undefined,
        errorCode: undefined as string | undefined,
        errorMessage: undefined as string | undefined,
        save: async function () {
          return this;
        },
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;

      try {
        (CampaignRecipient as any).findOne = async () => mockRecipient;
        (Campaign as any).findByIdAndUpdate = async (_id: any, update: any) => {
          if (update.$inc?.failedCount) {
            mockCampaign.failedCount += update.$inc.failedCount;
          }
        };

        const result = await updateCampaignRecipientStatusFromWebhook({
          providerMessageId: expectedWamid,
          status: "FAILED",
          timestamp: "1731170300",
          errorCode: "131026",
          errorMessage: "Message undeliverable to WhatsApp user",
        });

        assert.strictEqual(result.updated, true);
        assert.strictEqual(mockRecipient.status, "FAILED");
        assert.strictEqual(mockRecipient.errorCode, "131026");
        assert.strictEqual(
          mockRecipient.errorMessage,
          "Message undeliverable to WhatsApp user",
        );
        assert.ok(mockRecipient.failedAt instanceof Date);
        assert.strictEqual(mockCampaign.failedCount, 1);
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
      }
    });
  });

  describe("4. Campaign Worker Pipeline Execution", () => {
    it("should process scheduled campaign batch and mark campaign COMPLETED when done", async () => {
      const mockCampaign = {
        _id: campaignId,
        workspaceId,
        whatsappAccountId: accountId,
        templateId,
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() - 60000), // 1 min in past
        startedAt: null as Date | null,
        completedAt: null as Date | null,
        save: async function () {
          return this;
        },
      };

      const mockRecipient = {
        _id: recipientId,
        workspaceId,
        campaignId,
        contactId,
        phoneNumber: testPhone,
        status: "PENDING",
        save: async function () {
          return this;
        },
      };

      const origCampaignFind = Campaign.find;
      const origRecipientFind = CampaignRecipient.find;
      const origRecipientCount = CampaignRecipient.countDocuments;
      const origFetch = globalThis.fetch;

      const mockAccountWorker = {
        _id: accountId,
        workspaceId,
        phoneNumberId: "phone_123",
        status: "CONNECTED",
        accessTokenEncrypted: encrypt("EAABtest_worker_meta_token"),
      };

      try {
        (Campaign as any).find = () => ({
          limit: () => [mockCampaign],
        });

        let recipientFetchCount = 0;
        (CampaignRecipient as any).find = () => ({
          limit: () => {
            recipientFetchCount += 1;
            return recipientFetchCount === 1 ? [mockRecipient] : [];
          },
        });

        // 0 remaining pending recipients on check
        (CampaignRecipient as any).countDocuments = async () => 0;

        // Stub worker recipient dispatcher
        (CampaignRecipient as any).findOneAndUpdate = async () => ({
          ...mockRecipient,
          status: "PROCESSING",
          save: async () => {},
        });
        (WhatsAppContact as any).findOne = async () => ({ isOptedOut: false, waId: testPhone });
        (Campaign as any).findOne = async () => mockCampaign;
        (WhatsAppAccount as any).findOne = () => ({
          select: () => mockAccountWorker,
          ...mockAccountWorker,
        });
        (WhatsAppTemplate as any).findOne = async () => ({
          name: "promo",
          language: "en",
          status: "APPROVED",
        });
        (Campaign as any).findByIdAndUpdate = async () => {};
        globalThis.fetch = async () =>
          new Response(
            JSON.stringify({
              messages: [{ id: expectedWamid }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        const batchResult = await processScheduledCampaignBatch(5);

        assert.strictEqual(batchResult.processedCampaigns, 1);
        assert.strictEqual(batchResult.dispatchedRecipients, 1);
        assert.strictEqual(mockCampaign.status, "COMPLETED");
        assert.ok(mockCampaign.completedAt instanceof Date);
      } finally {
        Campaign.find = origCampaignFind;
        CampaignRecipient.find = origRecipientFind;
        CampaignRecipient.countDocuments = origRecipientCount;
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("5. End-to-End Meta Webhook Controller Ingress Simulation", () => {
    it("should accept signed Meta Webhook payload for 'delivered' status and sync to CampaignRecipient", async () => {
      const mockCampaign = {
        _id: campaignId,
        deliveredCount: 0,
      };

      const mockRecipient = {
        _id: recipientId,
        campaignId,
        providerMessageId: expectedWamid,
        status: "SENT",
        deliveredAt: undefined as Date | undefined,
        save: async function () {
          return this;
        },
      };

      const mockAccount = {
        _id: accountId,
        phoneNumberId: "phone_num_id_123",
        status: "CONNECTED",
      };

      const origRecipientFindOne = CampaignRecipient.findOne;
      const origCampaignFindByIdAndUpdate = Campaign.findByIdAndUpdate;
      const origAccountFindOne = WhatsAppAccount.findOne;
      const origMessageFindOne = WhatsAppMessage.findOne;

      try {
        (WhatsAppMessage as any).findOne = async () => null; // Not a 1-to-1 conversation message

        (CampaignRecipient as any).findOne = async (query: any) => {
          if (query.providerMessageId === expectedWamid) {
            return mockRecipient;
          }
          return null;
        };

        (Campaign as any).findByIdAndUpdate = async (_id: any, update: any) => {
          if (update.$inc?.deliveredCount) {
            mockCampaign.deliveredCount += update.$inc.deliveredCount;
          }
        };

        (WhatsAppAccount as any).findOne = () => ({
          select: () => mockAccount,
          ...mockAccount,
        });

        // Construct Meta webhook payload
        const payload = {
          object: "whatsapp_business_account",
          entry: [
            {
              id: "WABA_ID_TEST",
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: {
                      display_phone_number: "15551234567",
                      phone_number_id: "phone_num_id_123",
                    },
                    statuses: [
                      {
                        id: expectedWamid,
                        status: "delivered",
                        timestamp: "1731170050",
                        recipient_id: "15559876543",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const rawBody = Buffer.from(JSON.stringify(payload));
        const signature =
          "sha256=" +
          createHmac("sha256", process.env.META_APP_SECRET!)
            .update(rawBody)
            .digest("hex");

        let responseStatusCode = 0;
        const req: any = {
          headers: {
            "x-hub-signature-256": signature,
          },
          rawBody,
          body: payload,
          originalUrl: "/api/whatsapp/webhook",
        };

        const res: any = {
          sendStatus: (code: number) => {
            responseStatusCode = code;
            return res;
          },
          status: (code: number) => {
            responseStatusCode = code;
            return {
              json: () => {},
            };
          },
        };

        await receiveWhatsAppWebhook(req, res);

        assert.strictEqual(responseStatusCode, 200, "Webhook should return HTTP 200");
        assert.strictEqual(mockRecipient.status, "DELIVERED");
        assert.ok(mockRecipient.deliveredAt instanceof Date);
        assert.strictEqual(mockCampaign.deliveredCount, 1);
      } finally {
        CampaignRecipient.findOne = origRecipientFindOne;
        Campaign.findByIdAndUpdate = origCampaignFindByIdAndUpdate;
        WhatsAppAccount.findOne = origAccountFindOne;
        WhatsAppMessage.findOne = origMessageFindOne;
      }
    });
  });
});
