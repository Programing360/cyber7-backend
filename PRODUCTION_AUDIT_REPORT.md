# VexChat / Cyber7 — Production Readiness Audit

**Audit date:** 2026-11-09  
**Repository:** `cyber7-backend` (VexChat multi-tenant WhatsApp SaaS)  
**Scope:** Meta Cloud API connectivity, webhooks, campaigns, multi-tenant isolation, security, and production operations  
**Auditor role:** Senior Full-Stack & Meta Cloud API Solutions Architect

---

## 0. How to Read This Report

| Badge | Meaning |
| :--- | :--- |
| **READY** | Implemented correctly and verifiable in code. Safe to ship. |
| **PARTIAL** | Partially implemented. Works for some paths, but has a material gap that will fail in production. |
| **MISSING** | Not implemented, disabled, dead code, or contradicted by documentation. |

**Severity scale**

| Severity | Meaning |
| :--- | :--- |
| **P0 / Blocker** | Data loss, security breach, compliance violation, or a core feature that does not work. Must fix before launch. |
| **P1 / High** | Production instability, abuse vector, or operational blind spot. Fix before scale / within 2 weeks. |
| **P2 / Medium** | Hardening and maintainability. Fix within the quarter. |
| **P3 / Low** | Polish / documentation. |

---

## 1. Executive Summary

The codebase contains a **solid WhatsApp Cloud API foundation**: official Graph API only, encrypted tenant tokens, HMAC-SHA256 webhook signature validation, timing-safe webhook verification, inbound message idempotency, workspace-scoped queries, and careful Meta error mapping.

However, **the product is not production-ready as a campaign platform or as a realtime calling product.** The single largest gap is that **campaign execution does not exist** — no BullMQ queue, no worker, no send call, no scheduler, and no campaign-level delivery tracking. The second largest gap is deployment topology: the app is configured for Vercel serverless, while Socket.IO calling, long-lived webhook processing, and background workers are not serverless-compatible. The third is security hygiene: JWT payloads and the `Authorization` header are logged on every request, the JWT is accepted from the query string, and there is no global rate limit or CSRF protection.

**Overall production readiness: ≈ 40 / 100. Do not launch campaigns or sell this as production-ready until P0 items in §6 are closed.**

### Scorecard

| # | Area | Score | Status | Launch verdict |
| :--- | :--- | :---: | :---: | :--- |
| 1 | Meta Cloud API & webhook health | **55 / 100** | **PARTIAL** | Inbound chat can work; compliance and reliability gaps remain |
| 2 | Campaign production-readiness | **20 / 100** | **MISSING** | Campaigns cannot be executed at all |
| 3 | Multi-tenant isolation & security | **60 / 100** | **PARTIAL** | Tenant scoping is good; secrets/log/auth hygiene is not |
| 4 | Production gap analysis | **25 / 100** | **MISSING** | No monitoring, backups, worker runtime, or working test command |

### Top 10 blockers

1. **P0 — Campaigns never send.** `dispatchCampaignRecipient` only rechecks opt-out; it never calls Meta. No BullMQ `Queue`/`Worker`; no scheduler is started in `server.ts` or `api/index.ts`.
2. **P0 — Campaign delivery tracking is absent.** Meta status webhooks update only `WhatsAppMessage`. `CampaignRecipient.providerMessageId` is never written, and `Campaign.sentCount/deliveredCount/readCount/failedCount` are never incremented by webhooks.
3. **P0 — 24-hour customer service window is not enforced.** The guard is commented out in both text and media send paths, contradicting `README.md §3.1`.
4. **P0 — Build is currently broken.** `npm run typecheck` fails at `src/modules/auth/auth.service.ts:213` (`'user' is possibly 'null'`) — the same line is a live login 500 bug.
5. **P0 — `npm test` is broken.** `package.json` references 15 test files that do not exist in `tests/`.
6. **P0 — Secrets/PII are logged.** `authenticate.ts` logs the raw `Authorization` header and JWT payload on every request; webhook controller logs signature metadata, headers, and body; calling services log full Meta responses.
7. **P0 — Deployment topology mismatch.** `api/index.ts` + `vercel.json` target serverless, but Socket.IO calls, the call-notification outbox, and future campaign workers require a long-lived process. `vercel.json` has no cron entry for `/api/internal/process-call-notifications`.
8. **P1 — Token/JWT leakage path.** `authenticate` accepts `?token=` from the query string, which leaks into access logs, browser history, and Referer headers.
9. **P1 — No global API rate limit and no CSRF protection.** Only login/register/admin endpoints are limited. Cookie auth is accepted, enabling CSRF on state-changing routes.
10. **P1 — Payment gateways are manual-only.** bKash/Nagad/card APIs are not integrated; there is no gateway callback/webhook route. Only City Bank manual transfer approval exists. `completePaymentAtomic` is dead code.

---

## 2. Criterion 1 — Meta Cloud API & Webhook Health

### 2.1 Official Cloud API only (no scrapers / QR cloning) — **READY**

**Evidence**

- `package.json` contains no `baileys`, `whatsapp-web.js`, `puppeteer`, `playwright`, `venom`, or `wppconnect`.
- All outbound traffic goes to `https://graph.facebook.com/...` (`whatsapp-api.service.ts`, `whatsapp-message.service.ts`, `whatsapp-calling-webhook.service.ts`).
- Connection flow verifies the Phone Number ID, WABA ID, phone-number↔WABA membership, and subscribes the WABA to the Meta app (`whatsapp.service.ts:49-125`).
- No QR-code or session-cloning code exists.

**Verdict:** Compliant with “official Cloud API only”. ✅

---

### 2.2 Secure token management — **PARTIAL**

**What is good**

- Tenant access tokens are encrypted with AES-256-GCM and stored in `accessTokenEncrypted` with `select: false` (`utils/encryption.ts`, `whatsapp.model.ts:61-65`).
- Encryption key is validated as a 32-byte Base64 key (`utils/encryption.ts:7-23`).
- Tokens are never returned by `sanitizeAccount` (`whatsapp.service.ts`).
- `makeWorkspaceWhatsAppRequest` prevents `access_token` and `appsecret_proof` from being passed as query parameters (`whatsapp-api.service.ts:190-196`).

**Gaps**

| Gap | Severity | Evidence |
| :--- | :--- | :--- |
| No token expiry / refresh lifecycle. Meta long-lived tokens expire; there is no `tokenExpiresAt`, refresh job, or “reconnect required” alert. | **P1** | `whatsapp.model.ts` has no expiry field; Meta error 190 is surfaced only at send time. |
| No `appsecret_proof` on Graph API calls. Meta recommends it for server-to-server calls so a stolen token cannot be used without the app secret. | **P2** | Only `appsecret_proof` *blocking* exists in `whatsapp-api.service.ts:193`; it is never added. |
| Calling uses a **platform system-user token fallback** instead of the tenant token. This can cross tenant boundaries and hides which tenant made the call. | **P1** | `whatsapp-calling-webhook.service.ts:175-179, 229-233, 283-287`. |
| `META_SYSTEM_USER_ACCESS_TOKEN` is read directly from `process.env`, not validated at boot. | **P2** | `whatsapp.config.ts:77-82`. |
| Key rotation is undocumented and unsupported (single `WHATSAPP_ENCRYPTION_KEY`; no key-id/version envelope). | **P2** | `utils/encryption.ts`. |

**Exact fix — add token metadata**

```ts
// src/modules/whatsapp/whatsapp.model.ts
export interface IWhatsAppAccount extends Document {
  // ...
  accessTokenEncrypted: string;
  accessTokenExpiresAt?: Date;   // NEW
  tokenLastVerifiedAt?: Date;    // NEW
  tokenStatus?: "VALID" | "EXPIRED" | "INVALID"; // NEW
}

// schema
accessTokenExpiresAt: { type: Date },
tokenLastVerifiedAt: { type: Date },
tokenStatus: {
  type: String,
  enum: ["VALID", "EXPIRED", "INVALID"],
  default: "VALID",
},
```

**Exact fix — add `appsecret_proof`**

```ts
// src/modules/services/whatsapp-api.service.ts
import { createHmac } from "node:crypto";

function buildAppSecretProof(accessToken: string): string | undefined {
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appSecret) return undefined;
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

// where the Graph URL is built:
const proof = buildAppSecretProof(accessToken);
if (proof) url.searchParams.set("appsecret_proof", proof);
```

> Note: `appsecret_proof` is explicitly rejected by the current query-param allowlist at `whatsapp-api.service.ts:193`. Remove that rejection and set it after validation, never from user input.

**Exact fix — use tenant token for calling**

```ts
// src/services/whatsapp-calling-webhook.service.ts
import WhatsAppAccount from "../modules/whatsapp/whatsapp.model.js";
import { decrypt } from "../utils/encryption.js";

async function resolveTenantToken(phoneNumberId: string): Promise<string> {
  const account = await WhatsAppAccount.findOne({
    phoneNumberId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (!account?.accessTokenEncrypted) {
    throw new Error("No connected WhatsApp account for calling");
  }
  return decrypt(account.accessTokenEncrypted);
}

// In acceptMetaCallWithSdp / terminateMetaCall / initiateMetaOutgoingCall:
const token = accessToken || (await resolveTenantToken(phoneNumberId));
```

---

### 2.3 Webhook GET verification — **READY**

**Evidence**

- `verifyWhatsAppWebhook` checks `hub.mode === "subscribe"`, compares `hub.verify_token` with `META_WEBHOOK_VERIFY_TOKEN` using `timingSafeEqual`, and echoes `hub.challenge` (`whatsapp-webhook.controller.ts:193-237`).
- Fails with `403` when the token is missing or wrong.
- Callback URL resolution refuses localhost/HTTP (`whatsapp.config.ts:13-54`).

**Minor hardening (P2):** log the verification IP but never the token; currently `recordWebhookVerificationSuccess` logs only `{ ip }`, which is fine.

---

### 2.4 Webhook `X-Hub-Signature-256` validation — **READY**

**Evidence**

- Raw request bytes are preserved in `app.ts:119-127`.
- `verifyWhatsAppWebhookSignature` requires `META_APP_SECRET`, a non-empty raw body, and a `sha256=` signature, then compares with `timingSafeEqual` (`whatsapp-webhook.service.ts:1-41`).
- Controller returns `401 INVALID_META_SIGNATURE` on failure (`whatsapp-webhook.controller.ts:289-300`).
- Fails closed if the secret or raw body is missing.

