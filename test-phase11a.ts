/**
 * Phase 11A: Critical Backend Integration Fixes - Test Suite
 *
 * Verifies all 15 test scenarios specified in Phase 11A requirements:
 *
 * 1.  Valid phone number verification (mock fetch returning proper fields)
 * 2.  Invalid phone number ID (mock returns different ID)
 * 3.  Valid WABA verification (mock WABA endpoint)
 * 4.  Mismatched WABA and phone number (phone's WABA doesn't match input)
 * 5.  Invalid access token (mock 401 with code 190)
 * 6.  Expired token (mock code 190 subcode 463)
 * 7.  Insufficient permission (mock code 10/200)
 * 8.  Safe Meta error handling (verify no raw errors leak)
 * 9.  SENT → DELIVERED transition
 * 10. DELIVERED → READ transition
 * 11. READ cannot regress to DELIVERED
 * 12. Duplicate webhook (same wamid)
 * 13. Invalid webhook signature
 * 14. Unsupported message type (image persisted as IMAGE type)
 * 15. Missing account mapping (returns accountNotFound)
 *
 * Run with: npx tsx test-phase11a.ts
 */

import "dotenv/config";
import process from "node:process";
import { Types } from "mongoose";
import { createHmac } from "node:crypto";
import { AppError } from "./src/utils/app-error.js";
import WhatsAppAccount from "./src/modules/whatsapp/whatsapp.model.js";
import WhatsAppContact from "./src/modules/whatsapp/contact.model.js";
import WhatsAppConversation from "./src/modules/whatsapp/conversation.model.js";
import WhatsAppMessage from "./src/modules/whatsapp/message.model.js";
import type { WhatsAppMessageStatus } from "./src/modules/whatsapp/message.model.js";
import Workspace from "./src/modules/workspace/workspace.model.js";

import {
  mapMetaApiError,
  verifyWhatsAppCredentials,
  verifyWhatsAppBusinessAccount,
  verifyPhoneNumberInWaba,
} from "./src/modules/services/whatsapp-api.service.js";

import {
  STATUS_RANK,
  processIncomingWhatsAppMessage,
  updateWhatsAppMessageStatus,
} from "./src/modules/services/whatsapp-message.service.js";

import {
  verifyWhatsAppWebhookSignature,
} from "./src/modules/services/whatsapp-webhook.service.js";


// ──────────────────────────────────────────────────────────
// In-Memory Mock Stores (same pattern as test-templates.ts)
// ──────────────────────────────────────────────────────────

interface MockAccount {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  phoneNumberId: string;
  status: string;
  accessTokenEncrypted: string;
  businessAccountId: string;
}

interface MockMessage {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  waMessageId: string;
  direction: string;
  type: string;
  status: WhatsAppMessageStatus;
  text?: string;
  mediaId?: string;
  mediaMimeType?: string;
  timestamp: Date;
  statusUpdatedAt?: Date;
  errorMessage?: string;
  save: () => Promise<MockMessage>;
}

interface MockContact {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  waId: string;
  phoneNumber: string;
  profileName?: string;
}

interface MockConversation {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  contactId: Types.ObjectId;
  status: string;
  lastMessageAt: Date;
  save: () => Promise<MockConversation>;
}

const mockAccountsStore: MockAccount[] = [];
const mockMessagesStore: MockMessage[] = [];
const mockContactsStore: MockContact[] = [];
const mockConversationsStore: MockConversation[] = [];

// ──────────────────────────────────────────────────────────
// Mock Mongoose Models
// ──────────────────────────────────────────────────────────

// WhatsAppAccount.findOne
(WhatsAppAccount as unknown as Record<string, unknown>).findOne = (
  filter: Record<string, unknown>,
) => {
  const result = mockAccountsStore.find((acc) => {
    if (filter.phoneNumberId && acc.phoneNumberId !== filter.phoneNumberId) return false;
    if (filter.status && acc.status !== filter.status) return false;
    if (filter.workspaceId && !acc.workspaceId.equals(filter.workspaceId as Types.ObjectId)) return false;
    return true;
  });

  return {
    select: () => result ?? null,
    then: (resolve: (v: unknown) => void) => resolve(result ?? null),
  };
};

