# Cyber7 WhatsApp Calling — Backend Architecture & Independent Verification Audit

**Audit Date:** November 6, 2026  
**Auditor Role:** Principal Backend Security Architect, Authentication Auditor & Real-Time Communications Specialist  
**Target Repository:** `D:\Client-project\client-2\cyber7-backend`  
**Referenced Frontend:** `D:\Client-project\client-2\cyber7-frontend`  
**Execution Phase:** Phase 1 — Comprehensive Backend Audit (Strict Read-Only Verification)

---

## 1. Executive Summary & Architecture Overview

Cyber7 is a multi-tenant WhatsApp Business API SaaS platform. This audit comprehensively analyzes the backend Calling subsystem, tracing the execution path from Meta Graph API webhook reception to database persistence, multi-agent assignment, tenant authorization, Socket.IO signaling, and frontend client notification delivery.

### High-Level Architecture Diagram

```
[Meta WhatsApp Calling Webhook]
             │
             ▼ (POST /api/whatsapp)
[Raw Buffer Verification (app.ts)]
             │
             ▼
[Signature Verifier (whatsapp-webhook.service.ts)]
             │ (x-hub-signature-256 HMAC-SHA256)
             ▼
[Webhook Controller (whatsapp-webhook.controller.ts)]
             │ (field === "calls")
             ▼
[Calling Webhook Service (whatsapp-calling-webhook.service.ts)]
      ├─► [Resolve Account: WhatsAppAccount (phone_number_id) + Workspace (ACTIVE)]
      ├─► [Contact Resolution: WhatsAppContact (waId == caller phone)]
      ├─► [Recipient Routing: Assigned AGENT -> Fallback Active OWNER/ADMIN]
      ├─► [CallLog Upsert: CallLog.updateOne({ workspaceId, providerCallId }, ...)]
      └─► [Outbox Enqueue: CallNotificationOutbox.bulkWrite({ eventType, PENDING })]
             │
             ▼
[Call Notification Outbox Queue (CallNotificationOutbox.ts)]
             │
             ░░░ [CRITICAL GAP: No Background Worker / Dispatch Loop exists]
             │
             ▼ (Intended Socket.IO Delivery via callSocket.ts)
[Private User Room (user_${userId})] ──► [Agent Socket.IO Client]
                                               │
                                               ▼
                              [answer-incoming-call Event]
                                               │
                                               ▼
                         [Atomic findOneAndUpdate Race Check]
                                               ├─► Winning Agent: [call-accepted]
                                               └─► Losing Agents:  [call-taken]
```

---

## 2. Inventory of Existing Calling Backend Files & Responsibilities

| File Path | Component | Responsibility |
| :--- | :--- | :--- |
| `src/modules/Calling/CallLog.ts` | Model & Schema | Persists call lifecycle (`RINGING`, `CONNECTED`, `ENDED`, `REJECTED`), tenant isolation (`workspaceId`), provider call reference (`providerCallId`), caller identity, assigned agent, eligible recipients (`ringingUserIds`), and timestamps. Contains 5 tenant-scoped indexes. |
| `src/modules/Calling/CallNotificationOutbox.ts` | Model & Schema | Persists reliable notification queue items for incoming calls and call-ended events per recipient. Implements unique deduplication index `(workspaceId, providerCallId, recipientUserId, eventType)` and retry fields (`attempts`, `nextAttemptAt`). |
| `src/modules/Calling/callNotificationOutbox.service.ts` | Outbox Service | Provides `enqueueIncomingCallNotifications` and `enqueueCallEndedNotifications` using atomic MongoDB `bulkWrite` with `$setOnInsert` and `upsert: true`. |
| `src/modules/Calling/calling.routes.ts` | Express Routes | Declares `/workspaces/:workspaceId/calls`, `/workspaces/:workspaceId/calls/start`, and `/workspaces/:workspaceId/calls/:callId/end` protected by `authenticate`, `requireWorkspaceMembership`, and `requireRole("OWNER", "ADMIN", "AGENT")`. |
| `src/modules/controllers/call.controller.ts` | REST Controller | Implements `getCallLogs` (filtered call history), `startOutgoingCall` (returns HTTP 501), and `endCallSession` (returns HTTP 501). |
| `src/services/whatsapp-calling-webhook.service.ts` | Webhook Processor | Core business logic for parsing Meta calling events (`connect`, `terminate`), resolving tenant by `phone_number_id`, resolving contact assignment, selecting eligible recipients, ensuring CallLog idempotency, and enqueuing outbox records. |
| `src/modules/controllers/whatsapp-webhook.controller.ts` | Webhook Receiver | Validates Meta HMAC signature on raw request body, receives Webhook entries, and routes `field === "calls"` to `processWhatsAppCallingWebhook`. |
| `src/modules/services/whatsapp-webhook.service.ts` | Crypto Service | Implements `verifyWhatsAppWebhookSignature` with timing-safe HMAC-SHA256 comparison against `process.env.META_APP_SECRET`. |
| `src/sockets/callSocket.ts` | Socket.IO Server | Handles authenticated Socket.IO handshakes, places each user in private room `user_${userId}`, authorizes workspace access, performs atomic first-answer-wins call assignment via `findOneAndUpdate`, dispatches `call-accepted` to winner and `call-taken` to losers, and stubs out unimplemented WebRTC and outbound call initiation. |
| `src/app.ts` | App Bootstrap | Preserves `rawBody` Buffer in `express.json` for Meta webhook signature verification, mounts `callingRoutes`, and initializes `initCallSocket(io)`. |

