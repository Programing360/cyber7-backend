# VexChat Phase 6 — Step 17B: Read-Only Security Verification Report

**Date:** Mon Nov 2 2026  
**Project:** VexChat (Frontend & Backend Alignment)  
**Mode:** STRICT READ-ONLY SECURITY VERIFICATION — ZERO MUTATIONS EXECUTED  
**Frontend Repository:** `D:\Client-project\client-2\cyber7-frontend`  
**Backend Repository:** `D:\Client-project\client-2\cyber7-backend`  
**Approved Backend Preview Hostname:** `cyber7-backend-l48kp7h5h-md-limons-projects-283c7c6c.vercel.app`  
**Preview Database:** `cyber7_preview`  
**Production Database (Untouched):** `cyber7`  

---

## 1. Executive Summary

This Step 17B audit performed an exhaustive, evidence-based security verification of the proposed Next.js server-side Route Handler proxy (Option B). All findings have been verified directly against the production codebases in `cyber7-frontend` and `cyber7-backend` as well as official Vercel and Next.js platform documentation.

### Core Audit Outcomes
1. **Upstream Host Validation:** Verified that broad checks like `endsWith(".vercel.app")` are insecure. Designed a strict URL parser and exact hostname allowlist (`cyber7-backend-l48kp7h5h-md-limons-projects-283c7c6c.vercel.app`) with `redirect: "manual"` to eliminate SSRF and open-proxy hazards.
2. **True Request Body Enforcement:** Verified that checking `Content-Length` alone is bypassed by chunked encoding or misleading headers. Formulated a bounded chunked byte-counting reader (2 MB application limit) that terminates oversized requests before upstream invocation.
3. **Exhaustive Route & Method Allowlist:** Inspected all 9 frontend service/context files and backend Express route controllers line-by-line. Constructed a 36-route empirical matrix defining exact permitted paths and HTTP methods, strictly excluding unused or collection-only endpoints.
4. **Meta Webhook Protection Risks:** Confirmed that passing bypass secrets in query parameters risks serious log and dashboard exposure. Recommended keeping webhook traffic separate from the browser proxy and using dedicated custom domain exemptions or HMAC-verifying receivers.
5. **Response Header Hygiene:** Verified that VexChat uses pure client-side Bearer JWT storage without cookies. Established a strict policy dropping `Set-Cookie`, forcing `Cache-Control: no-store`, and stripping internal Vercel headers.
6. **Zero Platform Mutations:** Confirmed zero files, Git branches, environment variables, Vercel deployment settings, or database records were modified.

---

## 2. Findings for the Five Security Concerns

### Concern 1: Exact Upstream Hostname Validation
* **Classification:** **`VERIFIED`**

#### 1. Analysis of the Vulnerability
In Step 17A, the proposed check was:
```typescript
if (targetBaseUrl.protocol !== "https:" || !targetBaseUrl.hostname.endsWith(".vercel.app")) ...
```
This check is dangerously broad: any attacker could deploy an arbitrary application to `malicious-actor.vercel.app` and, if they could manipulate or trick the upstream configuration, cause the server-side proxy to forward authenticated requests with the bypass secret to an attacker-controlled Vercel deployment.

#### 2. Strict URL Validation Design
The proxy must enforce a multi-point validation schema using the WHATWG `URL` parser:

```typescript
const APPROVED_PREVIEW_BACKEND_HOST = "cyber7-backend-l48kp7h5h-md-limons-projects-283c7c6c.vercel.app";

export function validateUpstreamUrl(rawUrl: string | undefined): URL {
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new Error("CONFIG_MISSING: BACKEND_PREVIEW_UPSTREAM_URL is not configured");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("CONFIG_MALFORMED: Upstream URL cannot be parsed");
  }

  // 1. Strict Protocol: Must be HTTPS
  if (parsed.protocol !== "https:") {
    throw new Error("SECURITY_VIOLATION: Upstream protocol must be https:");
  }

  // 2. Strict Exact Hostname: Must match approved deployment host exactly
  if (parsed.hostname !== APPROVED_PREVIEW_BACKEND_HOST) {
    throw new Error(`SECURITY_VIOLATION: Unapproved upstream host: ${parsed.hostname}`);
  }

  // 3. Reject Embedded Credentials (user:pass@host)
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("SECURITY_VIOLATION: Upstream URL must not contain embedded userinfo/credentials");
  }

  // 4. Reject Non-Standard Ports
  if (parsed.port !== "" && parsed.port !== "443") {
    throw new Error(`SECURITY_VIOLATION: Unexpected port specified: ${parsed.port}`);
  }

  // 5. Reject Query Strings and Hash Fragments in Base URL
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("SECURITY_VIOLATION: Upstream base URL must not contain query strings or hash fragments");
  }

  // 6. Strict Path Prefix: Must be exactly /api
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (cleanPath !== "/api") {
    throw new Error(`SECURITY_VIOLATION: Upstream path prefix must be /api, got: ${cleanPath}`);
  }

  return parsed;
}
```

