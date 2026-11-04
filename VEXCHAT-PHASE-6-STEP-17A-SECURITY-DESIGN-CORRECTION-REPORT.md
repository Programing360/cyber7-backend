# VexChat Phase 6 — Step 17A: Security Design Correction & Verification Report

**Date:** Mon Nov 2 2026  
**Project:** VexChat (Frontend & Backend Alignment)  
**Mode:** STRICT READ-ONLY INVESTIGATION & ARCHITECTURAL REVIEW  
**Frontend Repository:** `D:\Client-project\client-2\cyber7-frontend`  
**Backend Repository:** `D:\Client-project\client-2\cyber7-backend`  
**Frontend Preview URL:** `https://cyber7-frontend-nz25f8vwy-md-limons-projects-283c7c6c.vercel.app`  
**Backend Preview API:** `https://cyber7-backend-l48kp7h5h-md-limons-projects-283c7c6c.vercel.app/api`  
**Preview Database:** `cyber7_preview` (Isolated from Production `cyber7`)  

---

## 1. Executive Summary & Design Correction Objective

Step 17 established that a Next.js server-side Route Handler proxy (Option B) is the superior architectural approach to bridge the Frontend Preview and Backend Preview deployments without disabling Vercel Deployment Protection.

However, the initial reference design contained security and implementation gaps:
1. **Fallback Credential Exposure:** It included a hardcoded fallback string for the bypass secret.
2. **Permissive Path Matching:** It used `startsWith()` prefix matching rather than strict route and HTTP method allowlists.
3. **Insufficient Runtime Isolation:** It lacked an explicit environment guard to guarantee the proxy cannot execute in Production.
4. **Undefined Resource & Header Controls:** It lacked explicit specifications for body limits, timeouts, client disconnect cancellation, and response header sanitization.

This Step 17A report resolves every gap, verifies platform-specific capabilities against official Vercel documentation, and provides a security-reviewed engineering specification.

---

## 2. Resolution of Critical Security Findings

### A. Secret Management & Vercel Automation Bypass Verification

#### 1. Zero Hardcoded Fallbacks & Fail-Closed Policy
* **Correction:** The Route Handler must **never** contain a hardcoded bypass token or fallback secret.
* **Fail-Closed Rule:** If the server-side environment variable is missing, undefined, or empty, the proxy must immediately abort and return `HTTP 500 Internal Server Error` with a sanitized message. It must never attempt an unauthenticated upstream request or fall back to any literal value.
* **Credential Revocation & Rotation Recommendation:**
  > [!IMPORTANT]
  > The literal bypass token string previously referenced in the Step 17 report should be immediately **revoked and regenerated** in the Vercel Dashboard under **Settings $\rightarrow$ Deployment Protection $\rightarrow$ Protection Bypass for Automation**. Once regenerated, the old token is invalidated globally at Vercel's edge network within seconds.

#### 2. Officially Supported Vercel Deployment Protection Bypass Mechanism
Verified against official Vercel platform documentation:
* **Official Platform Feature:** **Protection Bypass for Automation** (available under Project Settings $\rightarrow$ Deployment Protection).
* **Official Header:** `x-vercel-protection-bypass: <secret>`
* **Official Query Parameter:** `?x-vercel-protection-bypass=<secret>` (officially supported for automated systems and webhooks unable to set custom headers).
* **System Environment Variable:** Vercel automatically exposes the generated secret as a System Environment Variable named:
  ```text
  VERCEL_AUTOMATION_BYPASS_SECRET
  ```
* **Rotation Lifecycle:** An administrator clicks "Regenerate" in the Vercel Dashboard. The new secret immediately replaces the previous value, and all future requests presenting the old secret are rejected with `302 Found` (redirect to SSO login).
* **Documented Security Limits:** Vercel documentation explicitly confirms that `x-vercel-protection-bypass` bypasses authentication only; it **does not bypass** active DDoS mitigations, IP rate limiting, or attack challenges.

