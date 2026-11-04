import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Types } from "mongoose";

import app from "../src/app.js";
import {
  computeCanonicalInternalHmac,
  requireInternalIngressAuth,
  ALLOWED_INTERNAL_ROUTES,
  type RawBodyRequest,
} from "../src/middlewares/internal-ingress-auth.js";
import InternalWebhookNonce from "../src/modules/whatsapp/internal-webhook-nonce.model.js";
import MetaPlatformConfig from "../src/modules/whatsapp/meta-platform-config.model.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import Contact from "../src/modules/whatsapp/contact.model.js";

const TEST_INTERNAL_SECRET = "test_internal_hmac_secret_64_bytes_super_secure_random_key_1234567";
const TEST_META_APP_SECRET = "test_meta_app_secret_1234567890abcdef1234567890abcdef";

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      res.headers["content-type"] = "application/json";
      return res;
    },
    send(data: any) {
      res.body = data;
      return res;
    },
    sendStatus(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: any) {
      res.headers[name.toLowerCase()] = String(value);
      return res;
    },
    removeHeader(name: string) {
      delete res.headers[name.toLowerCase()];
      return res;
    },
    getHeader(name: string) {
      return res.headers[name.toLowerCase()];
    },
  };
  return res;
}

function createMockAppRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  rawBody?: Buffer;
  body?: any;
}) {
  const req: any = {
    method: options.method,
    url: options.url,
    originalUrl: options.url,
    headers: options.headers ?? {},
    rawBody: options.rawBody,
    body: options.body,
    socket: {
      remoteAddress: "127.0.0.1",
    },
    connection: {
      remoteAddress: "127.0.0.1",
    },
  };
  return req;
}

function dispatchAppRequest(req: any, res: any): Promise<any> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve(res);
      }
    };

    res.end = function (...args: any[]) {
      if (args[0] && !res.body) {
        try {
          res.body = JSON.parse(args[0].toString());
        } catch {
          res.body = args[0].toString();
        }
      }
      finish();
    };

    res.json = function (data: any) {
      res.body = data;
      res.headers["content-type"] = "application/json";
      finish();
      return res;
    };

    res.send = function (data: any) {
      if (!res.body) res.body = data;
      finish();
      return res;
    };

    res.sendStatus = function (code: number) {
      res.statusCode = code;
      finish();
      return res;
    };

    app(req, res, () => {
      finish();
    });
  });
}