**Verdict:** Cryptographically correct. ✅

**Gap:** The controller logs signature diagnostics and the signature header itself (`whatsapp-webhook.controller.ts:278-287, 302-304`). Remove these in production.

---

### 2.5 Idempotency and retries — **PARTIAL**

**What is good**

- Inbound messages are deduplicated by unique partial index `{ whatsappAccountId, waMessageId }` and by code `11000` handling (`message.model.ts:166-175`, `whatsapp-message.service.ts:119-130, 260-277`).
- Status updates are monotonic and terminal-`FAILED`-safe (`whatsapp-message.service.ts:291-351`).
- The controller returns `500` on unexpected errors so Meta retries (`whatsapp-webhook.controller.ts:474-485`), matching `README.md §3.5`.

**Gaps**

| Gap | Severity | Evidence |
| :--- | :--- | :--- |
| No event-level idempotency. Meta can deliver the same status event more than once; status updates are idempotent-ish, but calling events and future campaign events are not. | **P1** | `whatsapp-calling-webhook.service.ts` dedupes only some call notifications; no generic event store. |
| A single bad message/status throws and causes the **entire batch** to be retried, including already-processed events. This amplifies work and can cause repeated side effects. | **P1** | `whatsapp-webhook.controller.ts:419-428, 460-467`. |
| Webhook processing is synchronous. Slow Meta or DB calls can exceed the platform timeout and trigger retries. | **P1** | `receiveWhatsAppWebhook` awaits full processing before `200`. |
| No dead-letter queue or failed-event replay. | **P2** | No queue/event collection exists. |

**Recommended architecture:** verify signature → persist raw event into `WebhookEvent` collection with a deterministic key → return `200` immediately → process asynchronously via BullMQ. This is the only reliable way to survive Meta retry storms and serverless timeouts.

**Exact fix — event-level idempotency + per-event isolation (minimal version)**

```ts
// src/modules/whatsapp/webhook-event.model.ts
import mongoose, { Schema, Model } from "mongoose";

interface IWebhookEvent extends mongoose.Document {
  eventKey: string;
  provider: "META";
  field: string;
  phoneNumberId?: string;
  payload: unknown;
  status: "RECEIVED" | "PROCESSED" | "FAILED";
  attempts: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IWebhookEvent>(
  {
    eventKey: { type: String, required: true, unique: true },
    provider: { type: String, enum: ["META"], default: "META" },
    field: { type: String, required: true },
    phoneNumberId: { type: String, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["RECEIVED", "PROCESSED", "FAILED"],
      default: "RECEIVED",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
  },
  { timestamps: true },
);

export default (mongoose.models.WebhookEvent as Model<IWebhookEvent>) ||
  mongoose.model<IWebhookEvent>("WebhookEvent", schema);
```

```ts
// inside receiveWhatsAppWebhook, after signature validation:
const eventKey = `${change.field}:${phoneNumberId}:${
  value.messages?.[0]?.id ?? value.statuses?.[0]?.id ?? crypto.randomUUID()
}`;

const inserted = await WebhookEvent.updateOne(
  { eventKey },
  { $setOnInsert: { eventKey, field: change.field, phoneNumberId, payload: value } },
  { upsert: true },
);

if (inserted.upsertedCount === 0) {
  // already received; do not process twice
  continue;
}

try {
  await processWebhookValue(value, change.field);
  await WebhookEvent.updateOne({ eventKey }, { $set: { status: "PROCESSED" } });
} catch (err) {
  await WebhookEvent.updateOne(
    { eventKey },
    {
      $set: { status: "FAILED", lastError: (err as Error).message },
      $inc: { attempts: 1 },
    },
  );
  // Keep the webhook 200 so Meta does not replay the whole batch.
  // Replay failed events from a worker/cron instead.
}
```

---

### 2.6 Outbound status tracking — **PARTIAL**

**What is good**

- `updateWhatsAppMessageStatus` updates `WhatsAppMessage` with precedence rules (`whatsapp-message.service.ts:291-351`).

**Gap:** Status webhooks do **not** update campaign recipients or counters. This is a P0 for campaign analytics.

**Exact fix — propagate status to campaigns**

```ts
// src/modules/services/whatsapp-message.service.ts
import CampaignRecipient from "../campaign/campaign-recipient.model.js";
import Campaign from "../campaign/campaign.model.js";

const CAMPAIGN_STATUS_FIELD: Record<string, string> = {
  SENT: "sentCount",
  DELIVERED: "deliveredCount",
  READ: "readCount",
  FAILED: "failedCount",
};

async function syncCampaignRecipientStatus(
  messageId: string,
  status: WhatsAppMessageStatus,
  occurredAt: Date,
  errorMessage?: string,
) {
  const recipient = await CampaignRecipient.findOne({
    providerMessageId: messageId,
  });
  if (!recipient) return;

  const rank: Record<string, number> = {
    PENDING: 0, PROCESSING: 1, SENT: 2, DELIVERED: 3, READ: 4,
  };

  // FAILED is terminal; never downgrade a READ/DELIVERED to SENT.
  if (recipient.status === "FAILED") return;
  if (status !== "FAILED" && (rank[status] ?? 0) <= (rank[recipient.status] ?? 0)) {
    return;
  }

  const previous = recipient.status;
  recipient.status = status as any;

  if (status === "SENT") recipient.sentAt = occurredAt;
  if (status === "DELIVERED") recipient.deliveredAt = occurredAt;
  if (status === "READ") recipient.readAt = occurredAt;
  if (status === "FAILED") {
    recipient.failedAt = occurredAt;
    recipient.errorMessage = errorMessage;
  }

  await recipient.save();

  if (previous !== status) {
    const field = CAMPAIGN_STATUS_FIELD[status];
    if (field) {
      await Campaign.updateOne(
        { _id: recipient.campaignId, workspaceId: recipient.workspaceId },
        { $inc: { [field]: 1 } },
      );
    }
  }
}
```

Call it from `updateWhatsAppMessageStatus` after `message.save()`:

```ts
await syncCampaignRecipientStatus(
  messageId,
  status,
  incomingTimestamp,
  errorMessage,
);
```

---

### 2.7 24-hour customer service window — **MISSING (claims READY)**

**Evidence**

- The enforcement block is commented out in the text send path (`whatsapp-message.service.ts:398-405`).
- The same block is commented out in the media send path (`whatsapp-message.service.ts:982-986`).
- `README.md §3.1` explicitly claims strict backend enforcement and a `422 CUSTOMER_SERVICE_WINDOW_EXPIRED` response.
- The helper `isCustomerServiceWindowOpen` exists and is correct (`conversation.model.ts:82-99`).
- The inbound handler writes `isCustomerServiceWindowActive` and `customerServiceWindowExpiresAt` (`whatsapp-message.service.ts:211-217`), but those fields **do not exist in the conversation schema**, so Mongoose strict mode silently drops them. `lastCustomerMessageAt` does exist and is the reliable source of truth.

**Impact:** Agents can send free-form text outside 24 hours. Meta will reject it with error `131047`, which is mapped to a clean 422, but the backend is not enforcing policy locally and the README is inaccurate.

**Exact fix — enforce in both send paths**

```ts
// src/modules/services/whatsapp-message.service.ts — text path (~line 398)
import {
  isCustomerServiceWindowOpen,
  CUSTOMER_SERVICE_WINDOW_MS,
} from "../whatsapp/conversation.model.js";

if (!isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt)) {
  throw new AppError(
    "The 24-hour customer service window has expired. You can only send approved template messages outside this window.",
    422,
    "CUSTOMER_SERVICE_WINDOW_EXPIRED",
  );
}
```

Apply the identical block in `sendWhatsAppMediaMessage` (~line 982). **Do not apply it to template sends** — templates are allowed outside the window.

**Exact fix — make schema and writes consistent**

```ts
// src/modules/whatsapp/conversation.model.ts
export interface IWhatsAppConversation extends Document {
  // ...
  lastCustomerMessageAt?: Date;
  customerServiceWindowExpiresAt?: Date;   // NEW (audit/UI convenience)
  isCustomerServiceWindowActive?: boolean; // NEW
}

// schema
customerServiceWindowExpiresAt: { type: Date },
isCustomerServiceWindowActive: { type: Boolean, default: false },
```

> Alternative: delete the two unknown `$set` fields from `whatsapp-message.service.ts:215-216` and compute them in the serializer (already done in `whatsapp-chat.service.ts:391, 443, 636`). Either is acceptable; leaving silent drops is not.

**Additional fix:** the inbound handler sets `isCustomerServiceWindowActive: true` even for STOP keywords (`whatsapp-message.service.ts:194, 215`). Set it to `!isStopKeyword` to avoid reopening a window on an opt-out message.

---

### 2.8 Graph API version consistency — **MISSING**

**Evidence**

- Config default is `v26.0` (`whatsapp.config.ts:65-67`, `.env.example:15`).
- Calling, media proxy, and outgoing call controller hardcode `v21.0`:
  - `whatsapp-calling-webhook.service.ts:190, 252, 298`
  - `whatsapp-message.service.ts:882, 1039`
  - `call.controller.ts:297, 484`

**Impact:** Calling may break when Meta retires v21.0; behavior diverges between messaging and calling.

**Exact fix**

```ts
// src/services/whatsapp-calling-webhook.service.ts
import { whatsappConfig } from "../modules/config/whatsapp.config.js";

const url = `${whatsappConfig.graphApiBaseUrl}/${phoneNumberId}/calls`;
```

Apply the same replacement in `whatsapp-message.service.ts` and `call.controller.ts`. Then add a CI grep guard:

```bash
# package.json
"check:graph-version": "! grep -R \"graph.facebook.com/v[0-9]\" src --include=*.ts"
```

---

### 2.9 Meta connectivity checklist