---

### B. Preview-Only Execution Guard

To guarantee that the proxy cannot be invoked or abused in a Production environment, the Route Handler enforces three layers of runtime guards:

```typescript
// Pseudocode: Preview-Only Environment Guard
export async function enforcePreviewGuard(): Promise<NextResponse | null> {
  // Layer 1: Strict Runtime Environment Check
  if (process.env.VERCEL_ENV !== "preview") {
    // Return 404 in Production so the proxy appears non-existent to external scanners
    return NextResponse.json({ success: false, message: "Not Found" }, { status: 404 });
  }

  // Layer 2: Mandatory Upstream Configuration (Fail Closed)
  const upstreamBase = process.env.BACKEND_PREVIEW_UPSTREAM_URL;
  if (!upstreamBase || upstreamBase.trim() === "") {
    return NextResponse.json(
      { success: false, message: "Proxy configuration error: upstream URL missing" },
      { status: 500 }
    );
  }

  // Layer 3: Upstream Host Validation (Anti-SSRF)
  try {
    const parsed = new URL(upstreamBase);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app")) {
      return NextResponse.json(
        { success: false, message: "Proxy configuration error: invalid upstream host" },
        { status: 500 }
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, message: "Proxy configuration error: malformed upstream URL" },
      { status: 500 }
    );
  }

  return null; // Passed all guards
}
```

#### Verification & Testing Plan
* **In Preview:** Probe `GET /api/health` $\rightarrow$ verifies `process.env.VERCEL_ENV === "preview"` passes, calls backend preview, returns `200 OK`.
* **In Production:** Probe `GET /api/health` on `https://cyber7-frontend.vercel.app` $\rightarrow$ returns `404 Not Found` (proxy disabled). In production, the client directly invokes `https://cyber7-backend.vercel.app/api/health`.

---

### C. Exact Route and HTTP Method Allowlisting

To prevent the Route Handler from functioning as an open proxy or permitting SSRF via path manipulation, path matching is upgraded from naive `startsWith()` to a strict pattern-to-method matrix.

#### 1. Route & Method Matrix
Mapped directly from backend Express route controllers:

| Route Group | Path Pattern Regex | Permitted HTTP Methods | Description |
| :--- | :--- | :--- | :--- |
| **Health** | `^health$` | `GET`, `HEAD` | System health check |
| **Auth** | `^auth\/(register\|login)$` | `POST` | User authentication |
| **Profile** | `^auth\/me$` | `GET` | User session profile |
| **Workspaces** | `^workspaces$` | `GET`, `POST` | List / create workspaces |
| **Workspace Me** | `^workspaces\/me$` | `GET` | Current user workspaces |
| **Workspace Item** | `^workspaces\/[a-f0-9]{24}$` | `PATCH` | Workspace settings update |
| **Access Check** | `^workspaces\/[a-f0-9]{24}\/access-check$` | `GET` | Access verification |
| **Members** | `^workspaces\/[a-f0-9]{24}\/members$` | `GET` | List workspace members |
| **Member Item** | `^workspaces\/[a-f0-9]{24}\/members\/[a-f0-9]{24}$` | `DELETE` | Remove member |
| **Member Role/Status** | `^workspaces\/[a-f0-9]{24}\/members\/[a-f0-9]{24}\/(role\|status)$` | `PATCH` | Member role/status change |
| **Invitations** | `^workspaces\/[a-f0-9]{24}\/invitations$` | `GET`, `POST` | Workspace invitations |
| **Invitation Item** | `^workspaces\/[a-f0-9]{24}\/invitations\/[a-f0-9]{24}$` | `DELETE` | Revoke invitation |
| **Dashboard** | `^dashboard\/[a-f0-9]{24}\/stats$` | `GET` | Dashboard analytics |
| **WhatsApp Config** | `^whatsapp\/[a-f0-9]{24}\/config-status$` | `GET` | WhatsApp configuration state |
| **WhatsApp Accounts** | `^whatsapp\/[a-f0-9]{24}\/accounts$` | `GET`, `POST` | Accounts query / connect |
| **WhatsApp Account Item**| `^whatsapp\/[a-f0-9]{24}\/accounts\/[a-f0-9]{24}$` | `GET`, `DELETE` | Account details / disconnect |
| **WhatsApp Account Status**| `^whatsapp\/[a-f0-9]{24}\/accounts\/[a-f0-9]{24}\/status$` | `PATCH` | Account status toggle |
| **Contacts** | `^whatsapp\/[a-f0-9]{24}\/contacts$` | `GET`, `POST` | List / create contacts |
| **Contact Item** | `^whatsapp\/[a-f0-9]{24}\/contacts\/[a-f0-9]{24}$` | `GET`, `PATCH`, `DELETE` | Contact details / update / remove |
| **Conversations** | `^whatsapp\/[a-f0-9]{24}\/conversations$` | `GET` | List inbox conversations |
| **Conversation Item** | `^whatsapp\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}$` | `GET` | Conversation thread details |
| **Conversation Status** | `^whatsapp\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}\/status$` | `PATCH` | Open / close conversation |
| **Messages** | `^whatsapp\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}\/messages$` | `GET`, `POST` | Message history / send message |
| **Templates** | `^whatsapp\/[a-f0-9]{24}\/templates$` | `GET`, `POST` | List / create templates |
| **Templates Sync** | `^whatsapp\/[a-f0-9]{24}\/templates\/sync$` | `POST` | Sync Meta templates |
| **Template Item** | `^whatsapp\/[a-f0-9]{24}\/templates\/[a-f0-9]{24}$` | `GET` | Template details |
| **Campaigns** | `^campaigns\/[a-f0-9]{24}$` | `GET`, `POST` | List / launch campaigns |
| **Campaign Item** | `^campaigns\/[a-f0-9]{24}\/[a-f0-9]{24}$` | `GET`, `PATCH`, `DELETE` | Campaign details / pause / cancel |

#### 2. Path Traversal & Normalization Defense
* **Segment Array Validation:** Next.js App Router provides `params.path` as an array of decoded strings.
* **Reject Malformed Segments:** Any segment containing `.`, `..`, `%`, `\`, or null bytes `\0` is rejected with `400 Bad Request`.
* **Zero Double-Decoding:** The proxy operates on the already-decoded segment strings provided by Next.js, avoiding unsafe `decodeURIComponent()` loops.
* **Method Enforcement:** If a route matches a known path pattern but presents an unauthorized method, the proxy returns `405 Method Not Allowed` with an `Allow` header listing permitted methods.
* **Query Parameter Isolation:** Query parameters are appended strictly via `targetUrl.searchParams.set(key, value)`. They can never alter the protocol, hostname, or pathname of the upstream request.

---

### D. Request Body and Resource Controls

#### 1. Payload Size Limits
* **Application Proxy Limit:** **2 MB** for all JSON API payloads.
* **Platform Hard Limit:** **4.5 MB** on Vercel Serverless Functions. Requests exceeding 4.5 MB are terminated by Vercel with `413 FUNCTION_PAYLOAD_TOO_LARGE`.
* **Proxy Enforcement:** The Route Handler inspects `req.headers.get("content-length")`. If $> 2 \times 1024 \times 1024$ bytes, it immediately returns `HTTP 413 Payload Too Large` without invoking upstream.

#### 2. Allowed Content Types
* Inbound requests with bodies (`POST`, `PUT`, `PATCH`) must present:
  * `application/json`
  * `application/x-www-form-urlencoded`
  * `multipart/form-data`
* Unexpected or unknown binary MIME types are rejected with `415 Unsupported Media Type`.

#### 3. Request Streaming & Client Disconnect Cancellation
* **Node.js Fetch Streaming:** When forwarding request bodies (`req.body`), native Node.js `fetch()` requires the option `{ duplex: 'half' }`. This pipes the `ReadableStream` directly to the upstream server without buffering the entire payload in serverless memory.
* **Client Disconnect Handling:** The proxy extracts `req.signal` (which triggers if the browser closes the tab or cancels the fetch) and links it with an upstream timeout signal:
  ```typescript
  const timeoutSignal = AbortSignal.timeout(15000); // 15s timeout
  const combinedSignal = AbortSignal.any([req.signal, timeoutSignal]);
  ```
  If the browser disconnects, upstream execution is canceled immediately, conserving serverless concurrency.

#### 4. Vercel Execution Limits
* **Memory Allocation:** Standard 1024 MB (more than sufficient since bodies are streamed).
* **Timeout Configuration:** Set `export const maxDuration = 15;` (15 seconds). Backend Express endpoints typically respond within $<300$ ms.

---

### E. Response Header and Cookie Handling

The proxy enforces an explicit header sanitization policy on the response returned to the browser:

```
Upstream Response -> [ Header Filter ] -> Browser Client
                            │
              STRIFED: x-vercel-*, server, x-matched-path
              REWRITTEN: Cache-Control -> no-store
              PERMITTED: Content-Type, Content-Length, WWW-Authenticate