function generateMetaSignature(body: Buffer, secret: string = TEST_META_APP_SECRET): string {
  const hash = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hash}`;
}

describe("Step 45A: Internal Webhook Security & Ingress Mutual Authentication", () => {
  const originalInternalSecret = process.env.INTERNAL_WEBHOOK_SECRET;
  const originalMetaAppSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_WEBHOOK_SECRET = TEST_INTERNAL_SECRET;
    process.env.META_APP_SECRET = TEST_META_APP_SECRET;
  });

  afterEach(() => {
    mock.restoreAll();
    if (originalInternalSecret !== undefined) {
      process.env.INTERNAL_WEBHOOK_SECRET = originalInternalSecret;
    } else {
      delete process.env.INTERNAL_WEBHOOK_SECRET;
    }

    if (originalMetaAppSecret !== undefined) {
      process.env.META_APP_SECRET = originalMetaAppSecret;
    } else {
      delete process.env.META_APP_SECRET;
    }
  });

  describe("1. Canonical HMAC Construction and Byte Binding", () => {
    it("binds method, path, timestamp, nonce, and rawBody into canonical HMAC", () => {
      const timestamp = "1793600000000";
      const nonce = "550e8400-e29b-41d4-a716-446655440000";
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));

      const sig1 = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      assert.match(sig1, /^sha256=[0-9a-f]{64}$/);

      // Mutating method changes signature
      const sigDiffMethod = computeCanonicalInternalHmac(
        "GET",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );
      assert.notEqual(sig1, sigDiffMethod);

      // Mutating path changes signature
      const sigDiffPath = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook-verified",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );
      assert.notEqual(sig1, sigDiffPath);

      // Mutating body by 1 byte changes signature
      const alteredBody = Buffer.from(rawBody);
      alteredBody[alteredBody.length - 1] = alteredBody[alteredBody.length - 1] ^ 1;
      const sigDiffBody = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        alteredBody,
        TEST_INTERNAL_SECRET,
      );
      assert.notEqual(sig1, sigDiffBody);
    });

    it("verifies canonical HMAC correctly for empty body (audit request)", () => {
      const timestamp = "1793600000000";
      const nonce = "550e8400-e29b-41d4-a716-446655440001";
      const emptyBody = Buffer.alloc(0);

      const sig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook-verified",
        timestamp,
        nonce,
        emptyBody,
        TEST_INTERNAL_SECRET,
      );

      assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    });
  });

  describe("2. Internal Authentication Middleware: Timestamp & Nonce Validation", () => {
    it("rejects non-POST HTTP methods with 405 Method Not Allowed", async () => {
      const req: any = {
        method: "GET",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        headers: {},
      };
      const res = createMockResponse();
      let nextCalled = false;

      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers["allow"], "POST");
      assert.equal(res.body?.code, "DISALLOWED_METHOD");
    });

    it("rejects non-allowlisted paths with 404 Not Found", async () => {
      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/unauthorized-path",
        headers: {},
      };
      const res = createMockResponse();
      let nextCalled = false;

      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 404);
      assert.equal(res.body?.code, "DISALLOWED_ROUTE");
    });

    it("rejects malformed timestamp format with 401 INVALID_TIMESTAMP", async () => {
      const invalidTimestamps = [
        "not_a_number",
        "12345", // too short
        "123456789012345", // too long
        "-1700000000000", // negative
        "1700000000000.5", // decimal dot
        "0170000000000", // leading zero
      ];

      for (const ts of invalidTimestamps) {
        const req: any = {
          method: "POST",
          baseUrl: "/api/whatsapp",
          path: "/webhook",
          headers: {
            "x-internal-timestamp": ts,
          },
        };
        const res = createMockResponse();

        await requireInternalIngressAuth(req, res, () => { });

        assert.equal(res.statusCode, 401, `Failed for timestamp: ${ts}`);
        assert.equal(res.body?.code, "INVALID_TIMESTAMP");
      }
    });

    it("rejects expired timestamp (>300s old) with 401 EXPIRED_TIMESTAMP", async () => {
      const expiredTs = String(Date.now() - 301_000);
      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        headers: {
          "x-internal-timestamp": expiredTs,
        },
      };
      const res = createMockResponse();

      await requireInternalIngressAuth(req, res, () => { });

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "EXPIRED_TIMESTAMP");
    });

    it("rejects future timestamp (>300s in future) with 401 EXPIRED_TIMESTAMP", async () => {
      const futureTs = String(Date.now() + 301_000);
      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        headers: {
          "x-internal-timestamp": futureTs,
        },
      };
      const res = createMockResponse();

      await requireInternalIngressAuth(req, res, () => { });

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "EXPIRED_TIMESTAMP");
    });

    it("rejects invalid UUIDv4 nonce format with 401 INVALID_NONCE", async () => {
      const invalidNonces = [
        "not-a-uuid",
        "550e8400-e29b-11d4-a716-446655440000", // v1, not v4
        "550e8400e29be29be29be29be29be29b", // missing hyphens
        "12345",
      ];

      for (const nonce of invalidNonces) {
        const req: any = {
          method: "POST",
          baseUrl: "/api/whatsapp",
          path: "/webhook",
          headers: {
            "x-internal-timestamp": String(Date.now()),
            "x-internal-nonce": nonce,
          },
        };
        const res = createMockResponse();

        await requireInternalIngressAuth(req, res, () => { });

        assert.equal(res.statusCode, 401, `Failed for nonce: ${nonce}`);
        assert.equal(res.body?.code, "INVALID_NONCE");
      }
    });

    it("rejects missing or invalid internal signature with 401 INVALID_INTERNAL_SIGNATURE", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440002";
      const rawBody = Buffer.from(JSON.stringify({ test: "data" }));

      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        rawBody,
        headers: {
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": "sha256=invalid_signature_hex_length_is_correct_0123456789abcdef0123456789abc",
        },
      };
      const res = createMockResponse();

      await requireInternalIngressAuth(req, res, () => { });

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "INVALID_INTERNAL_SIGNATURE");
    });

    it("atomically inserts nonce and calls next() on valid signature", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440003";
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));

      const signature = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      let insertedRecord: any = null;
      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => {
        insertedRecord = doc;
        return { acknowledged: true, insertedId: doc._id };
      });

      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        rawBody,
        headers: {
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": signature,
        },
      };
      const res = createMockResponse();
      let nextCalled = false;

      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.notEqual(insertedRecord, null);
      assert.equal(insertedRecord._id, nonce);
      assert.equal(insertedRecord.timestamp.getTime(), Number(timestamp));
    });

    it("rejects replayed nonce with 409 REPLAY_NONCE_DETECTED on duplicate key error (E11000)", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440004";
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));

      const signature = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      // Simulate MongoDB duplicate key error
      mock.method(InternalWebhookNonce.collection, "insertOne", async () => {
        const error: any = new Error("E11000 duplicate key error collection");
        error.code = 11000;
        throw error;
      });

      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        rawBody,
        headers: {
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": signature,
        },
      };
      const res = createMockResponse();
      let nextCalled = false;

      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body?.code, "REPLAY_NONCE_DETECTED");
    });

    it("fails closed with 500 NONCE_STORAGE_FAILED when MongoDB connection fails", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440005";
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));

      const signature = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      // Simulate unexpected database drop
      mock.method(InternalWebhookNonce.collection, "insertOne", async () => {
        throw new Error("MongoNetworkTimeoutError: connection timed out");
      });

      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        rawBody,
        headers: {
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": signature,
        },
      };
      const res = createMockResponse();
      let nextCalled = false;

      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body?.code, "NONCE_STORAGE_FAILED");
    });

    it("preserves canonical path when query string is attached to URL", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440006";
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));

      // Canonical signature signs path without query parameters
      const signature = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => ({
        acknowledged: true,
        insertedId: doc._id,
      }));

      const req: any = {
        method: "POST",
        baseUrl: "/api/whatsapp",
        path: "/webhook",
        originalUrl: "/api/whatsapp/webhook?debug=true&param=123",
        rawBody,
        headers: {
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": signature,
        },
      };
      const res = createMockResponse();
      let nextCalled = false;

      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });
  });

  describe("3. Legacy Route Removal and End-to-End Routing via App", () => {
    it("handles public GET /api/whatsapp/webhook verification (200 on valid, 403 on invalid)", async () => {
      // 1. Missing or invalid query returns 403
      const reqInvalid = createMockAppRequest({
        method: "GET",
        url: "/api/whatsapp/webhook",
      });
      const resInvalid = createMockResponse();
      await dispatchAppRequest(reqInvalid, resInvalid);
      assert.equal(resInvalid.statusCode, 403);

      // 2. Valid handshake returns 200 plain text challenge
      const originalVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
      process.env.META_WEBHOOK_VERIFY_TOKEN = "test_meta_verify_token_123";
      mock.method(MetaPlatformConfig, "findOneAndUpdate", async () => ({
        key: "webhook_verification",
        webhookVerified: true,
      }));

      const reqValid = createMockAppRequest({
        method: "GET",
        url: "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test_meta_verify_token_123&hub.challenge=test_challenge_abc",
      });
      (reqValid as any).query = {
        "hub.mode": "subscribe",
        "hub.verify_token": "test_meta_verify_token_123",
        "hub.challenge": "test_challenge_abc",
      };
      const resValid = createMockResponse();
      await dispatchAppRequest(reqValid, resValid);
      assert.equal(resValid.statusCode, 200);
      assert.equal(resValid.body, "test_challenge_abc");

      if (originalVerifyToken !== undefined) {
        process.env.META_WEBHOOK_VERIFY_TOKEN = originalVerifyToken;
      } else {
        delete process.env.META_WEBHOOK_VERIFY_TOKEN;
      }
    });

    it("rejects unauthenticated request to POST /api/whatsapp/internal/webhook with 401", async () => {
      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/internal/webhook",
        headers: {
          "content-type": "application/json",
        },
        body: {},
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "INVALID_TIMESTAMP");
    });

    it("rejects unauthenticated request to POST /api/whatsapp/internal/webhook-verified with 401", async () => {
      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/internal/webhook-verified",
        headers: {
          "content-type": "application/json",
        },
        body: {},
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "INVALID_TIMESTAMP");
    });

    it("successfully persists audit and returns 200 on authenticated POST /api/whatsapp/internal/webhook-verified", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440007";
      const rawBody = Buffer.from(JSON.stringify({}));

      const signature = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook-verified",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => ({
        acknowledged: true,
        insertedId: doc._id,
      }));

      let persistenceCalled = false;
      mock.method(MetaPlatformConfig, "findOneAndUpdate", async (query: any, update: any) => {
        persistenceCalled = true;
        assert.equal(query.key, "webhook_verification");
        assert.equal(update.$set.webhookVerified, true);
        return { key: "webhook_verification", webhookVerified: true };
      });

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/internal/webhook-verified",
        headers: {
          "content-type": "application/json",
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": signature,
        },
        rawBody,
        body: {},
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body?.success, true);
      assert.equal(persistenceCalled, true);
    });
  });

  describe("4. Meta Signature Verification & Safe test_ping Handling", () => {
    it("rejects request to POST /api/whatsapp/webhook with missing Meta signature with 401", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440008";
      const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));

      const internalSig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => ({
        acknowledged: true,
        insertedId: doc._id,
      }));

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/webhook",
        headers: {
          "content-type": "application/json",
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": internalSig,
          // Intentionally omitting x-hub-signature-256
        },
        rawBody,
        body: JSON.parse(rawBody.toString()),
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "INVALID_META_SIGNATURE");
    });

    it("rejects request to POST /api/whatsapp/webhook with invalid Meta signature with 401", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440009";
      const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));

      const internalSig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => ({
        acknowledged: true,
        insertedId: doc._id,
      }));

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/webhook",
        headers: {
          "content-type": "application/json",
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": internalSig,
          "x-hub-signature-256": "sha256=invalid_meta_signature_hex_digest_0123456789abcdef0123456789abcdef",
        },
        rawBody,
        body: JSON.parse(rawBody.toString()),
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "INVALID_META_SIGNATURE");
    });

    it("safely handles valid signed test_ping on internal webhook: consumes security nonce, incurs zero business mutations, returns 200", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440010";
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));

      const internalSig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );
      const metaSig = generateMetaSignature(rawBody, TEST_META_APP_SECRET);

      let nonceStored = false;
      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => {
        nonceStored = true;
        assert.equal(doc._id, nonce);
        return { acknowledged: true, insertedId: doc._id };
      });

      // Spies to confirm ZERO business mutations occur
      let messageSaved = false;
      let contactSaved = false;
      let accountModified = false;

      mock.method(WhatsAppMessage.prototype, "save", async () => {
        messageSaved = true;
      });
      mock.method(Contact.prototype, "save", async () => {
        contactSaved = true;
      });
      mock.method(WhatsAppAccount, "findOneAndUpdate", async () => {
        accountModified = true;
      });

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/internal/webhook",
        headers: {
          "content-type": "application/json",
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": internalSig,
          "x-hub-signature-256": metaSig,
        },
        rawBody,
        body: JSON.parse(rawBody.toString()),
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      // Verify HTTP 200 response
      assert.equal(res.statusCode, 200);

      // Verify security record was consumed
      assert.equal(nonceStored, true, "Expected security nonce to be stored");

      // Verify ZERO business domain mutations
      assert.equal(messageSaved, false, "Expected zero WhatsApp messages to be saved");
      assert.equal(contactSaved, false, "Expected zero contacts to be saved or modified");
      assert.equal(accountModified, false, "Expected zero WhatsApp accounts to be modified");
    });

    it("allows public POST /api/whatsapp/webhook with valid Meta signature without requiring internal ingress headers", async () => {
      const rawBody = Buffer.from(JSON.stringify({ object: "test_ping" }));
      const metaSig = generateMetaSignature(rawBody, TEST_META_APP_SECRET);

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": metaSig,
        },
        rawBody,
        body: JSON.parse(rawBody.toString()),
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 200);
    });

    it("does not allow internal ingress authentication to substitute for Meta signature on internal webhook", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440097";
      const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));

      const internalSig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => ({
        acknowledged: true,
        insertedId: doc._id,
      }));

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/internal/webhook",
        headers: {
          "content-type": "application/json",
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": internalSig,
          // Intentionally omitting x-hub-signature-256
        },
        rawBody,
        body: JSON.parse(rawBody.toString()),
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body?.code, "INVALID_META_SIGNATURE");
    });

    it("acknowledges duplicate waMessageId with HTTP 200 on internal webhook without creating duplicate business records", async () => {
      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440011";

      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID_123",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    phone_number_id: "phone_123",
                  },
                  messages: [
                    {
                      from: "1234567890",
                      id: "wamid.duplicate_test_id_123",
                      timestamp: "1700000000",
                      type: "text",
                      text: { body: "Duplicate test" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const rawBody = Buffer.from(JSON.stringify(payload));
      const internalSig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );
      const metaSig = generateMetaSignature(rawBody, TEST_META_APP_SECRET);

      let nonceStored = false;
      mock.method(InternalWebhookNonce.collection, "insertOne", async (doc: any) => {
        nonceStored = true;
        return { acknowledged: true, insertedId: doc._id };
      });

      const accountId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();

      mock.method(WhatsAppAccount, "findOne", async () => ({
        _id: accountId,
        workspaceId,
        status: "CONNECTED",
      }));

      mock.method(Workspace, "findById", async () => ({
        _id: workspaceId,
        status: "ACTIVE",
      }));

      // Existing message found in database
      const existingMessageId = new Types.ObjectId();
      mock.method(WhatsAppMessage, "findOne", async () => ({
        _id: existingMessageId,
        waMessageId: "wamid.duplicate_test_id_123",
      }));

      let messageSaveCalled = false;
      mock.method(WhatsAppMessage.prototype, "save", async () => {
        messageSaveCalled = true;
      });

      const req = createMockAppRequest({
        method: "POST",
        url: "/api/whatsapp/internal/webhook",
        headers: {
          "content-type": "application/json",
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": internalSig,
          "x-hub-signature-256": metaSig,
        },
        rawBody,
        body: payload,
      });
      const res = createMockResponse();

      await dispatchAppRequest(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(nonceStored, true);
      assert.equal(messageSaveCalled, false, "Expected zero new messages saved on duplicate");
    });

    it("accepts valid internal HMAC when configured via VEXCHAT_INTERNAL_WEBHOOK_SECRET", async () => {
      delete process.env.INTERNAL_WEBHOOK_SECRET;
      process.env.VEXCHAT_INTERNAL_WEBHOOK_SECRET = TEST_INTERNAL_SECRET;

      let nonceStored = false;
      mock.method(InternalWebhookNonce.collection, "insertOne", async () => {
        nonceStored = true;
        return {} as any;
      });

      const timestamp = String(Date.now());
      const nonce = "550e8400-e29b-41d4-a716-446655440099";
      const rawBody = Buffer.from(JSON.stringify({ test: "data" }), "utf8");
      const sig = computeCanonicalInternalHmac(
        "POST",
        "/api/whatsapp/internal/webhook-verified",
        timestamp,
        nonce,
        rawBody,
        TEST_INTERNAL_SECRET,
      );

      const req: any = {
        method: "POST",
        originalUrl: "/api/whatsapp/internal/webhook-verified",
        headers: {
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": sig,
        },
        rawBody,
      };
      const res = createMockResponse();

      let nextCalled = false;
      await requireInternalIngressAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(nonceStored, true);

      delete process.env.VEXCHAT_INTERNAL_WEBHOOK_SECRET;
      process.env.INTERNAL_WEBHOOK_SECRET = TEST_INTERNAL_SECRET;
    });
  });
});