| Item | Status | Notes |
| :--- | :---: | :--- |
| Official Cloud API only | **READY** | No unofficial libraries |
| Phone/WABA ownership verification on connect | **READY** | `whatsapp.service.ts:49-82` |
| WABA subscribed to app | **READY** | `whatsapp.service.ts:100-125` |
| GET verify token (timing-safe) | **READY** | `whatsapp-webhook.controller.ts:207-237` |
| POST HMAC signature over raw body | **READY** | `whatsapp-webhook.service.ts` |
| Inbound message idempotency | **READY** | Unique partial index |
| Event-level idempotency | **MISSING** | Add `WebhookEvent` + queue |
| Retry-safe batch isolation | **PARTIAL** | One failure retries whole batch |
| Tenant token encryption | **READY** | AES-256-GCM, `select:false` |
| Token expiry / refresh / reconnect | **MISSING** | Add expiry + job |
| `appsecret_proof` | **MISSING** | Add to Graph calls |
| 24h window enforcement | **MISSING** | Commented out |
| Graph version consistency | **MISSING** | Hardcoded v21.0 in calling/media |
| Webhook log hygiene | **MISSING** | Signature + body logged |
| Calling uses tenant token | **PARTIAL** | Falls back to system token |

---

## 3. Criterion 2 — Campaign Production-Readiness

### 3.1 Background queue / worker — **MISSING**

**Evidence**

- `bullmq` and `ioredis` are declared in `package.json`, but **no `Queue`, `Worker`, `QueueEvents`, or BullMQ import exists anywhere in `src/`**.
- `CAMPAIGN_EXECUTION_ENABLED`, `CAMPAIGN_SCHEDULER_INTERVAL_MS`, `CAMPAIGN_SEND_CONCURRENCY`, `CAMPAIGN_DISPATCH_CONCURRENCY`, `CAMPAIGN_MAX_ATTEMPTS`, `CAMPAIGN_RETRY_DELAY_MS`, `CAMPAIGN_LEASE_DURATION_MS`, `CAMPAIGN_HEARTBEAT_INTERVAL_MS`, and `CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS` are parsed in `env.ts` but **unused**.
- `dispatchCampaignRecipient` (`campaign.service.ts:831-905`) only checks opt-out and returns `{ success: true }`. It never calls `makeWorkspaceWhatsAppRequest` and never sends a template.
- `server.ts` starts only Express; `api/index.ts` starts only the serverless handler. No scheduler or worker is started.
- `vercel.json` contains no cron configuration.

**Impact:** Scheduled campaigns are created, stored, and never sent. “Run now” does not send either. This is the #1 product blocker.

**Exact fix — queue definition**

```ts
// src/modules/campaign/campaign.queue.ts
import { Queue } from "bullmq";
import { createRedisConnection } from "../../config/redis.js";

export const CAMPAIGN_QUEUE_NAME = "campaign-dispatch";

export interface CampaignDispatchJob {
  workspaceId: string;
  campaignId: string;
  recipientId: string;
}

export const campaignQueue = new Queue<CampaignDispatchJob>(
  CAMPAIGN_QUEUE_NAME,
  {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  },
);
```

> `src/config/redis.ts` currently exports a client singleton. Add a factory that returns a **new** `ioredis` connection (BullMQ requires dedicated blocking connections; do not reuse the shared client for workers).

**Exact fix — worker that actually sends**

```ts
// src/modules/campaign/campaign.worker.ts
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../../config/redis.js";
import {
  CAMPAIGN_QUEUE_NAME,
  type CampaignDispatchJob,
} from "./campaign.queue.js";
import { dispatchCampaignRecipient } from "./campaign.service.js";

export function startCampaignWorker() {
  const worker = new Worker<CampaignDispatchJob>(
    CAMPAIGN_QUEUE_NAME,
    async (job: Job<CampaignDispatchJob>) => {
      const { workspaceId, campaignId, recipientId } = job.data;
      return dispatchCampaignRecipient({ workspaceId, campaignId, recipientId });
    },
    {
      connection: createRedisConnection(),
      concurrency: Number(process.env.CAMPAIGN_SEND_CONCURRENCY || 5),
      limiter: {
        // Per-worker rate limit. For per-tenant limits use a Redis token bucket keyed by workspaceId.
        max: 20,
        duration: 1_000,
      },
    },
  );

  worker.on("failed", (job, err) => {
    // replace with structured logger
    console.error("[CampaignWorker] Job failed", {
      jobId: job?.id,
      campaignId: job?.data.campaignId,
      recipientId: job?.data.recipientId,
      error: err.message,
    });
  });

  return worker;
}
```

**Exact fix — replace the stub with a real send**

```ts
// src/modules/campaign/campaign.service.ts
import WhatsAppTemplate from "../whatsapp/template.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import { makeWorkspaceWhatsAppRequest } from "../services/whatsapp-api.service.js";

export async function dispatchCampaignRecipient({
  workspaceId,
  campaignId,
  recipientId,
}: DispatchCampaignRecipientParams) {
  const workspaceObjectId = requireObjectId(workspaceId, "A valid workspace ID is required");
  const campaignObjectId = requireObjectId(campaignId, "A valid campaign ID is required");
  const recipientObjectId = requireObjectId(recipientId, "A valid recipient ID is required");

  const campaign = await Campaign.findOne({
    _id: campaignObjectId,
    workspaceId: workspaceObjectId,
  });
  if (!campaign) throw new AppError("Campaign not found", 404);

  // Idempotency: only PENDING/FAILED-retryable recipients may be claimed.
  const recipient = await CampaignRecipient.findOneAndUpdate(
    {
      _id: recipientObjectId,
      workspaceId: workspaceObjectId,
      campaignId: campaignObjectId,
      status: { $in: ["PENDING", "FAILED"] },
      $or: [
        { errorCode: { $exists: false } },
        { errorCode: { $ne: "CONTACT_OPTED_OUT" } },
      ],
    },
    { $set: { status: "PROCESSING" } },
    { returnDocument: "after" },
  );

  if (!recipient) {
    return { success: false, skipped: true, reason: "ALREADY_PROCESSED" };
  }

  const contact = await WhatsAppContact.findOne({
    _id: recipient.contactId,
    workspaceId: workspaceObjectId,
  });

  if (!contact || contact.isOptedOut) {
    recipient.status = "FAILED";
    recipient.errorCode = "CONTACT_OPTED_OUT";
    recipient.errorMessage = "Contact has opted out of WhatsApp communications";
    recipient.failedAt = new Date();
    await recipient.save();
    await Campaign.updateOne(
      { _id: campaignObjectId, workspaceId: workspaceObjectId },
      { $inc: { failedCount: 1 } },
    );
    return { success: false, skipped: true, reason: "CONTACT_OPTED_OUT" };
  }

  // Resolve the approved template bound to this campaign/account.
  const account = await WhatsAppAccount.findOne({
    _id: campaign.whatsappAccountId,
    workspaceId: workspaceObjectId,
    status: "CONNECTED",
  });
  if (!account) throw new AppError("No connected WhatsApp account", 400);

  const template = await WhatsAppTemplate.findOne({
    _id: campaign.templateId,
    workspaceId: workspaceObjectId,
    whatsappAccountId: campaign.whatsappAccountId,
    status: "APPROVED",
  });
  if (!template) {
    recipient.status = "FAILED";
    recipient.errorCode = "TEMPLATE_NOT_APPROVED";
    recipient.errorMessage = "Approved template not found for campaign";
    recipient.failedAt = new Date();
    await recipient.save();
    throw new AppError("Approved template not found", 422, "TEMPLATE_NOT_APPROVED");
  }

  // Campaign must store its template component values. Add to campaign.model.ts:
  //   templateComponents?: Array<{
  //     type: "header" | "body" | "button";
  //     parameters: Array<{ type: "text"; text: string }>;
  //   }>;
  // Without this, templates containing {{1}}, {{2}} will fail at send time.
  const components = campaign.templateComponents ?? [];

  const recipientPhone = (recipient.phoneNumber || contact.waId || "").replace(/\D/g, "");
  if (recipientPhone.length < 5) {
    recipient.status = "FAILED";
    recipient.errorCode = "INVALID_RECIPIENT_PHONE";
    recipient.failedAt = new Date();
    await recipient.save();
    throw new AppError("Invalid recipient phone number", 400);
  }

  const response = await makeWorkspaceWhatsAppRequest(
    workspaceId,
    account.phoneNumberId,
    "messages",
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components,
      },
    },
  );

  const providerMessageId = (response.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
  if (!providerMessageId) {
    throw new AppError("WhatsApp API did not return a message ID", 502);
  }

  recipient.status = "SENT";
  recipient.providerMessageId = providerMessageId;
  recipient.sentAt = new Date();
  recipient.errorCode = undefined;
  recipient.errorMessage = undefined;
  await recipient.save();

  await Campaign.updateOne(
    { _id: campaignObjectId, workspaceId: workspaceObjectId },
    { $inc: { sentCount: 1 } },
  );

  return { success: true, recipient: serializeCampaignRecipient(recipient) };
}
```

> If the campaign targets a conversation, prefer `sendWhatsAppTemplateMessage` so the outbound `WhatsAppMessage` row is created. Either way, **persist `providerMessageId`** so status webhooks can find the recipient.

**Exact fix — scheduler (outbox pattern, no in-memory cron)**

```ts
// src/modules/campaign/campaign.scheduler.ts
import Campaign from "./campaign.model.js";
import CampaignRecipient from "./campaign-recipient.model.js";
import { campaignQueue } from "./campaign.queue.js";

export async function enqueueDueCampaigns(now = new Date()) {
  if (process.env.CAMPAIGN_EXECUTION_ENABLED !== "true") return { enqueued: 0 };

  // Atomically claim due campaigns so two schedulers never double-send.
  const due = await Campaign.find({
    status: "SCHEDULED",
    scheduledAt: { $lte: now },
  })
    .select("_id workspaceId")
    .limit(50)
    .lean();

  let enqueued = 0;
  for (const campaign of due) {
    const claimed = await Campaign.findOneAndUpdate(
      { _id: campaign._id, status: "SCHEDULED" },
      { $set: { status: "PROCESSING", startedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;

    const recipients = await CampaignRecipient.find({
      campaignId: campaign._id,
      workspaceId: campaign.workspaceId,
      status: "PENDING",
    })
      .select("_id")
      .lean();

    await campaignQueue.addBulk(
      recipients.map((r) => ({
        name: "dispatch",
        data: {
          workspaceId: String(campaign.workspaceId),
          campaignId: String(campaign._id),
          recipientId: String(r._id),
        },
        opts: { jobId: `${campaign._id}:${r._id}` }, // idempotent job id
      })),
    );
    enqueued += recipients.length;
  }
  return { enqueued };
}
```