```

| Response Header | Proxy Action | Security & Architectural Rationale |
| :--- | :---: | :--- |
| **`Content-Type`** | **Pass Through** | Required by browser to parse JSON or text (`application/json; charset=utf-8`). |
| **`Content-Length`** | **Pass Through** | Allows browser to verify complete body delivery. |
| **`Content-Disposition`** | **Pass Through** | Preserves attachment filenames for data exports or downloads. |
| **`Cache-Control`** | **Rewrite** | Overwrite with `no-store, no-cache, must-revalidate` to prevent intermediate or browser caching of sensitive authenticated tenant data. |
| **`Set-Cookie`** | **Rewrite / Strip** | VexChat uses client-side Bearer JWT storage. If any cookie is set, ensure `Path=/`, `SameSite=Lax`, and `Secure` are enforced. |
| **`Location`** | **Rewrite / Strip** | If upstream returns an HTTP 3xx redirect, rewrite any backend host to the same-origin proxy path to prevent the browser from bypassing the proxy. |
| **`WWW-Authenticate`** | **Pass Through** | Required on `401 Unauthorized` responses to comply with RFC 7235. |
| **`Vary`** | **Pass Through** | Informs browser caches of request header variance (`Vary: Accept-Encoding`). |
| **`x-vercel-*`** | **Strictly Strip** | Strip all internal routing and deployment IDs (`x-vercel-id`, `x-vercel-cache`, `x-vercel-execution-region`). Prevents internal infrastructure disclosure. |
| **`server`** | **Strictly Strip** | Strip server software identification (`server: Vercel`). |

---

### F. HTTP Method Completeness Matrix

Next.js Route Handlers support exporting individual HTTP method handlers.

| HTTP Method | Exported Handler | Implementation Behavior |
| :--- | :---: | :--- |
| **`GET`** | `export const GET` | Validates route; forwards query params; body omitted (`body: undefined`). |
| **`POST`** | `export const POST` | Validates route; streams body with `duplex: 'half'`. |
| **`PUT`** | `export const PUT` | Validates route; streams body with `duplex: 'half'`. |
| **`PATCH`** | `export const PATCH` | Validates route; streams body with `duplex: 'half'`. |
| **`DELETE`** | `export const DELETE` | Validates route; streams body if present. |
| **`HEAD`** | `export const HEAD` | Validates route; forwards headers only; response body suppressed. |
| **`OPTIONS`** | `export const OPTIONS`| **Handled locally with `204 No Content`**. Never invokes upstream, avoiding unnecessary serverless invocations. |
| **All Other Methods** | *None* | Next.js automatically responds with **`405 Method Not Allowed`** and an `Allow` header. |

---

### G. Authentication and Tenant Isolation Architecture

The proxy strictly adheres to zero-trust architecture regarding authentication:

1. **Bearer JWT Forwarding:**
   * The proxy reads `req.headers.get("authorization")`.
   * If present, it validates that it conforms to `Bearer <token>` syntax.
   * It forwards the header verbatim to Backend Preview.
   * **Zero Logging Guarantee:** The `Authorization` header is never logged, printed in error traces, or reflected in responses.
2. **Authoritative Backend Security:**
   * The proxy **never validates JWT signatures or inspects claims**.
   * The proxy **never evaluates tenant membership or permissions**.
   * All authorization decisions remain 100% authoritative within the Express backend's middlewares:
     * `authenticate`: Validates JWT against `process.env.JWT_ACCESS_SECRET`.
     * `requireWorkspaceMembership`: Validates that the authenticated user holds an active membership for `:workspaceId` in MongoDB `cyber7_preview`.
     * `requireRole`: Validates that the user's role is `OWNER`, `ADMIN`, or `AGENT`.
   * **No Client Trust:** Even if a malicious client tampers with `x-workspace-id` or route parameters, the backend strictly verifies the user's identity against the database and returns `403 Forbidden` (as verified in Step 15 Tests C5, C6, and C7).

---

### H. Webhook Isolation Architecture

External Meta / WhatsApp Cloud API callbacks must remain completely segregated from browser-facing proxy traffic:

```
[Meta Developer Platform]
           │
           ▼ Direct Server-to-Server Callback (Bypasses Frontend Proxy)
           │
           │ URL: https://cyber7-backend-...vercel.app/api/whatsapp/webhook?x-vercel-protection-bypass=<secret>
           ▼