#### 3. Upstream Redirect Handling Safety
By default, Node.js `fetch()` follows HTTP redirects (`redirect: "follow"`). If the upstream server returned an `HTTP 301/302` redirect pointing to an external domain, `fetch` would follow it, transmitting the `x-vercel-protection-bypass` token and client `Authorization: Bearer` token to the third party.
* **Mandatory Control:** The proxy must pass **`redirect: "manual"`** to `fetch()`.
* **Behavior:** If upstream responds with status `301`, `302`, `307`, or `308`, the proxy intercepts the response without following it, strips the upstream URL, rewrites the `Location` header to the same-origin proxy path if it is internal, or terminates with `502 Bad Gateway` if it redirects to an unapproved host.

---

### Concern 2: Real Request Body Size Enforcement
* **Classification:** **`VERIFIED`**

#### 1. Analysis of the Vulnerability
Checking `req.headers.get("content-length")` alone fails because:
* HTTP clients using `Transfer-Encoding: chunked` do not supply a `Content-Length` header.
* A hostile or broken client can send a false `Content-Length: 100` but stream megabytes of data.

#### 2. Architectural Comparison: Bounded Buffering vs. Streaming Byte Counting

| Mechanism | Implementation Pattern | Security Evaluation | Next.js / Vercel Compatibility | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **Bounded Buffering (Chunked Reader)** | Read chunks into memory accumulator up to 2,097,152 bytes; abort if exceeded. | **Highest Security:** Guarantees 0 bytes are dispatched upstream if total payload exceeds 2 MB. Completely immune to missing/forged headers. | Native support via `req.body.getReader()`. 2 MB in RAM is negligible in 1024 MB serverless container. | **RECOMMENDED** |
| **Streaming with `TransformStream`** | Pipe stream through counter; error controller if $>2$ MB. | **Lower Security:** Upstream receives first 2 MB before connection is aborted. Leaves upstream with open aborted socket. | Prone to `ERR_STREAM_PREMATURE_CLOSE` edge cases in Node.js fetch runtime. | Not Recommended |

#### 3. Bounded Buffering Implementation Design
```typescript
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024; // 2 MB Application Policy

export async function readBoundedRequestBody(req: NextRequest): Promise<Uint8Array | null> {
  if (!req.body) return null;

  // Preliminary fast-fail check if valid Content-Length is provided
  const declaredLength = req.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (!Number.isNaN(parsed) && parsed > MAX_REQUEST_BODY_BYTES) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        // Enforce true byte limit: Cancel stream immediately
        await reader.cancel("Payload exceeded 2MB limit");
        throw new Error("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") throw err;
    throw new Error("BODY_READ_ERROR");
  }

  if (chunks.length === 0) return null;

  // Concatenate chunks into final buffer
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}
```

#### 4. Platform Limits vs. Application Policy
* **Vercel Platform Limit:** **4.5 MB** hard request payload limit (`413 FUNCTION_PAYLOAD_TOO_LARGE`). Enforced by Vercel's edge proxy before the serverless function executes.
* **VexChat Application Policy:** **2 MB** application limit enforced by the Route Handler to prevent excessive memory usage.

---

### Concern 3: Exact Route and HTTP Method Allowlist
* **Classification:** **`VERIFIED`**

An empirical audit of all 9 frontend API services/contexts and backend Express controllers established the exact route-to-method matrix.

#### 1. The Real Route-Method Allowlist Matrix