---

## 3. Requirement Verification Status (22 Points)

| # | Audit Requirement | Status | Detailed Findings & Technical Evidence |
| :---: | :--- | :---: | :--- |
| **1** | **Meta webhook signature verification** | **COMPLETE** | In `whatsapp-webhook.controller.ts` (lines 275–291) and `whatsapp-webhook.service.ts` (lines 5–42). Uses `crypto.createHmac("sha256", process.env.META_APP_SECRET)` against raw request buffer captured via `express.json` verify callback in `app.ts` (lines 69–71). Verification uses `crypto.timingSafeEqual` with strict 64-hex character validation. |
| **2** | **Incoming call event parsing and validation** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts` (lines 368–461). Correctly validates `callId`, `direction` (`USER_INITIATED` vs `BUSINESS_INITIATED`), `from`, `to`, and `timestamp`. Normalizes all strings and parses Meta Unix or ISO timestamps safely. |
| **3** | **Workspace resolution exclusively through Meta `phone_number_id`** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts` (lines 161–183 & 685–697). Queries `WhatsAppAccount.findOne({ phoneNumberId, status: "CONNECTED" })` and checks that the associated `Workspace` has `status: "ACTIVE"`. Ignores any client-supplied workspace ID. |
| **4** | **Correct tenant isolation** | **COMPLETE** | All database operations (`CallLog`, `CallNotificationOutbox`) filter strictly by `workspaceId`. `CallLog.ts` enforces tenant-scoped unique index `unique_workspace_provider_call` on `{ workspaceId: 1, providerCallId: 1 }`. Socket handlers check `authorizeWorkspace(socket, data.workspaceId)`. |
| **5** | **WhatsApp account and workspace connection validation** | **COMPLETE** | `resolveWhatsAppAccount` ensures both `WhatsAppAccount.status === "CONNECTED"` and `Workspace.status === "ACTIVE"`. Disconnected accounts or suspended workspaces cleanly abort webhook processing. |
| **6** | **Contact resolution** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts` (lines 197–202). Queries `WhatsAppContact.findOne({ workspaceId, waId: phoneNumber })`. Extracts contact name from Meta payload `contacts` profile or falls back to `"Unknown"` / persisted name. |
| **7** | **Assigned active agent routing** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts` (lines 204–231). Priority 1 checks if `contact.assignedTo` exists, verifies active membership (`Membership.findOne({ workspaceId, userId: contact.assignedTo, role: "AGENT", status: "ACTIVE" })`), and verifies user is active (`User.findOne({ _id: assignedMembership.userId, isActive: true })`). If valid, assigns exclusively to this single agent. |
| **8** | **OWNER/ADMIN fallback when no valid assigned agent exists** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts` (lines 233–264). When Priority 1 yields no active agent, queries all active `OWNER` and `ADMIN` memberships for the workspace, filters for active users (`User.find({ _id: { $in: adminUserIds }, isActive: true })`), and sets `assignmentSource = "OWNER_ADMIN_FALLBACK"`. |
| **9** | **First-answer-wins behavior when multiple users receive a call** | **COMPLETE** | In `callSocket.ts` (lines 462–566). When multiple agents receive incoming call ringing notifications, the first agent emitting `answer-incoming-call` claims the call. The winning agent receives `call-accepted`; all losing agents in `ringingUserIds` receive `call-taken` to close their incoming call modals. |
| **10** | **Atomic call assignment and race-condition protection** | **COMPLETE** | In `callSocket.ts` (lines 493–516). Uses MongoDB's atomic `CallLog.findOneAndUpdate({ _id: callId, workspaceId, status: "RINGING", ringingUserIds: userId, $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] }, { $set: { assignedTo: userId, assignedAt: now, answeredAt: now } }, { new: true })`. Losers receive `null` and are emitted `CALL_NOT_AVAILABLE` error. |
| **11** | **CallLog persistence and unique provider call ID handling** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts` (lines 270–346). Calls `ensureCallLog` with `CallLog.updateOne({ workspaceId, providerCallId }, { $setOnInsert: ... }, { upsert: true })`. Safely catches duplicate key error (code 11000) on concurrent webhook deliveries. Terminal statuses (`ENDED`, `REJECTED`) are immutable against out-of-order updates. |
| **12** | **Incoming call notification outbox persistence** | **COMPLETE** | In `callNotificationOutbox.service.ts` (lines 44–85). Uses `CallNotificationOutbox.bulkWrite` with `$setOnInsert` for each recipient user ID with `eventType: "INCOMING_CALL"`, `status: "PENDING"`, and deduplicating unique compound index. |
| **13** | **Call-ended notification outbox persistence** | **COMPLETE** | In `callNotificationOutbox.service.ts` (lines 90–135). Uses `CallNotificationOutbox.bulkWrite` for each previously ringing user ID with `eventType: "CALL_ENDED"`, `status: "PENDING"`, and `endStatus: "MISSED" \| "REJECTED" \| "ENDED"`. |
| **14** | **Duplicate webhook and duplicate notification protection** | **COMPLETE** | Both `CallLog` and `CallNotificationOutbox` enforce unique compound MongoDB indexes preventing duplicate records on Meta webhook retries. Webhook retries reuse the persisted `ringingUserIds` from the first call log to avoid re-routing. |
| **15** | **Socket.IO authentication and private user rooms** | **COMPLETE** | In `callSocket.ts` (lines 389–430). Handshake authentication middleware verifies JWT Bearer token via `verifyAccessToken`, verifies user existence and active status in MongoDB, and joins the authenticated socket to private room `user_${userId}`. Private notifications are never broadcast to public rooms. |
| **16** | **Workspace membership authorization** | **COMPLETE** | In `callSocket.ts` (lines 172–221). Every client event invokes `authorizeWorkspace(socket, workspaceId)` verifying ObjectId format, active user, active workspace, and active membership. REST routes in `calling.routes.ts` enforce `authenticate`, `requireWorkspaceMembership`, and `requireRole("OWNER", "ADMIN", "AGENT")`. |
| **17** | **Notification ACK delivery handling** | **COMPLETE** | In `callSocket.ts` (lines 318–380). `deliverIncomingCallNotification` and `deliverCallEndedNotification` emit socket events with `.timeout(5000)` and check for client response `{ received: true }`. |
| **18** | **Retry and failure handling for undelivered notifications** | **INCOMPLETE / BROKEN** | Although `CallNotificationOutbox.ts` schema defines `attempts`, `nextAttemptAt`, `lastAttemptAt`, and `lastError`, there is **no processor function** that queries pending notifications, attempts delivery via socket, increments attempt count, backsoff, or transitions status to `DELIVERED`. |
| **19** | **Outbox worker scheduling and production reliability** | **BROKEN / MISSING** | **No background worker, runner, interval, or event listener** exists to drain `CallNotificationOutbox`. When a Meta webhook arrives and enqueues to outbox, the notifications sit in `PENDING` status indefinitely and are never pushed to connected agent sockets unless an immediate dispatch or worker loop is invoked. |
| **20** | **Incoming, accepted, rejected, missed, ended and outgoing event handling** | **COMPLETE** | In `whatsapp-calling-webhook.service.ts`. Direction `USER_INITIATED` sets `callType: INCOMING`, status `RINGING`. Status `ACCEPTED` transitions to `CONNECTED`. Status `REJECTED` transitions to `REJECTED`. Terminate events with `NO_ANSWER`, `CANCELED`, or zero duration become `MISSED`. Terminate with duration becomes `ENDED`. Direction `BUSINESS_INITIATED` records `OUTGOING`. |
| **21** | **API routes and frontend-facing response contracts** | **COMPLETE** | Route `GET /api/workspaces/:workspaceId/calls` correctly returns `{ success: true, data: CallLogItem[] }` with duration formatted as `MM:SS`. Routes for starting/ending calls return structured HTTP 501 errors (`META_CALLING_NOT_IMPLEMENTED`, `META_CALL_TERMINATION_NOT_IMPLEMENTED`). |
| **22** | **Actual Meta WhatsApp Calling API media/SDP/initiation/termination** | **NOT IMPLEMENTED** | Real Meta WhatsApp Calling API endpoints (VoIP Graph API calling session creation, SDP offer/answer exchange, ICE candidates, TURN/STUN media streaming) are **completely absent**. Calling controller and socket handlers explicitly return 501 or emit error events. |