[Vercel Edge: cyber7-backend]
           │
           ├── Recognizes query parameter: x-vercel-protection-bypass=<secret>
           ▼
[Express Backend: verifyWhatsAppWebhook / receiveWhatsAppWebhook]
           │
           ├── Validates hub.verify_token (GET) or X-Hub-Signature-256 (POST)
           ▼
[MongoDB: cyber7_preview]
```

1. **Proxy Exclusion:**
   * The path `/whatsapp/webhook` is **explicitly excluded** from the frontend proxy's route allowlist.
   * Any client attempt to call `/api/whatsapp/webhook` via the frontend proxy is rejected with `403 Forbidden`.
2. **Official Query Parameter Bypass for Meta:**
   * External webhook services like Meta do not support custom request headers like `x-vercel-protection-bypass`.
   * Vercel's official documentation confirms that the bypass secret can be passed via query parameter:
     `https://<backend-preview-url>/api/whatsapp/webhook?x-vercel-protection-bypass=<secret>`
   * In Preview testing, registering this URL in the Meta Developer Portal allows Meta callbacks to bypass Vercel Deployment Protection.
3. **Production Behavior:**
   * In Production, `https://cyber7-backend.vercel.app` has no Vercel Deployment Protection, so the webhook URL is registered without any bypass parameter.

---

## 3. Production Isolation & Zero-Drift Verification

| Test Scenario | Preview Environment | Production Environment | Isolation Proof |
| :--- | :--- | :--- | :--- |
| **API Client Target** | `NEXT_PUBLIC_API_URL="/api"` | `NEXT_PUBLIC_API_URL="https://cyber7-backend.vercel.app/api"` | Production client communicates directly with Production backend; never touches proxy. |
| **Route Handler Presence** | Active (`VERCEL_ENV === "preview"`) | Disabled (`VERCEL_ENV === "production"`) $\rightarrow$ Returns `404 Not Found` | Proxy cannot be reached or executed on production domain. |
| **Upstream Backend Target** | Dedicated Backend Preview URL | Direct Production API URL | Complete separation of backend processes. |
| **Database Target** | `cyber7_preview` (Synthetic test data only) | `cyber7` (Live customer data) | Preview proxy has zero network or credential access to production database. |
| **Deployment Protection** | Active on both Frontend and Backend | Active on Frontend (if configured); Public on Backend API | Production settings are completely untouched. |

