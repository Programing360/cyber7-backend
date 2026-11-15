import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// Setup required environment variables for Meta App and Encryption
process.env.META_APP_ID = process.env.META_APP_ID || "2178516212899522";
process.env.META_APP_SECRET = process.env.META_APP_SECRET || "37e146eded2be0dd3de41862cd85757b";
if (!process.env.WHATSAPP_ENCRYPTION_KEY) {
  process.env.WHATSAPP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}

import { embeddedSignupCompleteSchema } from "../src/modules/whatsapp/whatsapp.validation.js";
import { completeEmbeddedSignup } from "../src/modules/whatsapp/whatsapp.service.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import whatsappRouter from "../src/modules/whatsapp/whatsapp.routes.js";
import { decrypt } from "../src/utils/encryption.js";

describe("Meta WhatsApp Cloud API Embedded Signup Test Suite", () => {
  const workspaceId = new mongoose.Types.ObjectId().toString();
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("1. Validation Schema (embeddedSignupCompleteSchema)", () => {
    it("should accept valid payload with code, wabaId, and phoneNumberId", () => {
      const parsed = embeddedSignupCompleteSchema.parse({
        code: "AQB123sampleAuthCode456",
        wabaId: "109876543210123",
        phoneNumberId: "105551234567890",
      });

      assert.equal(parsed.code, "AQB123sampleAuthCode456");
      assert.equal(parsed.wabaId, "109876543210123");
      assert.equal(parsed.phoneNumberId, "105551234567890");
    });

    it("should accept payload with only code (wabaId and phoneNumberId optional for server-side resolution)", () => {
      const parsed = embeddedSignupCompleteSchema.parse({
        code: "AQB123sampleAuthCodeOnly",
      });

      assert.equal(parsed.code, "AQB123sampleAuthCodeOnly");
      assert.equal(parsed.wabaId, undefined);
      assert.equal(parsed.phoneNumberId, undefined);
    });

    it("should reject payload missing required code", () => {
      assert.throws(() => {
        embeddedSignupCompleteSchema.parse({
          wabaId: "109876543210123",
          phoneNumberId: "105551234567890",
        });
      });
    });
  });

  describe("2. completeEmbeddedSignup Service & Step Execution", () => {
    it("should complete token exchange, subscribed_apps, register, and phone details fetch", async () => {
      const mockCalls: { url: string; method?: string; body?: any }[] = [];

      global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = input.toString();
        mockCalls.push({ url: urlStr, method: init?.method, body: init?.body });

        // Step A: Token exchange
        if (urlStr.includes("oauth/access_token")) {
          return new Response(
            JSON.stringify({
              access_token: "EAAB_MOCK_LONG_LIVED_TOKEN_XYZ123",
              token_type: "bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Step B: subscribed_apps
        if (urlStr.includes("subscribed_apps")) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Step C: phone registration
        if (urlStr.includes("/register")) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Step D: phone number details
        if (urlStr.includes("fields=id,display_phone_number,verified_name")) {
          return new Response(
            JSON.stringify({
              id: "9988776655",
              display_phone_number: "+1 555-0199",
              verified_name: "Cyber7 Test Corp",
              quality_rating: "GREEN",
              code_verification_status: "VERIFIED",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({}), { status: 200 });
      };

      // Mock WhatsAppAccount findOne & create
      const originalFindOne = WhatsAppAccount.findOne;
      const originalCreate = WhatsAppAccount.create;
      let savedDoc: any = null;

      (WhatsAppAccount as any).findOne = async () => null;
      (WhatsAppAccount as any).create = async (doc: any) => {
        savedDoc = {
          _id: new mongoose.Types.ObjectId(),
          ...doc,
          save: async function () {
            return this;
          },
        };
        return savedDoc;
      };

      try {
        const result = await completeEmbeddedSignup({
          workspaceId,
          code: "test_code_123",
          wabaId: "waba_test_456",
          phoneNumberId: "9988776655",
        });

        assert.ok(result);
        assert.equal(result.phoneNumberId, "9988776655");
        assert.equal(result.businessAccountId, "waba_test_456");
        assert.equal(result.displayPhoneNumber, "+1 555-0199");
        assert.equal(result.businessName, "Cyber7 Test Corp");
        assert.equal(result.status, "CONNECTED");

        // Verify that token was encrypted in AES-256
        assert.ok(savedDoc.accessTokenEncrypted);
        const decrypted = decrypt(savedDoc.accessTokenEncrypted);
        assert.equal(decrypted, "EAAB_MOCK_LONG_LIVED_TOKEN_XYZ123");

        // Verify 4 steps were called
        assert.equal(mockCalls.length, 4);
        assert.ok(mockCalls[0].url.includes("oauth/access_token"));
        assert.ok(mockCalls[1].url.includes("waba_test_456/subscribed_apps"));
        assert.ok(mockCalls[2].url.includes("9988776655/register"));
        assert.ok(mockCalls[3].url.includes("fields=id,display_phone_number"));
      } finally {
        (WhatsAppAccount as any).findOne = originalFindOne;
        (WhatsAppAccount as any).create = originalCreate;
      }
    });

    it("should gracefully handle already registered phone number (subcode 133010)", async () => {
      global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = input.toString();

        if (urlStr.includes("oauth/access_token")) {
          return new Response(
            JSON.stringify({
              access_token: "EAAB_TOKEN_133010_TEST",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (urlStr.includes("subscribed_apps")) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        // Simulating subcode 133010
        if (urlStr.includes("/register")) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Number is already registered",
                error_subcode: 133010,
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        if (urlStr.includes("fields=id,display_phone_number")) {
          return new Response(
            JSON.stringify({
              id: "phone_already_reg",
              display_phone_number: "+1 555-7777",
              verified_name: "Existing Brand",
              quality_rating: "GREEN",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({}), { status: 200 });
      };

      const originalFindOne = WhatsAppAccount.findOne;
      const originalCreate = WhatsAppAccount.create;

      (WhatsAppAccount as any).findOne = async () => null;
      (WhatsAppAccount as any).create = async (doc: any) => ({
        _id: new mongoose.Types.ObjectId(),
        ...doc,
        save: async function () {
          return this;
        },
      });

      try {
        const result = await completeEmbeddedSignup({
          workspaceId,
          code: "code_133010",
          wabaId: "waba_existing",
          phoneNumberId: "phone_already_reg",
        });

        assert.equal(result.phoneNumberId, "phone_already_reg");
        assert.equal(result.status, "CONNECTED");
        assert.equal(result.displayPhoneNumber, "+1 555-7777");
      } finally {
        (WhatsAppAccount as any).findOne = originalFindOne;
        (WhatsAppAccount as any).create = originalCreate;
      }
    });

    it("should automatically discover wabaId and phoneNumberId if omitted in client payload", async () => {
      global.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const urlStr = input.toString();

        if (urlStr.includes("oauth/access_token")) {
          return new Response(
            JSON.stringify({ access_token: "EAAB_FALLBACK_TOKEN" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Fallback discovery for WABAs
        if (urlStr.includes("/me/whatsapp_business_accounts")) {
          return new Response(
            JSON.stringify({
              data: [{ id: "discovered_waba_888", name: "Discovered Account" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Fallback discovery for Phone Numbers
        if (urlStr.includes("/discovered_waba_888/phone_numbers")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "discovered_phone_999",
                  display_phone_number: "+1 555-3333",
                  verified_name: "Discovered Phone",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (urlStr.includes("subscribed_apps")) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (urlStr.includes("/register")) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (urlStr.includes("fields=id,display_phone_number")) {
          return new Response(
            JSON.stringify({
              id: "discovered_phone_999",
              display_phone_number: "+1 555-3333",
              verified_name: "Discovered Phone",
              quality_rating: "GREEN",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({}), { status: 200 });
      };

      const originalFindOne = WhatsAppAccount.findOne;
      const originalCreate = WhatsAppAccount.create;

      (WhatsAppAccount as any).findOne = async () => null;
      (WhatsAppAccount as any).create = async (doc: any) => ({
        _id: new mongoose.Types.ObjectId(),
        ...doc,
        save: async function () {
          return this;
        },
      });

      try {
        const result = await completeEmbeddedSignup({
          workspaceId,
          code: "code_with_fallback",
        });

        assert.equal(result.phoneNumberId, "discovered_phone_999");
        assert.equal(result.businessAccountId, "discovered_waba_888");
        assert.equal(result.displayPhoneNumber, "+1 555-3333");
      } finally {
        (WhatsAppAccount as any).findOne = originalFindOne;
        (WhatsAppAccount as any).create = originalCreate;
      }
    });
  });

  describe("3. Router Registration for Embedded Signup", () => {
    it("should mount /embedded-signup/complete and /:workspaceId/embedded-signup/complete on whatsappRouter", () => {
      const routes = whatsappRouter.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => ({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods),
        }));

      const hasTopLevelRoute = routes.some(
        (r: any) =>
          r.path === "/embedded-signup/complete" && r.methods.includes("post")
      );
      const hasWorkspaceScopedRoute = routes.some(
        (r: any) =>
          r.path === "/:workspaceId/embedded-signup/complete" &&
          r.methods.includes("post")
      );

      assert.ok(
        hasTopLevelRoute,
        "whatsappRouter should mount POST /embedded-signup/complete"
      );
      assert.ok(
        hasWorkspaceScopedRoute,
        "whatsappRouter should mount POST /:workspaceId/embedded-signup/complete"
      );
    });
  });
});