---

## 4. Bugs and Security Vulnerabilities Identified

### BUG-01 (RESOLVED): Missing Outbox Worker / Immediate Dispatch Loop
- **Resolution Status:** **FIXED**
- **Fix Implemented:** Created `src/modules/Calling/callNotificationOutbox.worker.ts` with `processCallNotificationOutbox()`. Uses atomic MongoDB leases (`PENDING` → `PROCESSING`), handles lease crash recovery after 30s timeout, bounded exponential backoff (`30s` to `3600s`), and maximum 10 retry attempts. Protected internal cron endpoint mounted at `POST /api/internal/process-call-notifications` using constant-time `CRON_SECRET` authentication.

### BUG-02 (RESOLVED): Omission of `statuses` Array in Webhook Controller Forwarding
- **Resolution Status:** **FIXED**
- **Fix Implemented:** In `src/modules/controllers/whatsapp-webhook.controller.ts`, updated `processWhatsAppCallingWebhook()` invocation to include `statuses: value.statuses`. Call progress events (`type === "call"`) for `RINGING`, `ACCEPTED`, and `REJECTED` are now routed to `processCallStatus()`.

### BUG-03 (MEDIUM): Call Events in `messages` Field Webhooks Skipped
- **File Reference:** `src/modules/controllers/whatsapp-webhook.controller.ts:340`
- **Description:** If Meta sends a webhook entry where `change.field === "messages"` that includes an inline `calls` array (as documented in certain Graph API versions), line 340 passes it to message processing, but message processing only iterates `value.messages` and `value.statuses`, skipping `value.calls`.