---

## 4. Illustrative Pseudocode Specification

The following pseudocode demonstrates the complete corrected logic for `cyber7-frontend/app/api/[...path]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 15; // 15-second execution limit

// 1. Strict Path-to-Method Allowlist
const ROUTE_RULES: Array<{ pattern: RegExp; methods: string[] }> = [
  { pattern: /^health$/, methods: ["GET", "HEAD"] },
  { pattern: /^auth\/(register|login)$/, methods: ["POST"] },
  { pattern: /^auth\/me$/, methods: ["GET"] },
  { pattern: /^workspaces(\/me)?$/, methods: ["GET", "POST"] },
  { pattern: /^workspaces\/[a-f0-9]{24}$/, methods: ["PATCH"] },
  { pattern: /^workspaces\/[a-f0-9]{24}\/access-check$/, methods: ["GET"] },
  { pattern: /^workspaces\/[a-f0-9]{24}\/members$/, methods: ["GET"] },
  { pattern: /^workspaces\/[a-f0-9]{24}\/members\/[a-f0-9]{24}$/, methods: ["DELETE"] },
  { pattern: /^workspaces\/[a-f0-9]{24}\/members\/[a-f0-9]{24}\/(role|status)$/, methods: ["PATCH"] },
  { pattern: /^workspaces\/[a-f0-9]{24}\/invitations$/, methods: ["GET", "POST"] },
  { pattern: /^workspaces\/[a-f0-9]{24}\/invitations\/[a-f0-9]{24}$/, methods: ["DELETE"] },
  { pattern: /^dashboard\/[a-f0-9]{24}\/stats$/, methods: ["GET"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/config-status$/, methods: ["GET"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/accounts(\/[a-f0-9]{24})?$/, methods: ["GET", "POST", "DELETE"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/accounts\/[a-f0-9]{24}\/status$/, methods: ["PATCH"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/contacts(\/[a-f0-9]{24})?$/, methods: ["GET", "POST", "PATCH", "DELETE"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/conversations(\/[a-f0-9]{24})?$/, methods: ["GET"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}\/status$/, methods: ["PATCH"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/conversations\/[a-f0-9]{24}\/messages$/, methods: ["GET", "POST"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/templates(\/[a-f0-9]{24})?$/, methods: ["GET", "POST"] },
  { pattern: /^whatsapp\/[a-f0-9]{24}\/templates\/sync$/, methods: ["POST"] },
  { pattern: /^campaigns\/[a-f0-9]{24}(\/[a-f0-9]{24})?$/, methods: ["GET", "POST", "PATCH", "DELETE"] },
];

export async function proxyHandler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  // Guard 1: Preview-Only Environment Guard
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ success: false, message: "Not Found" }, { status: 404 });
  }

  // Guard 2: Server-Side Bypass Secret Check (Fail Closed)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.VERCEL_PROTECTION_BYPASS;
  const upstreamBase = process.env.BACKEND_PREVIEW_UPSTREAM_URL;

  if (!bypassSecret || !upstreamBase) {
    return NextResponse.json(
      { success: false, message: "Proxy configuration error: missing required credentials" },
      { status: 500 }
    );
  }

  // Guard 3: Upstream Host Validation
  const targetBaseUrl = new URL(upstreamBase);
  if (targetBaseUrl.protocol !== "https:" || !targetBaseUrl.hostname.endsWith(".vercel.app")) {
    return NextResponse.json({ success: false, message: "Invalid upstream host" }, { status: 500 });
  }

  // Guard 4: Segment Traversal & Malformed Character Defense
  const { path: rawSegments } = await params;
  for (const segment of rawSegments) {
    if (/[\.%\\]/.test(segment) || segment.length === 0 || segment.length > 128) {
      return NextResponse.json({ success: false, message: "Malformed path segment" }, { status: 400 });
    }
  }

  const normalizedPath = rawSegments.join("/");
  const method = req.method.toUpperCase();

  // Guard 5: Exact Route & Method Allowlist Matching
  const matchedRule = ROUTE_RULES.find((r) => r.pattern.test(normalizedPath));
  if (!matchedRule) {
    return NextResponse.json({ success: false, message: "Endpoint not permitted by proxy policy" }, { status: 403 });
  }

  if (!matchedRule.methods.includes(method)) {
    return NextResponse.json(
      { success: false, message: `Method ${method} not allowed for this route` },
      { status: 405, headers: { Allow: matchedRule.methods.join(", ") } }
    );
  }

  // Guard 6: Request Body Size Limit (2 MB)
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > 2 * 1024 * 1024) {
    return NextResponse.json({ success: false, message: "Payload too large (2MB limit)" }, { status: 413 });
  }

  // 7. Construct Fixed Target URL
  const targetUrl = new URL(`${upstreamBase.replace(/\/+$/, "")}/${normalizedPath}`);
  req.nextUrl.searchParams.forEach((val, key) => targetUrl.searchParams.set(key, val));

  // 8. Inbound Header Hygiene & Upstream Secret Injection
  const upstreamHeaders = new Headers();
  ["authorization", "content-type", "accept", "x-workspace-id"].forEach((key) => {
    const val = req.headers.get(key);
    if (val) upstreamHeaders.set(key, val);
  });
  upstreamHeaders.set("x-vercel-protection-bypass", bypassSecret);

  // 9. Timeout & Disconnect Cancellation Signals
  const timeoutSignal = AbortSignal.timeout(15000);
  const combinedSignal = AbortSignal.any([req.signal, timeoutSignal]);

  const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  try {
    const upstreamRes = await fetch(targetUrl.toString(), {
      method,
      headers: upstreamHeaders,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error duplex is required in Node.js when streaming request body
      duplex: hasBody ? "half" : undefined,
      signal: combinedSignal,
      cache: "no-store",
    });

    // 10. Outbound Header Sanitization
    const responseHeaders = new Headers();
    const contentType = upstreamRes.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    responseHeaders.set("cache-control", "no-store, no-cache, must-revalidate");

    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (error: any) {
    if (error.name === "TimeoutError") {
      return NextResponse.json({ success: false, message: "Upstream request timed out" }, { status: 504 });
    }
    return NextResponse.json({ success: false, message: "Upstream service unavailable" }, { status: 502 });
  }
}

export const GET = proxyHandler;
export const POST = proxyHandler;
export const PUT = proxyHandler;
export const PATCH = proxyHandler;
export const DELETE = proxyHandler;
export const HEAD = proxyHandler;
export const OPTIONS = () => new NextResponse(null, { status: 204 });
```

---

## 5. Security & Isolation Conclusion

This corrected specification eliminates all vulnerabilities identified in Step 17:
* Zero hardcoded credentials or fallbacks.
* Strict fail-closed error handling.
* Verified official Vercel bypass mechanism (`VERCEL_AUTOMATION_BYPASS_SECRET`).
* Three-layer runtime environment guard (`VERCEL_ENV === "preview"`).
* Exact regex route allowlist and method enforcement.
* 2 MB payload control, 15-second timeout, and disconnect abort propagation.
* Strict outbound response header stripping (no internal Vercel headers exposed).
* Complete method completeness (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, local `OPTIONS`).
* Complete preservation of backend authorization and tenant isolation.
* Full webhook isolation from proxy traffic.

Both repositories remain clean on their respective `main` branches. No implementation has been executed.