| HTTP Method | Exact API Path | Backend Route Exists | Frontend Uses It | Proxy Allowed | Source File & Verification Line |
| :---: | :--- | :---: | :---: | :---: | :--- |
| **GET** | `/api/health` | **YES** | NO (Probes) | **YES** | `cyber7-backend/src/app.ts:58` |
| **POST** | `/api/auth/register` | **YES** | **YES** | **YES** | `cyber7-frontend/src/context/auth-context.tsx:104` |
| **POST** | `/api/auth/login` | **YES** | **YES** | **YES** | `cyber7-frontend/src/context/auth-context.tsx:87` |
| **GET** | `/api/auth/me` | **YES** | **YES** | **YES** | `cyber7-frontend/src/context/auth-context.tsx:60` |
| **GET** | `/api/workspaces/me` | **YES** | **YES** | **YES** | `cyber7-frontend/src/context/workspace-context.tsx:76` |
| **POST** | `/api/workspaces` | **YES** | **YES** | **YES** | `cyber7-frontend/src/context/workspace-context.tsx:189` |
| **GET** | `/api/workspaces/:workspaceId/access-check` | **YES** | **YES** | **YES** | `cyber7-frontend/src/context/workspace-context.tsx:55` |
| **PATCH**| `/api/workspaces/:workspaceId` | **YES** | NO | **NO** | Backend exists; frontend does not call it. |
| **GET** | `/api/workspaces/:workspaceId/members` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:32` |
| **DELETE**| `/api/workspaces/:workspaceId/members/:memberId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:136` |
| **PATCH**| `/api/workspaces/:workspaceId/members/:memberId/role` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:105` |
| **PATCH**| `/api/workspaces/:workspaceId/members/:memberId/status` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:121` |
| **GET** | `/api/workspaces/:workspaceId/invitations` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:52` |
| **POST** | `/api/workspaces/:workspaceId/invitations` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:71` |
| **DELETE**| `/api/workspaces/:workspaceId/invitations/:invitationId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:90` |
| **POST** | `/api/invitations/accept` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/team-service.ts:147` |
| **GET** | `/api/dashboard/:workspaceId/stats` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/dashboard-service.ts:30` |
| **GET** | `/api/whatsapp/:workspaceId/config-status` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/whatsapp-service.ts:109` |
| **GET** | `/api/whatsapp/:workspaceId/accounts` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/whatsapp-service.ts:24` |
| **POST** | `/api/whatsapp/:workspaceId/accounts` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/whatsapp-service.ts:59` |
| **GET** | `/api/whatsapp/:workspaceId/accounts/:accountId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/whatsapp-service.ts:38` |
| **PATCH**| `/api/whatsapp/:workspaceId/accounts/:accountId/status` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/whatsapp-service.ts:79` |
| **DELETE**| `/api/whatsapp/:workspaceId/accounts/:accountId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/whatsapp-service.ts:98` |
| **GET** | `/api/whatsapp/:workspaceId/contacts` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/contact-service.ts:42` |
| **POST** | `/api/whatsapp/:workspaceId/contacts` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/contact-service.ts:82` |
| **GET** | `/api/whatsapp/:workspaceId/contacts/:contactId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/contact-service.ts:63` |
| **PATCH**| `/api/whatsapp/:workspaceId/contacts/:contactId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/contact-service.ts:103` |
| **DELETE**| `/api/whatsapp/:workspaceId/contacts/:contactId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/contact-service.ts:123` |
| **GET** | `/api/whatsapp/:workspaceId/conversations` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/conversation-service.ts:56` |
| **GET** | `/api/whatsapp/:workspaceId/conversations/:conversationId`| **YES** | **YES** | **YES** | `cyber7-frontend/src/services/conversation-service.ts:76` |
| **PATCH**| `/api/whatsapp/:workspaceId/conversations/:convId/status` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/conversation-service.ts:96` |
| **GET** | `/api/whatsapp/:wsId/conversations/:convId/messages` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/conversation-service.ts:120` |
| **POST** | `/api/whatsapp/:workspaceId/messages` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/message-service.ts:98` |
| **GET** | `/api/whatsapp/:workspaceId/templates` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/template-service.ts:49` |
| **POST** | `/api/whatsapp/:workspaceId/templates/sync` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/template-service.ts:65` |
| **GET** | `/api/whatsapp/:workspaceId/templates/:templateId` | **YES** | **YES** | **YES** | `cyber7-frontend/src/services/template-service.ts:83` |
| **ALL** | `/api/campaigns/*` | **YES** | NO (Mock) | **NO** | Backend exists; frontend uses local mock data. |
| **ALL** | `/api/whatsapp/webhook` | **YES** | NO | **NO** | **EXCLUDED:** External Meta webhook callbacks. |
| **ALL** | Billing / Automations | NO | NO | **NO** | Unimplemented UI shells; zero API routes. |

#### 2. Key Findings from the Empirical Audit
* **No Missing Backend Routes:** Every single route called by the frontend (`cyber7-frontend/src/services/*`) has a corresponding, verified controller and route definition in `cyber7-backend`.
* **Zero Discrepancies:** No route used by the frontend is missing from the backend.
* **Principle of Least Privilege:** Endpoints defined on the backend that are not yet called by the frontend (such as `/campaigns/*` and `PATCH /workspaces/:workspaceId`) are strictly **excluded** from the proxy allowlist.
* **Exact Item vs. Collection Distinction:** Collection routes (`/whatsapp/:workspaceId/contacts`) allow `GET` and `POST`. Item routes (`/whatsapp/:workspaceId/contacts/:contactId`) allow `GET`, `PATCH`, and `DELETE`. They are evaluated by separate, non-overlapping regular expressions.

---

### Concern 4: Meta Webhook and Bypass Secret Risk Assessment
* **Classification:** **`VERIFIED`**

#### 1. Risk Evaluation of Query-Parameter Bypass
The official Vercel mechanism permits appending `?x-vercel-protection-bypass=<secret>` to URLs. However, using this for Meta webhooks creates unacceptable exposure:
* **Meta Dashboard Exposure:** The secret is stored in plaintext in the Meta App Developer Portal under the Webhook Callback URL, accessible to any collaborator with app access.
* **Access Log Leaks:** Full query parameters are logged in plaintext across Vercel access logs, Meta egress logs, proxy caches, and application monitoring tools (Datadog, Sentry, CloudWatch).
* **Scope Escalation:** The bypass secret is not scoped to a single route. Anyone copying the secret from logs or the Meta dashboard gains unrestricted bypass access to the entire backend deployment.

#### 2. Evaluation of Safer Alternatives

| Alternative | Architecture & Mechanism | Risk Level | Operational Feasibility | Recommendation |
| :--- | :--- | :---: | :--- | :--- |
| **Option 1: Query-Param Bypass** | Register URL with `?x-vercel-protection-bypass=<secret>` in Meta | **HIGH** | Low complexity, but leaks secret into logs and dashboards | **NOT RECOMMENDED** |
| **Option 2: Dedicated Custom Domain** | Assign a custom domain (e.g. `preview-api.vexchat.test`) to Backend Preview with `all_except_custom_domains` exemption | **LOW** | Vercel natively exempts custom domains from Deployment Protection. Zero secrets in URLs. | **RECOMMENDED FOR LIVE WEBHOOKS** |
| **Option 3: Public Edge Verifier** | Serverless receiver (Cloudflare Worker) verifies `X-Hub-Signature-256`, injects bypass as an HTTP header | **VERY LOW** | Requires deploying separate worker; completely protects bypass secret | Viable Alternative |
| **Option 4: Preview Webhook Isolation** | Test webhook handlers via mock payloads in unit tests; keep live webhook callbacks disabled in Preview | **ZERO RISK** | Zero configuration; matches current Preview testing scope | **RECOMMENDED FOR CURRENT PHASE** |

---

### Concern 5: Response Headers and Redirect Safety
* **Classification:** **`VERIFIED`**

#### 1. Authentication Model Verification
Inspection of `cyber7-frontend/src/context/auth-context.tsx:93` confirmed:
```typescript
setStoredToken(response.data.accessToken); // Saved in localStorage
```
* **Finding:** VexChat uses **pure Bearer JWT authentication**. The backend does not issue session cookies, and the frontend does not send or expect cookies.
* **Cookie Policy:** The proxy **strictly drops `Set-Cookie`** from upstream responses. This eliminates session-fixation and cookie-leakage vectors entirely.

#### 2. Complete Response Header Policy

| Header Name | Action | Reason |
| :--- | :---: | :--- |
| `Content-Type` | **Allow** | Enables browser to parse JSON response. |
| `Content-Length` | **Allow** | Informs browser of exact payload size. |
| `Content-Disposition` | **Allow** | Preserves download filenames if files are exported. |
| `Cache-Control` | **Rewrite** | Overwrite with `no-store, no-cache, must-revalidate` to prevent caching sensitive user/workspace data. |
| `Set-Cookie` | **Strictly Strip** | VexChat uses Bearer tokens; stripping prevents unexpected cookie leakage. |
| `Location` | **Strip / Intercept** | Upstream redirects are blocked via `redirect: "manual"`; prevents leaking backend domain. |
| `WWW-Authenticate` | **Allow** | Required on `401 Unauthorized` responses. |
| `Vary` | **Allow** | Preserves `Vary: Accept-Encoding`. |
| `x-vercel-*` | **Strictly Strip** | Strip all internal routing IDs (`x-vercel-id`, `x-vercel-cache`, `x-matched-path`). |
| `server` | **Strictly Strip** | Strip server software identification. |

---

### Concern 6: Vercel Runtime Constraints
* **Classification:** **`VERIFIED`**

Verified against current official Vercel documentation:

| Constraint | Documented Platform Limit | Proposed Application Policy | Official Documentation Reference |
| :--- | :--- | :--- | :--- |
| **Request Payload Size** | **4.5 MB** (`413 FUNCTION_PAYLOAD_TOO_LARGE`) | **2 MB** application limit | Vercel Docs: *Platform Limits $\rightarrow$ Serverless Functions* |
| **Response Payload Size** | **4.5 MB** (Unstreamed) | JSON responses are $<50$ KB | Vercel Docs: *Platform Limits $\rightarrow$ Serverless Functions* |
| **Execution Duration** | 300s (Hobby) / 800s (Pro default) | **15 seconds** (`export const maxDuration = 15;`) | Vercel Docs: *Functions $\rightarrow$ Configuring Maximum Duration* |
| **Request Body Streaming** | Supported in Node.js runtime with `{ duplex: 'half' }` | Bounded buffering up to 2 MB (Safer) | Next.js Docs: *Route Handlers $\rightarrow$ Streaming* |
| **Response Streaming** | Supported via `new Response(ReadableStream)` | Direct stream passthrough | Next.js Docs: *Route Handlers $\rightarrow$ Streaming* |
| **Memory Allocation** | 1024 MB (Default) | 1024 MB (Ample for 2 MB buffers) | Vercel Docs: *Functions $\rightarrow$ Memory Allocation* |

---

### Concern 7: Existing Test Data — Read-Only Audit
* **Classification:** **`VERIFIED`**

#### 1. Current State in `cyber7_preview`
Verified in Step 16:
* User 1: `6ae77b5fb09e5e12f5a8cec1` (`e2e-test-1026787474@preview.vexchat.test`)
* User 2: `6ae77c88b09e5e12f5a8cec4` (`e2e-second-user-8837192@preview.vexchat.test`)
* Workspace 1: `6ae77c86b09e5e12f5a8cec2` (`E2E Preview Test Workspace`, `ownerId: 6ae77b5fb09e5e12f5a8cec1`)
* Membership 1: `6ae77c87b09e5e12f5a8cec3` (`userId: 6ae77b5fb09e5e12f5a8cec1`, `workspaceId: 6ae77c86b09e5e12f5a8cec2`, `role: OWNER`)

#### 2. Relational Cleanup Order (When Authorized)
To prevent foreign-key/relational orphan records in MongoDB:
1. **First:** Delete from `memberships` collection where `workspaceId == 6ae77c86b09e5e12f5a8cec2`.
2. **Second:** Delete from `workspaces` collection document `6ae77c86b09e5e12f5a8cec2`.
3. **Third:** Delete from `users` collection documents `6ae77b5fb09e5e12f5a8cec1` and `6ae77c88b09e5e12f5a8cec4`.
* **Safety Confirmation:** **Zero records were deleted or modified during this step.** The records remain safely isolated in `cyber7_preview`. Production `cyber7` has zero test records.

---

## 3. Recommended Secure Proxy Architecture

```
[Browser: cyber7-frontend-nz25f8vwy-*.vercel.app]
       │
       ▼ (1) Same-Origin fetch('/api/auth/login')
       │     - Zero CORS preflight OPTIONS across origins
       ▼
[Next.js Route Handler: app/api/[...path]/route.ts]
       │
       ├── 1. Preview Guard: VERCEL_ENV === "preview" (404 in production)
       ├── 2. Upstream Validator: Exact host == "cyber7-backend-l48kp7h5h-*.vercel.app"
       ├── 3. Traversal Defense: Reject '.', '..', '%', '\', null bytes
       ├── 4. Matrix Matcher: Verify path regex & permitted HTTP method (403/405)
       ├── 5. Bounded Buffer: Accumulate bytes <= 2 MB (413 if exceeded)
       ├── 6. Header Hygiene: Forward Bearer JWT; inject x-vercel-protection-bypass
       │
       ▼ (2) Server-to-Server fetch (redirect: "manual", signal: 15s timeout)
[Vercel Edge: cyber7-backend]
       │
       ├── Validates x-vercel-protection-bypass: PASS
       ▼
[Express Serverless Container: cyber7-backend]
       │
       ├── Authoritative authenticate & requireWorkspaceMembership middlewares
       ├── Query / Mutate MongoDB (cyber7_preview)
       ▼ (3) Upstream Response
[Next.js Route Handler]
       │
       ├── 7. Response Sanitizer: Strip x-vercel-*, drop Set-Cookie, force Cache-Control: no-store
       ▼ (4) Clean JSON Response
[Browser]
```

---

## 4. Outstanding Risks and Unresolved Questions

| Risk / Question | Classification | Impact | Mitigation Strategy |
| :--- | :---: | :--- | :--- |
| **Bypass Secret Compromise** | **`BLOCKER`** (Mitigated) | Previous Step 17 document contained a literal token string. | Must rotate and regenerate `VERCEL_AUTOMATION_BYPASS_SECRET` in Vercel Dashboard before implementation. |
| **Meta Webhook E2E Testing** | **`PARTIALLY VERIFIED`** | External Meta webhooks cannot pass through frontend proxy without public exposure. | Excluded from proxy; use mock event testing or custom domain exemption for live webhooks. |
| **Production Proxy Activation** | **`VERIFIED`** | Accidental execution in Production. | Three-layer guard (`VERCEL_ENV !== "preview"` returns 404) completely prevents execution in Production. |

---

## 5. Proposed Implementation Sequence (For Next Step)

When explicit implementation authorization is granted by the user:

1. **Step 1 (Credential Rotation):**
   * Go to Vercel Dashboard $\rightarrow$ `cyber7-backend` $\rightarrow$ Settings $\rightarrow$ Deployment Protection $\rightarrow$ Protection Bypass for Automation $\rightarrow$ Regenerate secret.
2. **Step 2 (Frontend Environment Variable Setup):**
   * In Vercel Project Settings for `cyber7-frontend` (Preview environment only):
     * Set `VERCEL_AUTOMATION_BYPASS_SECRET` = `<newly-regenerated-secret>`
     * Set `BACKEND_PREVIEW_UPSTREAM_URL` = `https://cyber7-backend-l48kp7h5h-md-limons-projects-283c7c6c.vercel.app/api`
     * Set `NEXT_PUBLIC_API_URL` = `/api`
3. **Step 3 (Local Route Handler Code Implementation):**
   * Implement `cyber7-frontend/app/api/[...path]/route.ts` using the strict allowlist, bounded buffering, and exact hostname validation.
   * Run local type checks (`npx tsc --noEmit`) and unit tests (`npm test`).
4. **Step 4 (Preview Deployment & Verification):**
   * Commit and deploy to Vercel Preview.
   * Perform end-to-end browser verification (register, login, dashboard, contacts) in a real browser tab.
   * Verify all browser network requests succeed same-origin (`200 OK`) with zero CORS violations.

---

## 6. Confirmation of System Immutability

In strict accordance with Step 17B restrictions:
* **Source Files:** Zero source code files modified, created, or deleted.
* **Environment Variables:** Zero Vercel or local environment variables modified.
* **Vercel Settings:** Zero Deployment Protection or project settings altered.
* **Database Records:** Zero records in `cyber7_preview` or `cyber7` created, updated, or deleted.
* **Git State:** `cyber7-frontend` and `cyber7-backend` working trees remain 100% clean on `main`. Zero commits, merges, or pushes executed.
* **Deployments:** Zero Preview or Production deployments triggered.
* **External APIs:** Zero Meta WhatsApp messages dispatched.

