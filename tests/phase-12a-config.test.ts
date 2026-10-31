/**
 * Phase 12A — Meta Developer App & Webhook Configuration tests.
 *
 * Run with:
 *   npx tsx --test tests/phase-12a-config.test.ts
 */

import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import MetaPlatformConfig from "../src/modules/whatsapp/meta-platform-config.model.js";
import Membership from "../src/modules/workspace/membership.model.js";
import { getWhatsAppConfigStatus } from "../src/modules/whatsapp/whatsapp.service.js";
import {
  receiveWhatsAppWebhook,
  verifyWhatsAppWebhook,
} from "../src/modules/controllers/whatsapp-webhook.controller.js";
import { requireWorkspaceMembership } from "../src/middlewares/require-workspace-membership.js";

const ENV_KEYS = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_GRAPH_API_VERSION",
  "META_WEBHOOK_VERIFY_TOKEN",
  "WEBHOOK_PUBLIC_URL",
  "PUBLIC_API_URL",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

const WORKSPACE_ID = "507f1f77bcf86cd799439011";
const OTHER_WORKSPACE_ID = "507f1f77bcf86cd799439012";

function resetEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearConfigEnv() {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_GRAPH_API_VERSION;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  delete process.env.WEBHOOK_PUBLIC_URL;
  delete process.env.PUBLIC_API_URL;
}

function configureMetaApp() {
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_GRAPH_API_VERSION = "v26.0";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
}

function stubWorkspaceCounts(total: number, connected: number) {
  mock.method(WhatsAppAccount, "countDocuments", async (filter: unknown) => {
    const query = filter as { status?: string };
    return query.status === "CONNECTED" ? connected : total;
  });
}

function stubPlatformVerification(verified: boolean) {
  mock.method(MetaPlatformConfig, "findOne", async () => ({
    webhookVerified: verified,
  }));
}

function createResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    sendStatus(code: number) {
      res.statusCode = code;
      return res;
    },
  };

  return res;
}

afterEach(() => {
  mock.restoreAll();
  resetEnv();
});

describe("Public webhook URL resolution", () => {
  it("reports no callback URL when no public URL is configured", async () => {
    clearConfigEnv();
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(status.webhook.callbackUrl, null);
  });

  it("rejects a localhost callback URL even when explicitly configured", async () => {
    clearConfigEnv();
    process.env.WEBHOOK_PUBLIC_URL =
      "http://localhost:5000/api/whatsapp/webhook";
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(status.webhook.callbackUrl, null);
  });

  it("rejects HTTPS localhost callback URLs", async () => {
    clearConfigEnv();
    process.env.PUBLIC_API_URL = "https://localhost:5000";
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(status.webhook.callbackUrl, null);
  });

  it("constructs the callback URL from PUBLIC_API_URL", async () => {
    clearConfigEnv();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(
      status.webhook.callbackUrl,
      "https://api.example.com/api/whatsapp/webhook",
    );
  });

  it("prefers WEBHOOK_PUBLIC_URL over PUBLIC_API_URL", async () => {
    clearConfigEnv();
    process.env.WEBHOOK_PUBLIC_URL =
      "https://hooks.example.com/api/whatsapp/webhook";
    process.env.PUBLIC_API_URL = "https://api.example.com";
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(
      status.webhook.callbackUrl,
      "https://hooks.example.com/api/whatsapp/webhook",
    );
  });
});

describe("Meta App and workspace configuration status", () => {
  it("reports the Meta App as configured when credentials are present", async () => {
    clearConfigEnv();
    configureMetaApp();
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(status.metaApp.configured, true);
  });

  it("reports the Meta App as not configured when credentials are missing", async () => {
    clearConfigEnv();
    process.env.META_GRAPH_API_VERSION = "v26.0";
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.equal(status.metaApp.configured, false);
  });

  it("reports zero workspace accounts without affecting Meta App status", async () => {
    clearConfigEnv();
    configureMetaApp();
    stubWorkspaceCounts(0, 0);
    stubPlatformVerification(false);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.deepEqual(status.workspaceAccount, {
      totalAccounts: 0,
      connectedAccounts: 0,
    });
    assert.equal(status.metaApp.configured, true);
  });

  it("reports connected workspace accounts", async () => {
    clearConfigEnv();
    configureMetaApp();
    stubWorkspaceCounts(3, 2);
    stubPlatformVerification(true);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);

    assert.deepEqual(status.workspaceAccount, {
      totalAccounts: 3,
      connectedAccounts: 2,
    });
    assert.equal(status.webhook.verified, true);
  });

  it("rejects an invalid workspace ID", async () => {
    clearConfigEnv();
    configureMetaApp();

    await assert.rejects(
      () => getWhatsAppConfigStatus("not-a-valid-object-id"),
      /valid workspace ID/i,
    );
  });

  it("never exposes secrets in the configuration response", async () => {
    clearConfigEnv();
    process.env.META_APP_ID = "app-id-visible-to-nobody";
    process.env.META_APP_SECRET = "super-secret-app-secret-value";
    process.env.META_GRAPH_API_VERSION = "v26.0";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "super-secret-verify-token";
    process.env.WHATSAPP_ENCRYPTION_KEY =
      "c3VwZXItc2VjcmV0LWVuY3J5cHRpb24ta2V5LXZhbHVl";
    process.env.WEBHOOK_PUBLIC_URL =
      "https://api.example.com/api/whatsapp/webhook";
    stubWorkspaceCounts(1, 1);
    stubPlatformVerification(true);

    const status = await getWhatsAppConfigStatus(WORKSPACE_ID);
    const serialized = JSON.stringify(status);

    assert.doesNotMatch(serialized, /super-secret-app-secret-value/);
    assert.doesNotMatch(serialized, /super-secret-verify-token/);
    assert.doesNotMatch(serialized, /WHATSAPP_ENCRYPTION_KEY/);
    assert.doesNotMatch(serialized, /META_APP_SECRET/);
    assert.doesNotMatch(serialized, /accessToken/i);
    assert.doesNotMatch(serialized, /authorization/i);
  });
});