// Workspace.findById — always returns a mock active workspace so webhook processing
// tests do not attempt a real MongoDB connection.
(Workspace as unknown as Record<string, unknown>).findById = (
  _id: unknown,
) => {
  // Return a minimal workspace stub that is ACTIVE (not SUSPENDED)
  return Promise.resolve({
    _id,
    status: "ACTIVE",
    name: "Test Workspace",
  });
};

// WhatsAppMessage.findOne
(WhatsAppMessage as unknown as Record<string, unknown>).findOne = (
  filter: Record<string, unknown>,
) => {
  const result = mockMessagesStore.find((msg) => {
    if (filter.whatsappAccountId) {
      const filterId = typeof filter.whatsappAccountId === "string"
        ? filter.whatsappAccountId
        : String(filter.whatsappAccountId);
      if (String(msg.whatsappAccountId) !== filterId) return false;
    }
    if (filter.waMessageId && msg.waMessageId !== filter.waMessageId) return false;
    if (filter.direction && msg.direction !== filter.direction) return false;
    return true;
  });
  return result ?? null;
};

// WhatsAppMessage.create
(WhatsAppMessage as unknown as Record<string, unknown>).create = (
  data: Record<string, unknown>,
) => {
  const existingDuplicate = mockMessagesStore.find(
    (m) =>
      String(m.whatsappAccountId) === String(data.whatsappAccountId) &&
      m.waMessageId === data.waMessageId,
  );
  if (existingDuplicate) {
    const dupeError: { code?: number; message?: string } = new Error("Duplicate key");
    dupeError.code = 11000;
    throw dupeError;
  }

  const msg: MockMessage = {
    _id: new Types.ObjectId(),
    workspaceId: data.workspaceId as Types.ObjectId,
    conversationId: data.conversationId as Types.ObjectId,
    contactId: data.contactId as Types.ObjectId,
    whatsappAccountId: data.whatsappAccountId as Types.ObjectId,
    waMessageId: data.waMessageId as string,
    direction: data.direction as string,
    type: data.type as string,
    status: data.status as WhatsAppMessageStatus,
    text: data.text as string | undefined,
    mediaId: data.mediaId as string | undefined,
    mediaMimeType: data.mediaMimeType as string | undefined,
    timestamp: data.timestamp as Date,
    statusUpdatedAt: data.statusUpdatedAt as Date | undefined,
    errorMessage: data.errorMessage as string | undefined,
    save: async function () {
      return this;
    },
  };
  mockMessagesStore.push(msg);
  return msg;
};

// WhatsAppContact.findOneAndUpdate
(WhatsAppContact as unknown as Record<string, unknown>).findOneAndUpdate = (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  _options: unknown,
) => {
  const existing = mockContactsStore.find(
    (c) =>
      String(c.workspaceId) === String(filter.workspaceId) &&
      c.waId === filter.waId,
  );
  if (existing) {
    const setData = (update as { $set?: Record<string, unknown> }).$set ?? {};
    if (setData.profileName) existing.profileName = setData.profileName as string;
    return existing;
  }

  const contact: MockContact = {
    _id: new Types.ObjectId(),
    workspaceId: filter.workspaceId as Types.ObjectId,
    waId: filter.waId as string,
    phoneNumber: filter.waId as string,
    profileName: (
      (update as { $set?: Record<string, unknown> }).$set?.profileName as string | undefined
    ),
  };
  mockContactsStore.push(contact);
  return contact;
};

// WhatsAppConversation.findOneAndUpdate
(WhatsAppConversation as unknown as Record<string, unknown>).findOneAndUpdate = (
  filter: Record<string, unknown>,
  _update: unknown,
  _options: unknown,
) => {
  const existing = mockConversationsStore.find(
    (c) =>
      String(c.workspaceId) === String(filter.workspaceId) &&
      String(c.whatsappAccountId) === String(filter.whatsappAccountId) &&
      String(c.contactId) === String(filter.contactId),
  );
  if (existing) {
    return existing;
  }

  const conv: MockConversation = {
    _id: new Types.ObjectId(),
    workspaceId: filter.workspaceId as Types.ObjectId,
    whatsappAccountId: filter.whatsappAccountId as Types.ObjectId,
    contactId: filter.contactId as Types.ObjectId,
    status: "OPEN",
    lastMessageAt: new Date(),
    save: async function () { return this; },
  };
  mockConversationsStore.push(conv);
  return conv;
};