Expose it through the existing cron endpoint pattern (do **not** run `setInterval` in serverless):

```ts
// src/modules/Calling/calling.routes.ts (or a dedicated cron router)
internalCronRouter.post("/internal/process-campaigns", async (req, res) => {
  // reuse the same CRON_SECRET constant-time check
  const result = await enqueueDueCampaigns();
  res.json({ ok: true, ...result });
});
```

```json
// vercel.json (only if staying on Vercel)
{
  "crons": [
    { "path": "/api/internal/process-campaigns", "schedule": "* * * * *" },
    { "path": "/api/internal/process-call-notifications", "schedule": "* * * * *" }
  ]
}
```

> Vercel Cron sends a `GET`, while the current internal cron route is `POST`. Either change the route to accept `GET` or use an external scheduler that sends `POST` with `Authorization: Bearer $CRON_SECRET`. On a long-lived host, run the scheduler in the worker process.

**Exact fix — start the worker outside serverless**

```ts
// src/worker.ts — new entrypoint for Render/Fly/Railway/ECS
import "dotenv/config";
import connectDatabase from "./config/database.js";
import { startCampaignWorker } from "./modules/campaign/campaign.worker.js";
import { enqueueDueCampaigns } from "./modules/campaign/campaign.scheduler.js";

await connectDatabase();
const worker = startCampaignWorker();
const timer = setInterval(() => void enqueueDueCampaigns(), 15_000);

const shutdown = async () => {
  clearInterval(timer);
  await worker.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

```json
// package.json
"worker": "tsx src/worker.ts",
"worker:prod": "node dist/worker.js"
```

---

### 3.2 Rate limiting for campaign sends — **MISSING**

**Gap:** No rate limit exists at the campaign or tenant level. Meta applies per-phone-number messaging limits and returns `429`/`131048`/`130429`. Without a limiter, a large campaign will produce a burst of failures and may degrade the phone number’s quality rating.

**Exact fix — per-tenant token bucket in Redis**

```ts
// src/modules/campaign/campaign-rate-limiter.ts
import { createRedisConnection } from "../../config/redis.js";

const redis = createRedisConnection();

/**
 * Sliding-window limiter. Returns true if the send is allowed.
 * Tune `maxPerSecond` to the WABA's messaging limit tier.
 */