describe("Webhook GET verification handshake", () => {
  it("accepts a valid handshake and records platform verification", async () => {
    clearConfigEnv();
    process.env.META_WEBHOOK_VERIFY_TOKEN = "correct-token";

    const record = mock.method(
      MetaPlatformConfig,
      "findOneAndUpdate",
      async () => ({ webhookVerified: true }),
    );

    const req = {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "correct-token",
        "hub.challenge": "challenge-123",
      },
      ip: "203.0.113.10",
    } as never;
    const res = createResponse();

    await verifyWhatsAppWebhook(req, res as never);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "challenge-123");
    assert.equal(record.mock.callCount(), 1);
  });

  it("rejects an invalid verify token without recording verification", async () => {
    clearConfigEnv();
    process.env.META_WEBHOOK_VERIFY_TOKEN = "correct-token";

    const record = mock.method(
      MetaPlatformConfig,
      "findOneAndUpdate",
      async () => ({ webhookVerified: true }),
    );

    const req = {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-123",
      },
      ip: "203.0.113.10",
    } as never;
    const res = createResponse();

    await verifyWhatsAppWebhook(req, res as never);

    assert.equal(res.statusCode, 403);
    assert.equal(record.mock.callCount(), 0);
  });

  it("rejects an invalid hub.mode without recording verification", async () => {
    clearConfigEnv();
    process.env.META_WEBHOOK_VERIFY_TOKEN = "correct-token";

    const record = mock.method(
      MetaPlatformConfig,
      "findOneAndUpdate",
      async () => ({ webhookVerified: true }),
    );

    const req = {
      query: {
        "hub.mode": "unsubscribe",
        "hub.verify_token": "correct-token",
        "hub.challenge": "challenge-123",
      },
      ip: "203.0.113.10",
    } as never;
    const res = createResponse();

    await verifyWhatsAppWebhook(req, res as never);

    assert.equal(res.statusCode, 403);
    assert.equal(record.mock.callCount(), 0);
  });
});

describe("Webhook POST events", () => {
  it("does not mark GET verification complete just because a signed POST arrives", async () => {
    clearConfigEnv();
    process.env.META_APP_SECRET = "post-test-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "correct-token";

    const record = mock.method(
      MetaPlatformConfig,
      "findOneAndUpdate",
      async () => ({ webhookVerified: true }),
    );

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1234567890" },
              },
            },
          ],
        },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", "post-test-app-secret")
      .update(rawBody)
      .digest("hex")}`;

    const req = {
      headers: { "x-hub-signature-256": signature },
      rawBody,
      body: payload,
    } as never;
    const res = createResponse();

    await receiveWhatsAppWebhook(req, res as never);

    assert.equal(res.statusCode, 200);
    assert.equal(record.mock.callCount(), 0);
  });

  it("rejects a POST with an invalid signature without recording verification", async () => {
    clearConfigEnv();
    process.env.META_APP_SECRET = "post-test-app-secret";

    const record = mock.method(
      MetaPlatformConfig,
      "findOneAndUpdate",
      async () => ({ webhookVerified: true }),
    );

    const payload = { object: "whatsapp_business_account", entry: [] };
    const req = {
      headers: { "x-hub-signature-256": "sha256=invalid" },
      rawBody: Buffer.from(JSON.stringify(payload)),
      body: payload,
    } as never;
    const res = createResponse();

    await receiveWhatsAppWebhook(req, res as never);

    assert.equal(res.statusCode, 401);
    assert.equal(record.mock.callCount(), 0);
  });
});

describe("Workspace access control", () => {
  it("rejects a user without membership in the requested workspace", async () => {
    mock.method(Membership, "findOne", () => ({
      select: async () => null,
    }));

    const req = {
      user: { id: "user-1" },
      params: { workspaceId: OTHER_WORKSPACE_ID },
    } as never;
    const res = createResponse();
    let nextCalled = false;

    await requireWorkspaceMembership(req, res as never, (() => {
      nextCalled = true;
    }) as never);

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it("allows a user with active membership in the requested workspace", async () => {
    mock.method(Membership, "findOne", () => ({
      select: async () => ({
        _id: "membership-1",
        workspaceId: { toString: () => WORKSPACE_ID },
        role: "OWNER",
      }),
    }));

    const req = {
      user: { id: "user-1" },
      params: { workspaceId: WORKSPACE_ID },
    } as never;
    const res = createResponse();
    let nextCalled = false;

    await requireWorkspaceMembership(req, res as never, (() => {
      nextCalled = true;
    }) as never);

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
  });
});