// ──────────────────────────────────────────────────────────
// Mock fetch for Meta API tests
// ──────────────────────────────────────────────────────────
const originalFetch = globalThis.fetch;
let fetchMock: ((url: string | URL | Request, init?: RequestInit) => Promise<Response>) | null = null;

function setFetchMock(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  fetchMock = handler;
}

function clearFetchMock() {
  fetchMock = null;
}

globalThis.fetch = async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  if (fetchMock) {
    return fetchMock(url, init);
  }
  return originalFetch(url, init);
};


// ──────────────────────────────────────────────────────────
// Test Utilities
// ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function clearStores() {
  mockAccountsStore.length = 0;
  mockMessagesStore.length = 0;
  mockContactsStore.length = 0;
  mockConversationsStore.length = 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    clearStores();
    clearFetchMock();
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${error instanceof Error ? error.message : error}`);
    failed++;
  }
}


// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║   Phase 11A: Critical Backend Integration Fixes - Tests    ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// ── Group 1: Phone Number & WABA Verification (Tests 1-4) ──

console.log("── Phone Number & WABA Verification ──\n");

await runTest("1. Valid phone number verification", async () => {
  setFetchMock(async () => {
    return new Response(
      JSON.stringify({
        id: "1234567890",
        display_phone_number: "+1 555-123-4567",
        verified_name: "Test Business",
        quality_rating: "GREEN",
        code_verification_status: "VERIFIED",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await verifyWhatsAppCredentials("1234567890", "test-token");
  assert(result.id === "1234567890", "ID should match");
  assert(result.displayPhoneNumber === "+1 555-123-4567", "Display phone should match");
  assert(result.verifiedName === "Test Business", "Verified name should match");
  assert(result.qualityRating === "GREEN", "Quality rating should match");
});

await runTest("2. Invalid phone number ID (mismatched ID)", async () => {
  setFetchMock(async () => {
    return new Response(
      JSON.stringify({ id: "DIFFERENT_ID", display_phone_number: "+1 555-000-0000" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  try {
    await verifyWhatsAppCredentials("1234567890", "test-token");
    assert(false, "Should have thrown");
  } catch (error) {
    assert(error instanceof AppError, "Should be AppError");
    assert(error.statusCode === 400, "Should be 400");
    assert(error.message.includes("verification failed"), "Should mention verification failure");
  }
});

await runTest("3. Valid WABA verification", async () => {
  setFetchMock(async () => {
    return new Response(
      JSON.stringify({
        id: "WABA_001",
        name: "Test WABA",
        timezone_id: "1",
        currency: "USD",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await verifyWhatsAppBusinessAccount("WABA_001", "test-token");
  assert(result.id === "WABA_001", "WABA ID should match");
  assert(result.name === "Test WABA", "WABA name should match");
  assert(result.currency === "USD", "Currency should match");
});

await runTest("4. Mismatched WABA and phone number", async () => {
  // Simulate WABA phone_numbers endpoint returning only PHONE_002
  setFetchMock(async () => {
    return new Response(
      JSON.stringify({
        data: [{ id: "PHONE_002", display_phone_number: "+1 555-999-9999" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const isMember = await verifyPhoneNumberInWaba("WABA_001", "PHONE_001", "test-token");
  assert(isMember === false, "PHONE_001 should not be found in WABA_001 phone numbers");
});


// ── Group 2: Meta API Error Mapping (Tests 5-8) ──

console.log("\n── Meta API Error Mapping ──\n");

await runTest("5. Invalid access token (code 190)", async () => {
  setFetchMock(async () => {
    return new Response(
      JSON.stringify({
        error: {
          message: "Invalid OAuth access token - Cannot parse access token",
          type: "OAuthException",
          code: 190,
          fbtrace_id: "ABC123",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  });

  try {
    await verifyWhatsAppCredentials("1234567890", "bad-token");
    assert(false, "Should have thrown");
  } catch (error) {
    assert(error instanceof AppError, "Should be AppError");
    assert(error.statusCode === 401, `Should be 401, got ${error.statusCode}`);
    assert(!error.message.includes("OAuth"), "Should not leak internal error details");
    assert(!error.message.includes("bad-token"), "Should not contain the token");
  }
});

await runTest("6. Expired token (code 190, subcode 463)", async () => {
  const error = mapMetaApiError(401, {
    code: 190,
    error_subcode: 463,
    message: "Error validating access token: Session has expired",
    type: "OAuthException",
  });

  assert(error instanceof AppError, "Should be AppError");
  assert(error.statusCode === 401, "Should be 401");
  assert(error.message.includes("expired"), "Should mention expiry");
  assert(!error.message.includes("Session"), "Should not leak raw message");
});

await runTest("7. Insufficient permission (code 10 and 200)", async () => {
  const error10 = mapMetaApiError(403, {
    code: 10,
    message: "Application does not have permission for this action",
    type: "OAuthException",
  });
  assert(error10.statusCode === 403, "Code 10 should map to 403");
  assert(error10.message.includes("permission"), "Should mention permission");

  const error200 = mapMetaApiError(403, {
    code: 200,
    message: "Requires extended permission: whatsapp_business_messaging",
    type: "OAuthException",
  });
  assert(error200.statusCode === 403, "Code 200 should map to 403");
  assert(error200.message.includes("permission"), "Should mention permission");
});

await runTest("8. Safe Meta error handling (no raw errors leak)", async () => {
  // Verify that various error scenarios NEVER include raw Meta messages
  const testCases = [
    { status: 400, error: { code: 100, message: "Unsupported get request. Object with ID 'xxx' does not exist" } },
    { status: 429, error: { code: 4, message: "Application request limit reached (#4)" } },
    { status: 500, error: { code: 1, message: "An unknown error occurred" } },
    { status: 401, error: { code: 190, message: "Invalid OAuth 2.0 access token (Bearer MY_SECRET_TOKEN_123)" } },
  ];

  for (const tc of testCases) {
    const err = mapMetaApiError(tc.status, tc.error);
    assert(err instanceof AppError, "Should be AppError");
    // Must never contain raw Meta error message content
    assert(!err.message.includes("Object with ID"), "Must not leak raw error");
    assert(!err.message.includes("MY_SECRET_TOKEN_123"), "Must not leak token from error");
    assert(!err.message.includes("#4"), "Must not leak internal error code format");
  }
});


// ── Group 3: Message Status Transitions (Tests 9-11) ──

console.log("\n── Message Status Transitions ──\n");

await runTest("9. SENT → DELIVERED transition", async () => {
  const accountId = new Types.ObjectId();
  const msg: MockMessage = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    whatsappAccountId: accountId,
    waMessageId: "wamid.test001",
    direction: "OUTBOUND",
    type: "TEXT",
    status: "SENT",
    timestamp: new Date(),
    statusUpdatedAt: undefined,
    save: async function () { return this; },
  };
  mockMessagesStore.push(msg);

  const result = await updateWhatsAppMessageStatus({
    whatsappAccountId: accountId.toString(),
    messageId: "wamid.test001",
    status: "DELIVERED",
    timestamp: String(Math.floor(Date.now() / 1000)),
  });

  assert(result !== null, "Should return message");
  assert(result!.status === "DELIVERED", `Status should be DELIVERED, got ${result!.status}`);
});

await runTest("10. DELIVERED → READ transition", async () => {
  const accountId = new Types.ObjectId();
  const now = Math.floor(Date.now() / 1000);
  const msg: MockMessage = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    whatsappAccountId: accountId,
    waMessageId: "wamid.test002",
    direction: "OUTBOUND",
    type: "TEXT",
    status: "DELIVERED",
    timestamp: new Date(),
    statusUpdatedAt: new Date(now * 1000),
    save: async function () { return this; },
  };
  mockMessagesStore.push(msg);

  const result = await updateWhatsAppMessageStatus({
    whatsappAccountId: accountId.toString(),
    messageId: "wamid.test002",
    status: "READ",
    timestamp: String(now + 5),
  });

  assert(result !== null, "Should return message");
  assert(result!.status === "READ", `Status should be READ, got ${result!.status}`);
});

await runTest("11. READ cannot regress to DELIVERED", async () => {
  const accountId = new Types.ObjectId();
  const now = Math.floor(Date.now() / 1000);
  const msg: MockMessage = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    whatsappAccountId: accountId,
    waMessageId: "wamid.test003",
    direction: "OUTBOUND",
    type: "TEXT",
    status: "READ",
    timestamp: new Date(),
    statusUpdatedAt: new Date(now * 1000),
    save: async function () { return this; },
  };
  mockMessagesStore.push(msg);

  const result = await updateWhatsAppMessageStatus({
    whatsappAccountId: accountId.toString(),
    messageId: "wamid.test003",
    status: "DELIVERED",
    timestamp: String(now + 10), // Even with a newer timestamp
  });

  assert(result !== null, "Should return message");
  assert(result!.status === "READ", `Status should remain READ, got ${result!.status}`);
});


// ── Group 4: Webhook Processing (Tests 12-15) ──

console.log("\n── Webhook Processing ──\n");

await runTest("12. Duplicate webhook (same wamid)", async () => {
  const workspaceId = new Types.ObjectId();
  const accountId = new Types.ObjectId();

  mockAccountsStore.push({
    _id: accountId,
    workspaceId,
    phoneNumberId: "PH_DUP_TEST",
    status: "CONNECTED",
    accessTokenEncrypted: "enc-test",
    businessAccountId: "WABA_DUP",
  });

  // First message — should succeed
  const result1 = await processIncomingWhatsAppMessage({
    phoneNumberId: "PH_DUP_TEST",
    contactName: "Test User",
    message: {
      from: "15551234567",
      id: "wamid.dup001",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "TEXT",
      text: "Hello",
    },
  });

  assert(!result1.duplicate, "First message should not be duplicate");

  // Duplicate — same wamid
  const result2 = await processIncomingWhatsAppMessage({
    phoneNumberId: "PH_DUP_TEST",
    contactName: "Test User",
    message: {
      from: "15551234567",
      id: "wamid.dup001",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "TEXT",
      text: "Hello",
    },
  });

  assert(result2.duplicate === true, "Second message should be detected as duplicate");
});

await runTest("13. Invalid webhook signature", async () => {
  const appSecret = process.env.META_APP_SECRET || "test-secret-for-unit-tests";
  // Temporarily set secret for test
  const origSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = appSecret;

  const body = Buffer.from(JSON.stringify({ test: "data" }));
  const validSig = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  const invalidSig = "sha256=0000000000000000000000000000000000000000000000000000000000000000";

  // Valid signature should pass
  const validResult = verifyWhatsAppWebhookSignature(body, validSig);
  assert(validResult === true, "Valid signature should return true");

  // Invalid signature should fail
  const invalidResult = verifyWhatsAppWebhookSignature(body, invalidSig);
  assert(invalidResult === false, "Invalid signature should return false");

  // Missing signature should fail
  const missingResult = verifyWhatsAppWebhookSignature(body, undefined);
  assert(missingResult === false, "Missing signature should return false");

  // Wrong prefix should fail
  const wrongPrefixResult = verifyWhatsAppWebhookSignature(body, "sha1=abcdef");
  assert(wrongPrefixResult === false, "Wrong prefix should return false");

  // Restore
  process.env.META_APP_SECRET = origSecret;
});

await runTest("14. Unsupported message type (image persisted as IMAGE)", async () => {
  const workspaceId = new Types.ObjectId();
  const accountId = new Types.ObjectId();

  mockAccountsStore.push({
    _id: accountId,
    workspaceId,
    phoneNumberId: "PH_IMAGE_TEST",
    status: "CONNECTED",
    accessTokenEncrypted: "enc-test",
    businessAccountId: "WABA_IMAGE",
  });

  const result = await processIncomingWhatsAppMessage({
    phoneNumberId: "PH_IMAGE_TEST",
    contactName: "Image Sender",
    message: {
      from: "15559876543",
      id: "wamid.img001",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "IMAGE",
      mediaId: "media_id_123",
      mediaMimeType: "image/jpeg",
    },
  });

  assert(!result.duplicate, "Should not be duplicate");
  assert(result.message !== undefined, "Should have created message");

  // Find the saved message in store
  const savedMsg = mockMessagesStore.find((m) => m.waMessageId === "wamid.img001");
  assert(savedMsg !== undefined, "Message should be in store");
  assert(savedMsg!.type === "IMAGE", `Type should be IMAGE, got ${savedMsg!.type}`);
  assert(savedMsg!.mediaId === "media_id_123", "Media ID should be preserved");
  assert(savedMsg!.mediaMimeType === "image/jpeg", "MIME type should be preserved");
  assert(savedMsg!.direction === "INBOUND", "Direction should be INBOUND");
});

await runTest("15. Missing account mapping (returns accountNotFound)", async () => {
  // No account in store for this phoneNumberId
  const result = await processIncomingWhatsAppMessage({
    phoneNumberId: "NONEXISTENT_PHONE",
    contactName: "Unknown Sender",
    message: {
      from: "15550000000",
      id: "wamid.noact001",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "TEXT",
      text: "Hello?",
    },
  });

  assert(result.accountNotFound === true, "Should return accountNotFound: true");
  assert(result.duplicate === false, "Should return duplicate: false");
});


// ── Additional Bonus Tests ──

console.log("\n── Bonus Tests ──\n");

await runTest("B1. STATUS_RANK map has correct ordering", async () => {
  assert(STATUS_RANK.RECEIVED < STATUS_RANK.SENT, "RECEIVED < SENT");
  assert(STATUS_RANK.SENT < STATUS_RANK.DELIVERED, "SENT < DELIVERED");
  assert(STATUS_RANK.DELIVERED < STATUS_RANK.READ, "DELIVERED < READ");
  assert(STATUS_RANK.READ < STATUS_RANK.FAILED, "READ < FAILED");
});

await runTest("B2. FAILED is terminal (cannot transition to DELIVERED)", async () => {
  const accountId = new Types.ObjectId();
  const msg: MockMessage = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    whatsappAccountId: accountId,
    waMessageId: "wamid.fail001",
    direction: "OUTBOUND",
    type: "TEXT",
    status: "FAILED",
    timestamp: new Date(),
    statusUpdatedAt: new Date(),
    errorMessage: "Message failed to deliver",
    save: async function () { return this; },
  };
  mockMessagesStore.push(msg);

  const result = await updateWhatsAppMessageStatus({
    whatsappAccountId: accountId.toString(),
    messageId: "wamid.fail001",
    status: "DELIVERED",
    timestamp: String(Math.floor(Date.now() / 1000) + 100),
  });

  assert(result!.status === "FAILED", "FAILED should remain terminal");
});

await runTest("B3. Rate limit error mapping (code 4)", async () => {
  const error = mapMetaApiError(429, { code: 4, message: "Application request limit reached" });
  assert(error.statusCode === 429, "Should map to 429");
  assert(error.message.includes("rate limit"), "Should mention rate limit");
});

await runTest("B4. Meta server error mapping (5xx)", async () => {
  const error = mapMetaApiError(500, { code: 1, message: "An unknown error occurred" });
  assert(error.statusCode === 502, "Should map to 502");
  assert(error.message.includes("temporarily unavailable"), "Should mention temporary failure");
});

await runTest("B5. Invalid node (code 100 with WABA context)", async () => {
  const error = mapMetaApiError(400, {
    code: 100,
    message: "Unsupported get request. Object with ID 'waba_xxx' of type business does not exist",
  });
  assert(error.statusCode === 400, "Should map to 400");
  assert(error.message.includes("Business Account"), "Should mention Business Account for WABA context");
});


// ──────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log("══════════════════════════════════════════════════════════════\n");

if (failed > 0) {
  process.exit(1);
} else {
  console.log("  ✅ All Phase 11A tests passed!\n");
  process.exit(0);
}