### BUG-04 (HIGH - Architectural): Real Meta Calling VoIP Media Layer Absent
- **File Reference:** `src/modules/controllers/call.controller.ts:150–178` & `src/sockets/callSocket.ts:572–702`
- **Description:** The system cannot initiate outgoing WhatsApp calls, cannot terminate live provider calls, and cannot establish audio streams with WhatsApp clients. Outbound call endpoints return HTTP 501. Socket events `initiate-call`, `webrtc-offer`, `webrtc-answer`, `webrtc-ice-candidate`, and `hangup-call` return error events.
- **Impact:** Calling functionality is currently limited to **incoming call event notification, assignment, and call history logging**. Real audio transmission requires Meta SIP/WebRTC gateway integration.

### BUG-05 (RESOLVED): Frontend Protocol Mismatch
- **Resolution Status:** **FIXED**
- **Fix Implemented:** Synchronized `cyber7-frontend` to the verified backend protocol:
  1. Handshake uses `auth: { accessToken: getStoredToken() }`.
  2. `incoming-call` and `incoming-call-ended` invoke `ack({ received: true })` and deduplicate via `processedNotificationIdsRef`.
  3. `acceptCall` emits `answer-incoming-call` to participate in first-answer-wins.
  4. Client listens for `call-accepted` (transitioning to `assigned` state) and `call-taken` (dismissal).
  5. `callService` targets authenticated workspace routes `/workspaces/:workspaceId/calls/...`.
  6. Fake 3.5s auto-connect simulation removed. Direct call icon added to `chat-window.tsx` header.

---

## 5. API Routes & Socket.IO Event Contracts

### REST API Endpoints