export async function allowCampaignSend(
  workspaceId: string,
  maxPerSecond = 20,
): Promise<boolean> {
  const key = `campaign:rate:${workspaceId}:${Math.floor(Date.now() / 1000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2);
  return count <= maxPerSecond;
}
```

Call at the start of `dispatchCampaignRecipient`; if not allowed, throw a retryable error so BullMQ backs off:

```ts
if (!(await allowCampaignSend(workspaceId, Number(process.env.CAMPAIGN_SEND_CONCURRENCY) * 4))) {
  throw new Error("CAMPAIGN_RATE_LIMITED");
}
```

Also respect Meta’s `Retry-After` and error codes (`4`, `17`, `32`, `613`, `80004`, `80007`) which are already mapped in `whatsapp-api.service.ts:283-299`.

---

### 3.3 Approved templates only — **READY**

**Evidence**

- Template send rejects non-`APPROVED` templates with `422 TEMPLATE_NOT_APPROVED` (`whatsapp-message.service.ts:604-610`).
- Templates are scoped to workspace **and** WhatsApp account (`whatsapp-message.service.ts:594-598`).
- Header/body/button parameters are validated before send (`whatsapp-message.service.ts:612-727`).
- Templates are synced from Meta and marked `DELETED` when missing (`template.service.ts:258-420`).

**Gap:** The campaign stub does not resolve or validate a template at all. Once §3.1 is implemented, keep the approved-only check and persist `providerMessageId`.

---

### 3.4 Opt-out / consent filtering — **READY (with one caveat)**

**Evidence**

- Inbound STOP/UNSUBSCRIBE/CANCEL/OPTOUT/QUIT sets `isOptedOut` + audit fields (`whatsapp-message.service.ts:141-171`).
- START/UNSTOP records opt-in audit but intentionally does not clear opt-out (`whatsapp-message.service.ts:166-171`), matching `README.md §3.3`.
- Audience resolution excludes opted-out contacts (`campaign-audience.service.ts`).
- Real-time pre-dispatch guard exists (`campaign.service.ts:859-899`).
- Text and template sends block opted-out contacts (`whatsapp-message.service.ts:390-396, 574-580`).

**Caveat:** The current guard runs **before** a send that does not happen. After implementing §3.1, keep the guard immediately before the Meta call inside the worker, not only at audience compile time.

**Recommended (P2):** store an immutable consent ledger (`ConsentEvent` collection) with source, timestamp, IP, and message ID for auditability.

---

### 3.5 Real-time delivery / read / failure tracking — **MISSING**

**Evidence**

- `WhatsAppMessage` status updates work.
- `CampaignRecipient` has `providerMessageId`, `sentAt`, `deliveredAt`, `readAt`, `failedAt`, and indexes (`campaign-recipient.model.ts:69-112`), but **no code writes `providerMessageId`** and **no webhook path updates these fields**.
- `Campaign.sentCount/deliveredCount/readCount/failedCount` are only incremented for opt-out failures (`campaign.service.ts:874-878`).

**Fix:** implement §3.1 (persist `providerMessageId`) and §2.6 (propagate status). Add a per-campaign realtime event if the UI needs live updates:

```ts
// after syncCampaignRecipientStatus succeeds
const io = getCallSocketIO();
io?.to(`workspace_${recipient.workspaceId}`).emit("campaign:recipient:status", {
  campaignId: String(recipient.campaignId),
  recipientId: String(recipient._id),
  status: recipient.status,
  occurredAt: occurredAt.toISOString(),
});
```

Add the event to `ServerToClientEvents` in `src/sockets/callSocket.ts`.

---

### 3.6 Campaign scheduling correctness — **PARTIAL**

**What exists**

- Campaign CRUD, schedule/pause/resume/cancel routes (`campaign.routes.ts`).
- Status validation and audience compilation.

**Gaps**

- No scheduler claims due campaigns. `scheduledAt` is stored but never acted on.
- No lease/heartbeat, despite env vars for both. Two app instances could double-send if a naive scheduler is added.
- No campaign completion transition (`PROCESSING → COMPLETED`) after all recipients finish.
- No retry policy per recipient; only the opt-out guard.

**Minimum acceptable state:** the `enqueueDueCampaigns` + `jobId` + atomic `SCHEDULED → PROCESSING` claim in §3.1. Add a completion check:

```ts
// after a recipient finishes
const remaining = await CampaignRecipient.countDocuments({
  campaignId: recipient.campaignId,
  status: { $in: ["PENDING", "PROCESSING"] },
});
if (remaining === 0) {
  await Campaign.updateOne(
    { _id: recipient.campaignId, status: "PROCESSING" },
    { $set: { status: "COMPLETED", completedAt: new Date() } },
  );
}
```

### 3.7 Campaign readiness checklist

| Item | Status | Notes |
| :--- | :---: | :--- |
| BullMQ queue | **MISSING** | Dependencies installed, never used |
| Worker process | **MISSING** | No worker entrypoint or start call |
| Scheduler / cron | **MISSING** | No claim loop, no cron config |
| Actual Meta send | **MISSING** | `dispatchCampaignRecipient` is a guard only |
| Approved-template enforcement | **READY** | In chat send path |
| Opt-out exclusion | **READY** | Audience + pre-dispatch + send paths |
| Consent ledger | **PARTIAL** | Contact fields only; no immutable ledger |
| Persist `providerMessageId` | **MISSING** | Field exists, never written |
| Delivery/read/failure propagation | **MISSING** | Webhooks update messages only |
| Campaign counters | **MISSING** | Only opt-out failures increment |
| Per-tenant rate limit | **MISSING** | No limiter |
| Retry / backoff | **MISSING** | Env vars unused |
| Lease / heartbeat / double-send guard | **MISSING** | Env vars unused |
| Pause / resume honored mid-run | **MISSING** | No worker checks campaign status |

---

## 4. Criterion 3 — Multi-Tenant Isolation & Security

### 4.1 Tenant isolation model — **PARTIAL (application-level only)**

**What is good**

- `requireWorkspaceMembership` validates an active membership for `req.params.workspaceId` on every protected route (`require-workspace-membership.ts:15-63`).
- `requireRole` enforces OWNER/ADMIN/AGENT per route.
- Most services scope queries by `workspaceId` (WhatsApp chat, templates, campaigns, billing, dashboard, calling).
- Unique indexes are tenant-aware (e.g. conversation `{workspaceId, whatsappAccountId, contactId}`, membership `{workspaceId, userId}`).

**Gaps**

| Gap | Severity | Evidence |
| :--- | :--- | :--- |
| No DB-level tenant enforcement. MongoDB has no RLS; a missed `workspaceId` in any future query is a cross-tenant leak. | **P1** | All isolation is hand-written `where` clauses. |
| Admin/platform queries intentionally bypass tenant scope. That is correct, but there is no shared “tenant context” primitive to make the bypass explicit and auditable. | **P2** | `platform-admin-dashboard`, `support-ticket.service.ts`. |
| Some direct `findById` calls rely on a prior scoped lookup. They are currently safe but fragile. | **P2** | `billing.service.ts:285, 454, 668, 721, 834`; `governance.service.ts`. |
| No automated test that attempts cross-tenant access on every route. | **P1** | No such test file exists. |

**Exact fix — add a repository guard helper**

```ts
// src/utils/tenant-query.ts
import { Types } from "mongoose";
import { AppError } from "./app-error.js";

export function tenantFilter(workspaceId: string, filter: Record<string, unknown> = {}) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }
  return { ...filter, workspaceId: new Types.ObjectId(workspaceId) };
}

export function assertTenantMatch(
  documentWorkspaceId: Types.ObjectId | string | undefined,
  workspaceId: string,
): void {
  if (String(documentWorkspaceId) !== String(workspaceId)) {
    // Return 404, not 403, to avoid confirming existence of other tenants' data.
    throw new AppError("Resource not found", 404);
  }
}
```

**Exact fix — cross-tenant regression test**

```ts
// tests/tenant-isolation.test.ts
// For every workspace-scoped route:
// 1. Create workspace A and B, user in A only.
// 2. Create a resource in B.
// 3. Call the A route with B's resource ID.
// 4. Assert 403 or 404, never 200.
```

Run this in CI. This is the only durable defense against regressions.

**Atlas hardening (recommended):** use a dedicated DB user for the app with `readWrite` on the app database only; use separate users for backups and analytics. Do not ship a cluster-wide admin URI.

---

### 4.2 Secrets encryption & handling — **PARTIAL**

**What is good**

- AES-256-GCM with random IV and auth tag (`utils/encryption.ts:25-70`).
- Tenant tokens are `select: false`.
- Admin MFA secrets and BFF assertions have separate keys with production validation (`env.ts:315-530`).
- Admin audit service redacts sensitive keys (`admin-security-audit.service.ts:82`).

**Gaps**

| Gap | Severity | Evidence |
| :--- | :--- | :--- |
| `WHATSAPP_ENCRYPTION_KEY` is not validated at boot. A missing key fails only when a token is encrypted/decrypted. | **P1** | `env.ts` has no core schema; `encryption.ts:8-11` throws lazily. |
| No key version / rotation envelope. Rotating the key makes every stored token undecryptable. | **P2** | Single key, no `keyId`. |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `MONGODB_URI`, `JWT_ACCESS_SECRET` are read lazily. | **P1** | `server.ts:11` validates only campaign env; `api/index.ts:11`. |
| `.env.example` omits `SENTRY_DSN`, `CRON_SECRET`, `NAGAD_*`, and other production controls. | **P2** | `.env.example`. |

**Exact fix — boot-time core validation**

```ts
// src/config/env.ts
export const coreEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    MONGODB_URI: z.string().trim().min(1, "MONGODB_URI is required"),
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
    META_APP_ID: z.string().trim().min(1),
    META_APP_SECRET: z.string().trim().min(1),
    META_WEBHOOK_VERIFY_TOKEN: z.string().trim().min(16),
    WHATSAPP_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "WHATSAPP_ENCRYPTION_KEY must be a 32-byte Base64 key",
      }),
    REDIS_URL: z.string().url(),
  })
  .superRefine((data, ctx) => {
    const keys = [
      data.JWT_ACCESS_SECRET,
      data.META_APP_SECRET,
      data.WHATSAPP_ENCRYPTION_KEY,
    ];
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        message: "Secrets must be distinct from one another",
      });
    }
  });

export function loadCoreEnv(source = process.env) {
  const result = coreEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentConfigurationError(toEnvironmentIssues(result.error.issues));
  }
  return result.data;
}
```

Call it first in both entrypoints:

```ts
// src/server.ts and api/index.ts
import { loadCoreEnv, loadCampaignEnv } from "./config/env.js";
loadCoreEnv();
loadCampaignEnv();
```

**Exact fix — key rotation envelope (P2)**

Store `v1.<iv>.<tag>.<ciphertext>` and keep a key map:

```ts
const KEYS: Record<string, Buffer> = {
  v1: Buffer.from(process.env.WHATSAPP_ENCRYPTION_KEY_V1!, "base64"),
  v2: Buffer.from(process.env.WHATSAPP_ENCRYPTION_KEY_V2!, "base64"),
};
```

Encrypt with the newest active version; decrypt by prefix. Re-encrypt on next successful connect.

---

### 4.3 Log redaction / no secret leakage — **MISSING**

**Critical findings**

| File | Line | Leak |
| :--- | :--- | :--- |
| `src/middlewares/authenticate.ts` | 23, 27, 46 | `console.log('click')`, raw `Authorization` header, full JWT payload on **every authenticated request** |
| `src/modules/controllers/whatsapp-webhook.controller.ts` | 278-287, 302-304, 406 | Signature presence/format, `appSecretConfigured`, signature header, `req.body.object`, full processed result |
| `src/modules/auth/auth.controller.ts` | 30 | `console.log(req.body)` on login — logs **email + password** |
| `src/modules/admin-auth/admin-auth.controller.ts` | 365 | `console.log(req.admin)` |
| `src/services/whatsapp-calling-webhook.service.ts` | 207-211, 974, 1123-1195 | Full Meta accept response, call status, webhook payload logs |
| `src/modules/controllers/call.controller.ts` | 52, 187, 383 | Full webhook `req.body` |
| `src/middlewares/error-handler.ts` | 30-32 | Dev-only full error dump (acceptable locally, but ensure `NODE_ENV=production` in prod) |
| `src/services/mail.service.ts` | 24-27 | Logs SMTP user (not password) — still PII |

**Impact:** Anyone with log access can impersonate users, read WhatsApp content, and see call metadata. This is a P0 security issue.

**Exact fix — remove leaks**

```ts
// src/middlewares/authenticate.ts — delete lines 23, 27, 46.
// Never accept tokens from the query string.
export const authenticate = async (req, res, next) => {
  try {
    let token: string | undefined;
    const authorization = req.headers.authorization;

    if (authorization?.startsWith("Bearer ")) {
      token = authorization.slice("Bearer ".length).trim();
    } else if (req.cookies?.accessToken) {
      // Only if you intentionally support cookie auth; then add CSRF protection (§4.6).
      token = req.cookies.accessToken;
    }

    // Do NOT read req.query.token — it leaks via logs, Referer, and history.
    if (!token) {
      res.status(401).json({ success: false, message: "Authentication token is required" });
      return;
    }

    const payload = verifyAccessToken(token); // never log this
    // ...
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired authentication token" });
  }
};
```

```ts
// src/modules/auth/auth.controller.ts — delete console.log(req.body)
```

```ts
// src/modules/controllers/whatsapp-webhook.controller.ts — delete lines 278-287, 302-304, 406
```

**Exact fix — structured logger with redaction**

```ts
// src/utils/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-hub-signature-256']",
      "req.headers['x-internal-signature']",
      "req.headers['x-admin-session-token']",
      "req.body.password",
      "req.body.currentPassword",
      "req.body.newPassword",
      "req.body.otp",
      "req.body.token",
      "accessToken",
      "accessTokenEncrypted",
      "*.password",
      "*.otp",
      "*.token",
      "*.accessToken",
      "*.authorization",
      "*.sdp",
    ],
    censor: "[REDACTED]",
  },
});
```

Add `pino` and `pino-http` to dependencies, replace `console.*`, and add a CI check:

```bash
grep -rn "console\.\(log\|info\|debug\)" src --include=*.ts && exit 1 || exit 0
```

---

### 4.4 Authentication & session security — **PARTIAL**

**Findings**

| Finding | Severity | Evidence / fix |
| :--- | :--- | :--- |
| Login dereferences `user.password` before checking `user` exists → 500 instead of 401, and `typecheck` fails. | **P0** | `auth.service.ts:212-228`. Fix below. |
| Duplicate password check. | **P3** | `auth.service.ts:216, 226`. Remove the second. |
| JWT accepted from query string. | **P1** | `authenticate.ts:30-31`. Remove. |
| Cookie auth accepted without CSRF protection. | **P1** | See §4.6. |
| Access tokens last 7 days by default (`JWT_ACCESS_EXPIRES_IN=7d`). No refresh-token rotation. | **P1** | `env.example:9`; `auth.service.ts:170, 262`. Use short-lived access (15m) + rotating refresh. |
| No `jti`/session revocation for customer JWTs (only `tokenInvalidBefore`). | **P2** | `authenticate.ts:61-72`. |
| Password policy not visible in this audit; ensure Zod enforces length ≥ 12 and breached-password checks. | **P2** | `auth.validation.ts` (not reviewed in depth). |

**Exact fix — login null safety**

```ts
// src/modules/auth/auth.service.ts
export const loginUser = async (input: LoginInput) => {
  const user = await User.findOne({ email: input.email }).select("+password");

  if (!user) {
    // Constant-ish response; avoids user enumeration.
    throw new AuthError("Invalid email or password", 401);
  }

  const isPasswordValid = await comparePassword(input.password, user.password);
  if (!isPasswordValid) {
    throw new AuthError("Invalid email or password", 401);
  }

  if (!user.isActive) {
    throw new AuthError("This account is suspended or inactive.", 403);
  }

  // ...email verification and trial checks unchanged
};
```

This single fix also clears the `npm run typecheck` failure.

---

### 4.5 Rate limiting — **PARTIAL**

**What is good**

- Login: 5 / 15 min (`rate-limiter.ts:23-37`).
- Register: 3 / 5 min (`rate-limiter.ts:46-60`).
- Admin distributed limiter with Redis and fail-closed production behavior (`admin-rate-limit.ts`).

**Gaps**

- No global `/api` limiter. A single client can hammer Graph API, webhook processing, or expensive PDF endpoints.
- No per-tenant WhatsApp send limiter.
- No limiter on webhook ingestion (Meta can retry-storm).
- No limiter on media proxy (can be used to exfiltrate large media / exhaust bandwidth).

**Exact fix — global + per-tenant limits**

```ts
// src/middlewares/global-rate-limit.ts
import rateLimit from "express-rate-limit";

export const globalApiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300, // 300 requests/min/IP; tune per plan
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please slow down.",
    code: "RATE_LIMIT_EXCEEDED",
  },
});

export const sensitiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
```

```ts
// src/app.ts
app.use("/api", globalApiLimiter);
app.use("/api/whatsapp", sensitiveLimiter); // includes webhook + media
```

> For multi-instance correctness, back `express-rate-limit` with a Redis store (the repo already has `ioredis` and a Redis helper). See `admin-rate-limit.ts` for the existing pattern.

---

### 4.6 CORS / CSRF / headers — **PARTIAL**

**What is good**

- Helmet is enabled (`app.ts:56-60`).
- CORS is an explicit allowlist, not `*` (`app.ts:63-93`).
- `credentials: true` is intentional for the admin BFF.

**Gaps**

| Gap | Severity | Evidence |
| :--- | :--- | :--- |
| No CSRF protection while cookie auth is accepted. | **P1** | `authenticate.ts:32-34`; `cookieParser()` at `app.ts:96`. |
| CORS error is thrown as a generic `Error`, producing a 500 instead of a clean 403. | **P2** | `app.ts:77`. |
| `helmet` defaults are good, but no explicit CSP/HSTS review for the API surface. | **P2** | `app.ts:56-60`. |
| `trust proxy` is set to `1`; ensure the actual proxy chain matches to avoid IP spoofing in rate limits. | **P2** | `app.ts:51`. |

**Exact fix — CSRF guard for cookie-authenticated state changes**

```ts
// src/middlewares/csrf-guard.ts
import type { Request, Response, NextFunction } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  const allowed = [
    "https://www.vexchat.io",
    "https://vexchat.io",
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  // Bearer-token requests are not CSRF-able; cookie requests must prove origin.
  const usesBearer = req.headers.authorization?.startsWith("Bearer ");
  if (usesBearer) return next();

  if (!origin || !allowed.includes(origin)) {
    res.status(403).json({
      success: false,
      message: "Cross-site request blocked",
      code: "CSRF_BLOCKED",
    });
    return;
  }

  next();
}
```

Mount **after** `cookieParser()` and **before** routes:

```ts
app.use(csrfGuard);
```

**Stronger option:** drop cookie auth for customer routes entirely; keep cookies only for the admin session, which already has BFF assertions and `__Host-` cookies.

**Exact fix — CORS error handling**

```ts
origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  const err = new Error(`Origin ${origin} not allowed by CORS`);
  (err as Error & { statusCode?: number }).statusCode = 403;
  callback(err);
},
```

---

### 4.7 Injection / input validation — **READY (mostly)**

**What is good**

- Zod validation on auth, campaign, billing, workspace, settings, and support inputs.
- Regex escaping in template search (`template.service.ts:13-15`) and support search (`support-ticket.service.ts:76`).
- Graph API node IDs and endpoint segments are allowlisted (`whatsapp-api.service.ts:65-67, 83-120`).
- Mongoose casts ObjectIds; invalid IDs mostly return 400.
- No raw `eval`, `Function`, or shell execution from user input.

**Gaps**

- No global body-size limit beyond `express.json({ limit: "1mb" })`; file uploads/media go through Meta, so this is mostly fine.
- `updateWorkspaceMemberRole` throws generic `Error`, producing a 500 instead of 403 (`workspace-member.service.ts:108-131`). Fix to `AppError`.
- Some controllers may pass `req.body` directly; verify each uses Zod. The reviewed modules do.

---

### 4.8 Multi-tenant/security checklist

| Control | Status | Notes |
| :--- | :---: | :--- |
| Workspace membership middleware | **READY** | Active membership check |
| Role-based route guards | **READY** | OWNER/ADMIN/AGENT |
| Service queries scoped by `workspaceId` | **PARTIAL** | Mostly yes; no DB-level guarantee |
| Cross-tenant regression tests | **MISSING** | Add CI test |
| Tenant token encryption | **READY** | AES-256-GCM |
| Secret boot validation | **MISSING** | Add core schema |
| Log redaction | **MISSING** | JWT/password/webhook leaks |
| JWT from header only | **MISSING** | Query token accepted |
| Short-lived access + refresh | **PARTIAL** | 7-day access token |
| Global rate limit | **MISSING** | Add |
| Per-tenant send limit | **MISSING** | Add |
| CSRF | **MISSING** | Cookie auth enabled |
| CORS allowlist | **READY** | Explicit origins |
| Helmet | **READY** | Enabled |
| Input validation | **READY** | Zod |
| Injection escaping | **READY** | Regex escaped, Graph IDs allowlisted |

---

## 5. Criterion 4 — Production Gap Analysis

### 5.1 Error monitoring / Sentry — **MISSING**

**Evidence**

- No `@sentry/node`, `@sentry/profiling-node`, OpenTelemetry, Datadog, or New Relic dependency in `package.json`.
- Errors are logged with `console.error` and then discarded (`error-handler.ts:30-32`).
- No alerting on webhook failures, token expiry, campaign failures, or payment anomalies.

**Impact:** Production incidents will be discovered by customers, not by the team.

**Exact fix — Sentry (Node SDK v8+)**

```ts
// src/instrument.ts — must be imported before app code
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || 0.1),
  sendDefaultPii: false,
  beforeSend(event) {
    // Defensive: never send auth headers or tokens.
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
      delete event.request.headers["x-hub-signature-256"];
    }
    return event;
  },
});
```

```ts
// src/server.ts and api/index.ts — first import
import "./instrument.js";
```

```ts
// src/app.ts — after all routes, before the custom error handler
import * as Sentry from "@sentry/node";
Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);
```

```ts
// src/utils/logger.ts / worker
import * as Sentry from "@sentry/node";
Sentry.captureException(error);
```

**Alerting rules to configure**

- Webhook signature failures > 10/min.
- Webhook 5xx rate > 1%.
- WhatsApp API 401/190 (token expired).
- WhatsApp API 429/131048 (rate limit).
- Campaign failure rate > 5%.
- Payment approval/refund errors.
- MongoDB/Redis connection failures.
- Outbox backlog age > 5 minutes.

---

### 5.2 Structured logging — **MISSING**

- All logging is `console.*` with free-form strings and emojis.
- No request IDs / correlation IDs.
- No tenant ID in logs, making incident forensics slow.
- Sensitive data is logged (§4.3).

**Fix:** adopt `pino` (fast, JSON, redaction) + `pino-http` with `req.id`, `req.user.id`, and `req.workspace.id`. Ship logs to Loki/Datadog/CloudWatch. Do not log bodies by default.

---

### 5.3 Health, readiness & graceful shutdown — **PARTIAL**

**What exists**

- `GET /` and `GET /api/health` return 200 (`app.ts:199-214`).
- MongoDB connection caching and pool timeouts (`database.ts:3-9`).
- Redis client timeouts (`env.ts:212-233`).

**Gaps**

- `/api/health` does **not** check MongoDB or Redis. A process can be “healthy” while unable to serve.
- No `/api/ready` endpoint for load balancers.
- No graceful shutdown: `server.ts` never closes HTTP, MongoDB, Redis, BullMQ, or Socket.IO on `SIGTERM`.
- No `unhandledRejection` / `uncaughtException` handlers.
- No request timeout middleware.

**Exact fix — readiness + shutdown**

```ts
// src/app.ts
app.get("/api/ready", async (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  let redisReady = false;
  try {
    redisReady = (await redis.ping()) === "PONG";
  } catch {
    redisReady = false;
  }
  const ok = mongoReady && (process.env.REDIS_URL ? redisReady : true);
  res.status(ok ? 200 : 503).json({
    success: ok,
    mongo: mongoReady,
    redis: redisReady,
    timestamp: new Date().toISOString(),
  });
});
```

```ts
// src/server.ts
const shutdown = async (signal: string) => {
  console.log(`[Shutdown] ${signal} received`);
  server.close(async () => {
    await mongoose.connection.close();
    await redis.quit().catch(() => undefined);
    process.exit(0);
  });
  // Force exit after 30s.
  setTimeout(() => process.exit(1), 30_000).unref();
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason);
  Sentry.captureException(reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err);
  Sentry.captureException(err);
  process.exit(1);
});
```

---

### 5.4 Database indexes — **PARTIAL**

**What exists**

- `WhatsAppMessage`: unique `{whatsappAccountId, waMessageId}`, `{workspaceId, conversationId, timestamp}`.
- `WhatsAppConversation`: unique `{workspaceId, whatsappAccountId, contactId}`, `{workspaceId, status, lastMessageAt}`.
- `CampaignRecipient`: unique `{campaignId, contactId}`, `{workspaceId, campaignId, status}`, `{campaignId, status}`, `{providerMessageId}`.
- `Membership`: unique `{workspaceId, userId}`, `{workspaceId, role, status}`.
- `WhatsAppAccount`: unique `{phoneNumberId}`, `{workspaceId, businessAccountId}`.

**Gaps**

| Query | Missing index | Impact |
| :--- | :--- | :--- |
| Dashboard recent conversations sorts by `lastMessageAt` only | `{workspaceId: 1, lastMessageAt: -1}` | Collection scan on large workspaces |
| Dashboard message activity filters `workspaceId + timestamp` | `{workspaceId: 1, timestamp: -1}` | Slow analytics |
| Campaign recipient status webhook lookup | `{providerMessageId: 1}` exists, but not `{workspaceId, providerMessageId}` | Cross-tenant lookup is possible if IDs collide (they shouldn't, but scope it) |
| Payment ledger list | `{workspaceId: 1, createdAt: -1}`, `{status: 1, createdAt: -1}` | Admin finance slowness |
| Contact opt-out audience query | `{workspaceId: 1, isOptedOut: 1}` | Audience compile scans |
| Call logs | `{workspaceId: 1, createdAt: -1}`, `{callId: 1}` | Calling history slowness |
| Support tickets | `{status: 1, createdAt: -1}` | Admin desk slowness |

**Exact fix — add indexes**

```ts
// src/modules/whatsapp/conversation.model.ts
conversationSchema.index({ workspaceId: 1, lastMessageAt: -1 });
```

```ts
// src/modules/whatsapp/message.model.ts
whatsappMessageSchema.index({ workspaceId: 1, timestamp: -1 });
whatsappMessageSchema.index({ workspaceId: 1, status: 1 });
```

```ts
// src/modules/campaign/campaign.model.ts
campaignSchema.index({ status: 1, scheduledAt: 1 });
```

```ts
// src/modules/campaign/campaign-recipient.model.ts
campaignRecipientSchema.index({ workspaceId: 1, providerMessageId: 1 });
```

```ts
// src/modules/billing/payment.model.ts
paymentSchema.index({ workspaceId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ initiatedBy: 1, createdAt: -1 });
```

```ts
// src/modules/whatsapp/contact.model.ts
contactSchema.index({ workspaceId: 1, isOptedOut: 1 });
```

**Operational note:** create indexes in production with `background: true` (MongoDB 4.2+ ignores it, but Atlas builds online). Monitor `db.currentOp()` and index build progress. Do not let Mongoose `autoIndex` create heavy indexes during peak traffic; disable `autoIndex` in production and run a migration job.

---

### 5.5 Backups & disaster recovery — **MISSING**

**Evidence**

- No backup configuration, restore script, or documented RPO/RTO in the repo.
- `database.ts` only manages the connection.

**Required**

1. **MongoDB Atlas continuous backups + PITR** (or equivalent managed backup). Retention ≥ 7 days for launch, ≥ 30 days for compliance.
2. **Daily logical dump** (`mongodump --gzip`) to object storage with lifecycle policy and encryption.
3. **Restore drill** quarterly; document RTO/RPO.
4. **Backup of encryption keys** in a secrets manager (KMS/Secrets Manager), not in the DB or repo. Without the key, backups of `accessTokenEncrypted` are useless.
5. **Redis persistence**: campaign queues must survive restarts. Enable AOF (`appendonly yes`) or accept that in-flight jobs are re-enqueued by the scheduler from `CampaignRecipient.status`.
6. **Point-in-time recovery test** before launch.

**Exact fix — backup script**

```bash
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mongodump --uri="$MONGODB_URI" --gzip --archive="/backups/vexchat-$STAMP.gz"
aws s3 cp "/backups/vexchat-$STAMP.gz" "s3://vexchat-backups/mongo/$STAMP.gz" --sse AES256
find /backups -name 'vexchat-*.gz' -mtime +7 -delete
```

Schedule daily via the platform scheduler, and alert on failure.

---

### 5.6 Deployment topology — **MISSING (critical mismatch)**

**Evidence**

- `api/index.ts` exports a Vercel serverless handler.
- `vercel.json` routes everything to `api/index.ts` and defines no crons.
- `app.ts` creates a `http.Server` and initializes Socket.IO (`app.ts:48, 109-136`).
- `server.ts` is a long-lived listener, but Vercel uses `api/index.ts`, not `server.ts`.
- Calling outbox must be invoked by an external scheduler; `vercel.json` has no cron entry.

**Impact**

- Socket.IO does **not** work reliably on Vercel serverless (no persistent WebSocket connection to a single function instance; no sticky sessions; function timeouts).
- Background workers cannot run on serverless.
- The call-notification outbox will never run unless an external cron calls `/api/internal/process-call-notifications`.
- In-memory Socket.IO room state is lost between invocations.

**Recommended architecture**

```
┌─────────────────────┐      ┌──────────────────────┐
│  API service        │      │  Realtime service    │
│  (Render/Fly/ECS)   │      │  (Socket.IO, sticky) │
│  - REST             │      │  - call signaling    │
│  - webhooks         │      │  - campaign events   │
└─────────┬───────────┘      └──────────┬───────────┘
          │                             │
          ├───────────┬─────────────────┤
          ▼           ▼                 ▼
     MongoDB       Redis            BullMQ workers
   (Atlas)     (managed)     (campaign + call outbox)
```

**If the team insists on Vercel:**

- Move Socket.IO to a separate realtime service (Pusher/Ably/Supabase Realtime or a small Fly.io service).
- Run BullMQ workers on a separate long-lived host.
- Add Vercel Cron entries for campaign scheduling and call outbox.
- Use Vercel Queues / Upstash QStash for webhook fan-out.

**Minimum launch config:** Render Web Service (API + Socket.IO) + Render Background Worker (BullMQ) + MongoDB Atlas + Upstash Redis + external cron (Render Cron Job or GitHub Actions) hitting the internal endpoints with `CRON_SECRET`.

---

### 5.7 Graceful errors & dependency failure behavior — **PARTIAL**

**What is good**

- Central error handler maps unknown errors to 500 without leaking internals in production (`error-handler.ts`).
- Meta errors are sanitized (`whatsapp-api.service.ts:209-330`).
- Redis admin limiter is fail-closed in production (`admin-rate-limit.ts`).
- Billing approval uses transactions (`billing.service.ts:490-575`).

**Gaps**

- External calls (Meta, SMTP, gateways) have timeouts in some places (`AbortSignal.timeout(15000)` in templates; axios timeouts in media), but not consistently everywhere.
- No circuit breaker for Meta or payment gateways.
- No retry for transient SMTP/mail failures.
- `mail.service.ts` logs SMTP user and may throw synchronously into auth flows; ensure OTP send failure is handled gracefully and does not leak details.
- Webhook processing is synchronous and can time out.

**Fix:** wrap all outbound calls in a shared `withTimeout`/retry helper; add circuit breakers (`opossum`) for Meta and payment providers; make email sending best-effort with a queue.

---

### 5.8 Test & build health — **MISSING**

**Evidence**

- `npm run typecheck` → **fails**:
  ```
  src/modules/auth/auth.service.ts(213,65): error TS18047: 'user' is possibly 'null'.
  ```
- `npm test` → **fails immediately**:
  ```
  Could not find 'tests/phase-12a-config.test.ts, tests/contact-crud.test.ts, ...'
  ```
  The referenced files do not exist; `tests/` contains different files (`admin-analytics.test.ts`, `calling.test.ts`, etc.).
- No CI configuration was found in the repo for typecheck/test/lint.

**Impact:** The team cannot trust the build. Regressions will ship.

**Exact fix**

```json
// package.json
"test": "tsx --test --test-concurrency=1 tests/*.test.ts",
"test:watch": "tsx --test --watch tests/*.test.ts",
"typecheck": "tsc --noEmit",
"check": "npm run typecheck && npm test"
```

If Windows shell globbing is an issue, use `node --test` with explicit files or a small runner script. Add CI:

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

---

### 5.9 Production essentials checklist

| Item | Status | Notes |
| :--- | :---: | :--- |
| Sentry / error tracking | **MISSING** | Add `@sentry/node` |
| Structured logging + redaction | **MISSING** | Add pino |
| Request/correlation IDs | **MISSING** | Add pino-http / middleware |
| Health check (liveness) | **PARTIAL** | Does not check dependencies |
| Readiness check | **MISSING** | Add `/api/ready` |
| Graceful shutdown | **MISSING** | Add SIGTERM handlers |
| Unhandled rejection handlers | **MISSING** | Add |
| DB indexes | **PARTIAL** | Add compound indexes |
| `autoIndex` disabled in prod | **MISSING** | Set `autoIndex: false` + migration job |
| Backups / PITR | **MISSING** | Atlas + dump + restore drill |
| Restore drill | **MISSING** | Quarterly |
| Secret manager | **MISSING** | Use platform secrets/KMS |
| Deployment topology | **MISSING** | Serverless vs Socket.IO/worker mismatch |
| Cron for outbox/campaigns | **MISSING** | Add `vercel.json` crons or external scheduler |
| CI typecheck/test | **MISSING** | Add workflow |
| Dependency audit (`npm audit`) | **MISSING** | Add CI step |
| Container/Node version pin | **PARTIAL** | `engines.node: 24.x`; pin exact in deploy |
| Rate limit store in Redis | **PARTIAL** | Admin only |

---

## 6. Prioritized Remediation Plan

### P0 — Block launch (target: 1–2 weeks)

| # | Task | Files | Effort |
| :--- | :--- | :--- | :---: |
| 1 | Fix login null dereference; restore typecheck | `auth.service.ts:211-228` | 15 min |
| 2 | Fix `npm test` script; add CI | `package.json`, `.github/workflows/ci.yml` | 1 h |
| 3 | Remove secret/PII logs; add redacted logger | `authenticate.ts`, `auth.controller.ts`, `whatsapp-webhook.controller.ts`, `call.controller.ts`, `whatsapp-calling-webhook.service.ts`, `error-handler.ts` | 4 h |
| 4 | Reject JWT from query string | `authenticate.ts:30-31` | 15 min |
| 5 | Enforce 24h window in text + media sends; align schema | `whatsapp-message.service.ts:398-405, 982-986`; `conversation.model.ts` | 1 h |
| 6 | Implement campaign queue + worker + scheduler + real send | `campaign.queue.ts`, `campaign.worker.ts`, `campaign.scheduler.ts`, `campaign.service.ts`, `worker.ts` | 2–3 days |
| 7 | Persist `providerMessageId`; propagate status to recipients + counters | `campaign.service.ts`, `whatsapp-message.service.ts` | 1 day |
| 8 | Choose and fix deployment topology (long-lived API + worker) | `server.ts`, `worker.ts`, deploy config | 1–2 days |
| 9 | Add cron/scheduler for call outbox + campaigns | `vercel.json` or host cron; `calling.routes.ts` | 2 h |
| 10 | Add Sentry + global error capture | `instrument.ts`, `app.ts`, `server.ts`, `api/index.ts` | 3 h |
| 11 | Add core env validation at boot | `env.ts`, `server.ts`, `api/index.ts` | 2 h |

### P1 — Before scale / within 2 weeks

| # | Task | Files | Effort |
| :--- | :--- | :--- | :---: |
| 12 | Webhook event idempotency + async processing + DLQ | `webhook-event.model.ts`, controller, worker | 1–2 days |
| 13 | Global + per-tenant rate limits (Redis store) | `global-rate-limit.ts`, `campaign-rate-limiter.ts`, `app.ts` | 1 day |
| 14 | CSRF guard or drop cookie auth | `csrf-guard.ts`, `app.ts` | 4 h |
| 15 | Short-lived access + rotating refresh tokens | `auth.service.ts`, `jwt.ts`, `user.model.ts` | 1–2 days |
| 16 | Tenant token expiry/refresh + reconnect alerts | `whatsapp.model.ts`, worker, UI hook | 1 day |
| 17 | Use tenant token for calling; unify Graph version | calling services, `call.controller.ts`, `whatsapp-message.service.ts` | 4 h |
| 18 | Add readiness endpoint + graceful shutdown | `app.ts`, `server.ts` | 3 h |
| 19 | Add compound indexes + disable `autoIndex` in prod | models, migration script | 4 h |
| 20 | Set up Atlas backups/PITR + restore drill + key escrow | infra | 1 day |
| 21 | Add cross-tenant regression test suite | `tests/tenant-isolation.test.ts` | 1–2 days |
| 22 | Add `appsecret_proof` to Graph calls | `whatsapp-api.service.ts` | 1 h |

### P2 — Hardening / within the quarter

| # | Task | Effort |
| :--- | :--- | :---: |
| 23 | Key rotation envelope (`v1.` prefix, multi-key decrypt) | 1 day |
| 24 | Immutable consent ledger (`ConsentEvent`) | 1 day |
| 25 | Circuit breakers for Meta/SMTP/gateways | 1 day |
| 26 | Structured logging pipeline (pino → Loki/Datadog) | 1 day |
| 27 | Alerting rules (webhook 5xx, token 190, rate 429, campaign failures) | 4 h |
| 28 | Payment gateway callbacks (bKash/Nagad) or document manual-only | 3–5 days |
| 29 | Admin session/customer JWT revocation (`jti`) | 1 day |
| 30 | Dependency audit + Dependabot | 2 h |
| 31 | Mongo/Redis query performance review + slow-query alerts | 1 day |
| 32 | Documentation: correct README claims, runbooks, on-call | 1 day |

### P3 — Polish

| # | Task |
| :--- | :--- |
| 33 | Remove duplicate subscribe call in `whatsapp.service.ts:100-125` |
| 34 | Remove dead `completePaymentAtomic` or wire it to a real gateway callback |
| 35 | Normalize Bengali/English comments and emoji logs |
| 36 | Add OpenAPI/Swagger for the public API |
| 37 | Add load tests for webhook bursts and campaign throughput |

---

## 7. Payments & Subscriptions — Additional Finding

Although not one of the four explicit criteria, the audit found a material gap that affects “production-ready SaaS” claims:

| Item | Status | Evidence |
| :--- | :---: | :--- |
| City Bank manual transfer submission | **READY** | `billing.routes.ts:40-43`; `billing.service.ts:444-575` |
| Admin approve/reject transfer | **READY** | `billing.routes.ts:63-81` |
| Transactional approval + subscription extension + invoice | **READY** | `billing.service.ts:490-575` |
| High-value step-up token | **READY** | `billing.service.ts:470-488` |
| Refund ledger | **READY** | `billing.service.ts:706+` |
| bKash direct payment | **MISSING** | Only a health probe (`gateway-probe.service.ts`); no initiate/execute/callback |
| Nagad direct payment | **MISSING** | No code |
| Card/PortPOS/SSLCommerz/Stripe | **MISSING** | Payment method enums exist, no integration |
| Gateway callback/webhook route | **MISSING** | `billing.routes.ts` has no public callback route |
| `completePaymentAtomic` | **DEAD CODE** | Defined at `billing.service.ts:238`, never called |
| Idempotent gateway reconciliation | **MISSING** | No callback handler |

**Verdict:** Billing is **manual-transfer-only**. If the launch plan promises bKash/Nagad/card checkout, this is a P0 business blocker.

**Recommended callback pattern (bKash example)**

```ts
// src/modules/billing/gateway.routes.ts
import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { billingService } from "./billing.service.js";

const router = Router();

router.post("/webhooks/bkash", async (req, res) => {
  const signature = req.headers["x-bkash-signature"];
  const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));

  const expected = createHmac("sha256", process.env.BKASH_WEBHOOK_SECRET!)
    .update(raw)
    .digest("hex");

  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false });
  }

  // Idempotent: provider trxID is the idempotency key.
  await billingService.completePaymentAtomic({
    paymentId: req.body.paymentID,
    trxID: req.body.trxID,
    providerStatus: req.body.transactionStatus,
    rawGatewayResponse: req.body,
  });

  return res.status(200).json({ success: true });
});

export default router;
```

Mount before the authenticated billing routers in `app.ts`. Reuse the `PaymentAuditLog` and transaction logic from `approveBankTransfer`.

---

## 8. Evidence Index

| Area | File | Key lines |
| :--- | :--- | :--- |
| App middleware order | `src/app.ts` | 47–136, 199–225 |
| Serverless entry | `api/index.ts` | 1–29 |
| Vercel config | `vercel.json` | 1–15 |
| Env validation | `src/config/env.ts` | 91–126, 315–530 |
| DB connection | `src/config/database.ts` | 3–75 |
| Encryption | `src/utils/encryption.ts` | 7–70 |
| Auth middleware | `src/middlewares/authenticate.ts` | 16–89 |
| Login bug | `src/modules/auth/auth.service.ts` | 211–228 |
| Workspace membership | `src/middlewares/require-workspace-membership.ts` | 15–63 |
| Rate limiting | `src/middlewares/rate-limiter.ts` | 1–60 |
| Error handler | `src/middlewares/error-handler.ts` | 5–46 |
| Webhook verify + signature | `src/modules/controllers/whatsapp-webhook.controller.ts` | 193–237, 268–486 |
| Signature utility | `src/modules/services/whatsapp-webhook.service.ts` | 1–41 |
| Inbound idempotency + opt-out | `src/modules/services/whatsapp-message.service.ts` | 51–281 |
| 24h window (disabled) | `src/modules/services/whatsapp-message.service.ts` | 398–405, 982–986 |
| Status updates | `src/modules/services/whatsapp-message.service.ts` | 291–351 |
| Conversation model | `src/modules/whatsapp/conversation.model.ts` | 1–120 |
| Message indexes | `src/modules/whatsapp/message.model.ts` | 166–181 |
| WhatsApp account token | `src/modules/whatsapp/whatsapp.model.ts` | 61–91 |
| Connect flow | `src/modules/whatsapp/whatsapp.service.ts` | 28–156 |
| Template sync | `src/modules/whatsapp/template.service.ts` | 197–420 |
| Graph error mapping | `src/modules/services/whatsapp-api.service.ts` | 209–330 |
| Campaign dispatch stub | `src/modules/campaign/campaign.service.ts` | 819–905 |
| Campaign routes | `src/modules/campaign/campaign.routes.ts` | 1–101 |
| Campaign recipient model | `src/modules/campaign/campaign-recipient.model.ts` | 69–112 |
| Call outbox cron | `src/modules/Calling/calling.routes.ts` | 52–89 |
| Calling token/version | `src/services/whatsapp-calling-webhook.service.ts` | 169–329 |
| Call socket auth | `src/sockets/callSocket.ts` | 341–410 |
| Billing routes | `src/modules/billing/billing.routes.ts` | 31–164 |
| Billing approval transaction | `src/modules/billing/billing.service.ts` | 444–575 |
| Payment model/RG | `src/modules/billing/payment.model.ts` | 1–120 |
| Gateway probe | `src/modules/billing/gateway-probe.service.ts` | 1–130 |
| Support service | `src/modules/support/support-ticket.service.ts` | 55–110 |
| README claims | `README.md` | 39–106 |

---

## 9. Go-Live Checklist

Use this as the final gate. Do not launch until every **P0** item is checked.

### Meta

- [ ] P0 — 24h customer-service window enforced in text + media send paths.
- [ ] P0 — Webhook signature failures are logged (without secrets) and alerting is on.
- [ ] P1 — Graph API version is consistent (`whatsappConfig.graphApiBaseUrl` everywhere).
- [ ] P1 — Tenant token expiry tracking + reconnect alert implemented.
- [ ] P1 — `appsecret_proof` added to Graph calls.
- [ ] P1 — Calling uses the tenant token, not the system-user fallback.
- [ ] P1 — Webhook event-level idempotency + async processing.
- [ ] P2 — Token key rotation plan documented.

### Campaigns

- [ ] P0 — BullMQ queue, worker, and scheduler implemented and running.
- [ ] P0 — `dispatchCampaignRecipient` performs the real Meta template send.
- [ ] P0 — `providerMessageId` persisted on send.
- [ ] P0 — Webhook status updates propagate to `CampaignRecipient` and campaign counters.
- [ ] P0 — Per-tenant rate limiting + retry/backoff + DLQ.
- [ ] P1 — Pause/resume/cancel honored by the worker.
- [ ] P1 — Campaign completion transition implemented.
- [ ] P1 — Consent ledger / audit trail documented.

### Security & tenancy

- [ ] P0 — No secrets/PII in logs; redacted logger in place.
- [ ] P0 — JWT accepted only from `Authorization` header (or CSRF-protected cookie).
- [ ] P0 — Login null bug fixed; typecheck passes.
- [ ] P0 — `npm test` passes in CI.
- [ ] P1 — Global and per-tenant rate limits.
- [ ] P1 — CSRF guard or cookie auth removed.
- [ ] P1 — Core env variables validated at boot.
- [ ] P1 — Cross-tenant regression tests in CI.
- [ ] P2 — Short-lived access tokens + refresh rotation.
- [ ] P2 — Key rotation envelope.

### Production operations

- [ ] P0 — Long-lived API + worker topology chosen; Socket.IO works.
- [ ] P0 — Cron/scheduler for call outbox and campaigns configured.
- [ ] P0 — Sentry (or equivalent) configured with alerting.
- [ ] P0 — MongoDB Atlas backups + PITR enabled; restore drill completed.
- [ ] P1 — Readiness endpoint + graceful shutdown + unhandled rejection handlers.
- [ ] P1 — Compound indexes deployed; `autoIndex` disabled in production.
- [ ] P1 — Structured logs with request/tenant IDs shipped to a log store.
- [ ] P1 — `npm audit` clean or accepted; dependency pinning.
- [ ] P2 — Runbooks for webhook outage, token expiry, campaign failure, DB restore.

### Billing

- [ ] P0 — If bKash/Nagad/card checkout is promised: integrations + signed callbacks implemented.
- [ ] P1 — If manual-only: remove/disable unsupported payment methods in the UI and document the limitation.
- [ ] P2 — Remove or wire dead `completePaymentAtomic`.

---

## 10. Final Verdict

**The WhatsApp messaging core is credible. The SaaS is not production-ready.**

What is genuinely good:

- Official Meta Cloud API only, with correct webhook HMAC verification and tenant token encryption.
- Solid inbound message idempotency and opt-out handling.
- Workspace-scoped route guards and role checks.
- Transactional billing approval and clean Meta error mapping.

What blocks launch:

- **Campaigns do not send.** This is the product’s core promise.
- **Delivery tracking does not exist for campaigns.**
- **24-hour compliance is not enforced**, despite documentation claiming it is.
- **The build and test commands fail.**
- **Secrets and PII are logged.**
- **The deployment target cannot run Socket.IO or workers.**
- **There is no monitoring, backup, or incident visibility.**

Fix the P0 list in §6 first. Then re-run this audit. The expected post-P0 state is a functional, compliant single-tenant-per-workspace WhatsApp inbox with working campaigns and a long-lived worker deployment. After P1, it becomes a defensible multi-tenant SaaS.

---

*End of report.*