#### 1. `GET /api/workspaces/:workspaceId/calls`
- **Headers:** `Authorization: Bearer <JWT>`
- **Query Parameters:**
  - `filter`: `"ALL"` | `"MISSED"` (optional, default `"ALL"`)
  - `search`: string (optional, searches callerName and phoneNumber)
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "6639f4e2b0123456789abcde",
        "name": "Alice Customer",
        "phone": "+14155552671",
        "type": "INCOMING",
        "status": "ENDED",
        "providerCallId": "meta_call_987654321",
        "callSid": null,
        "startedAt": "2026-11-06T15:00:00.000Z",
        "endedAt": "2026-11-06T15:02:15.000Z",
        "timestamp": "2026-11-06T15:00:00.000Z",
        "duration": "02:15"
      }
    ]
  }
  ```

#### 2. `POST /api/workspaces/:workspaceId/calls/start`
- **Headers:** `Authorization: Bearer <JWT>`
- **Response (501 Not Implemented):**
  ```json
  {
    "success": false,
    "code": "META_CALLING_NOT_IMPLEMENTED",
    "message": "Outgoing WhatsApp calling is not configured yet. No call was started."
  }
  ```

#### 3. `POST /api/workspaces/:workspaceId/calls/:callId/end`
- **Headers:** `Authorization: Bearer <JWT>`
- **Response (501 Not Implemented):**
  ```json
  {
    "success": false,
    "code": "META_CALL_TERMINATION_NOT_IMPLEMENTED",
    "message": "Call termination is not configured yet. The call state was not changed."
  }
  ```

---

### Socket.IO Event Contracts

#### Connection & Handshake
- **URL:** `${NEXT_PUBLIC_SOCKET_URL}` (or API host)
- **Auth Payload:** `{ auth: { accessToken: string } }` (or `headers: { authorization: "Bearer <token>" }`)
- **Default Room:** Server automatically places socket in `user_${userId}`.

#### Server-to-Client Events

| Event Name | Payload Contract | Description / Expected Client Response |
| :--- | :--- | :--- |
| `incoming-call` | `{ notificationId: string, callId: string, name: string, phone: string, callSid: string, workspaceId: string }` | Emitted to private room `user_${userId}`. **Client MUST execute ACK callback:** `ack({ received: true })`. |
| `call-accepted` | `{ workspaceId: string, callId: string, assignedTo: string }` | Emitted exclusively to the winning agent who answered first. Client enters connected/active state. |
| `call-taken` | `{ workspaceId: string, callId: string, assignedTo: string }` | Emitted to all losing agents in `ringingUserIds`. Client closes ringing modal. |
| `incoming-call-ended` | `{ notificationId: string, workspaceId: string, callId: string, status: "MISSED" \| "REJECTED" \| "ENDED" }` | Emitted to `user_${userId}` when call ends. **Client MUST execute ACK callback:** `ack({ received: true })`. |
| `socket-error` | `{ code: string, message: string }` | Emitted on authorization failures, invalid IDs, or race condition loss (`CALL_NOT_AVAILABLE`). |

#### Client-to-Server Events

| Event Name | Payload Contract | Backend Action |
| :--- | :--- | :--- |
| `join-workspace` | `workspaceId: string` | Authorizes membership; joins socket to `workspace_${workspaceId}`. |
| `answer-incoming-call` | `{ workspaceId: string, callId: string }` | Executes atomic `findOneAndUpdate` race check. Emits `call-accepted` to winner and `call-taken` to losing agents. |
| `initiate-call` | `{ workspaceId: string, targetPhone: string, callerName: string }` | Authorizes workspace; emits `socket-error` (`META_CALLING_NOT_IMPLEMENTED`). |
| `hangup-call` | `{ workspaceId: string, callId: string }` | Authorizes workspace; emits `socket-error` (`META_CALL_TERMINATION_NOT_IMPLEMENTED`). |
| `webrtc-offer` / `answer` / `ice` | `{ workspaceId: string, ... }` | Authorizes workspace; emits `socket-error` (`WEBRTC_SIGNALING_NOT_AVAILABLE`). |

---

## 6. Outbox Delivery & Retry Analysis

1. **Enqueue Guarantees:**
   - Both `enqueueIncomingCallNotifications` and `enqueueCallEndedNotifications` use MongoDB `bulkWrite` with `$setOnInsert` and `upsert: true`.
   - The unique compound index `unique_call_recipient_event` on `{ workspaceId: 1, providerCallId: 1, recipientUserId: 1, eventType: 1 }` guarantees that webhook retries from Meta will never generate duplicate notification records.

2. **Delivery Mechanism Analysis:**
   - Functions `deliverIncomingCallNotification` and `deliverCallEndedNotification` in `callSocket.ts` are implemented with a 5000ms timeout waiting for socket ACK `{ received: true }`.
   - **Critical Vulnerability:** There is currently no active caller or background loop invoking these delivery functions.
   - **Recommended Resolution:** In the webhook handler, after enqueuing to outbox, perform an immediate delivery attempt for each recipient via `deliverIncomingCallNotification`. For offline agents, a periodic scheduler (or BullMQ worker) must scan `CallNotificationOutbox` where `status: "PENDING"` and `nextAttemptAt <= now`, retry delivery, and update `attempts` and `status: "DELIVERED"`.

---

## 7. Real Meta WhatsApp Calling API Readiness Assessment

| Capability | Real WhatsApp Cloud Calling API Requirement | Current Cyber7 Implementation Status |
| :--- | :--- | :--- |
| **Incoming Call Signaling** | Meta Webhook `calls` event with SDP offer | Webhook received and parsed into CallLog. Outbox enqueued. |
| **Incoming Call Acceptance** | Meta Graph API `POST /{phone_number_id}/calls/{call_id}/accept` with SDP answer | **Not implemented**. Backend assigns call locally between agents, but does not accept the call with Meta. |
| **Outgoing Call Initiation** | Meta Graph API `POST /{phone_number_id}/calls` | **Not implemented**. Endpoint returns HTTP 501. |
| **Media (Audio) Transmission** | WebRTC media endpoints, ICE/STUN/TURN, OPUS codec audio negotiation | **Not implemented**. Standard browser P2P WebRTC does not connect directly to WhatsApp clients. Requires Meta-compatible VoIP/WebRTC bridge. |
| **Call Termination** | Meta Graph API `POST /{phone_number_id}/calls/{call_id}/terminate` | Webhook termination received and parsed. Programmatic termination from dashboard is not implemented (returns HTTP 501). |

**Conclusion:** Real Meta WhatsApp Calling is **Partially Implemented (Signaling, Assignment, & History Logging Only)**. Real two-way VoIP audio media streaming is **not yet operational**.

---

## 8. Required Changes Before Frontend Integration

To align the frontend cleanly with the backend contracts without breaking boundaries or introducing mock workarounds:

1. **Configure Authenticated Socket.IO Handshake:**
   - In `cyber7-frontend/src/hook/useWhatsAppCall.ts`, retrieve the stored JWT via `getStoredToken()` and supply `auth: { accessToken: token }` during `io()` connection.
2. **Implement Notification ACK:**
   - When receiving `incoming-call` or `incoming-call-ended`, execute the incoming `ack` callback with `{ received: true }`.
3. **Notification Deduplication:**
   - Track received `notificationId`s in a local `Set` or `useRef` to discard duplicate incoming notifications from socket reconnects or retries.
4. **Implement Real First-Answer-Wins Protocol:**
   - When the user clicks "Accept", emit `answer-incoming-call` with `{ workspaceId, callId }`.
   - Listen for `call-accepted` to transition UI to `"connected"`.
   - Listen for `call-taken` to close ringing UI when another agent answers the call first.
5. **Listen for `incoming-call-ended`:**
   - Listen for `incoming-call-ended` to automatically close active or ringing call UI when Meta signals the call ended, was rejected, or missed.
6. **Correct REST API Routes in `callService`:**
   - Update `getCallLogs`, `startCall`, and `endCall` to use `/workspaces/${workspaceId}/calls/...` and eliminate unauthenticated fetch fallbacks.
7. **Remove Fake Auto-Connect & Mock Workarounds:**
   - Remove the 3.5s `setTimeout` auto-connect timer in `useWhatsAppCall.ts`.
   - Disable P2P WebRTC attempts that target unconfigured STUN servers when the backend explicitly rejects WebRTC signaling with `WEBRTC_SIGNALING_NOT_AVAILABLE`.
   - When user attempts an outgoing call, gracefully handle HTTP 501 `META_CALLING_NOT_IMPLEMENTED` with a clear user alert.

---

## 9. Tests Executed & Actual Results

| Check / Command | Working Directory | Command Executed | Actual Terminal Result | Exit Code |
| :--- | :--- | :--- | :--- | :---: |
| Backend TypeScript Check | `cyber7-backend` | `npm run typecheck` (`tsc --noEmit`) | Pass: 0 errors | `0` |
| Backend Build | `cyber7-backend` | `npm run build` (`tsc -p tsconfig.build.json`) | Pass: 0 errors | `0` |
| Unverified Items | — | Live Meta Webhook end-to-end delivery | Requires real Meta Developer App credentials and a registered WhatsApp calling phone number. | N/A |
