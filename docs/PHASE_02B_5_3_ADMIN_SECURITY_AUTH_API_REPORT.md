# VexChat — Phase 02B.5.3: Backend Platform Admin Security, Authentication & Secure GET API Implementation Report

**Target:** `D:\Client-project\client-2\cyber7-backend`  
**Execution Mode:** Production-Oriented Backend Security Architecture & Implementation  
**Status:** COMPLETE & VERIFIED  
**Automated Tests:** 342 / 342 passing (76 test suites)  
**TypeScript Typecheck:** 0 errors (`tsc --noEmit`)  
**Production Build:** Clean (`tsc -p tsconfig.build.json`)  

---

## 1. Executive Summary & Architectural Scope

Phase 02B.5.3 completes the platform administrator security architecture for VexChat by unifying the dedicated `AdminSession` foundation (Phases 02B.5.1 – 02B.5.1.2) and TOTP Multi-Factor Authentication engine (Phases 02B.5.2 – 02B.5.2.2) with:

1. **Cryptographically Asserted BFF Ingress:** All admin routes require a durable, single-use, signed Next.js Backend-for-Frontend (BFF) assertion header (`x-bff-assertion`) with strict HTTP method and canonical path binding, clock-skew mitigation, and persistent database replay protection.
2. **Platform Admin Authentication & Lifecycle:** Complete, audited workflows for single-use platform bootstrap (`SUPER_ADMIN`), secure login, TOTP challenge generation and verification, self-service MFA enrollment and confirmation, TOTP-guarded recovery code regeneration, session inspection (`/me`), and secure cookie revocation (`/logout`).
3. **Compound Rate Limiting:** High-security rate limiting (5 attempts / 15 minutes) tracking both client IP and target account identifiers to mitigate brute-force and credential stuffing attacks.
4. **Secure Read-Only Platform Admin GET API Routes:** Real MongoDB aggregations across Workspaces, Users, Subscriptions, Payments, Invoices, and Security Audit Logs with strict role-based access controls (`SUPER_ADMIN` vs `FINANCE_ADMIN`), parameter validation, pagination, and sensitive field redaction.
5. **Zero Financial Mutation:** Strictly preserves the read-only invariant for all financial models. No payment creation, updates, refunds, or subscription modifications are exposed or permitted through platform admin endpoints.
6. **Customer JWT Isolation Gate:** Enforces immediate HTTP 401 `CUSTOMER_TOKEN_FORBIDDEN` fail-closed rejection for any request bearing a customer JWT (`Authorization: Bearer ...`).

---

## 2. Ingress Security & BFF Assertion Verification

### 2.1 Cryptographic Assertion Architecture
Internal Next.js BFF calls to the Express backend are validated via HMAC-SHA256 assertions generated with a dedicated environment secret (`ADMIN_BFF_SECRET`) that is strictly isolated from JWT, webhook, and TOTP secrets.

- **Envelope Format:** `<payload_base64url>.<signature_hex>`
- **Standard Claims:**
  - `jti`: High-entropy UUID v4 token identifier.
  - `iss`: Issuer assertion (`vexchat-bff`).
  - `aud`: Audience target (`vexchat-backend`).
  - `iat`: Issuance Unix timestamp (seconds).
  - `exp`: Expiration Unix timestamp (`iat + ttlSeconds`, default 60s).
  - `method`: Bound HTTP method (e.g. `GET`, `POST`).
  - `path`: Normalized canonical target path (e.g. `/api/platform-admin/dashboard/overview`).
- **Signature Verification:** Verified using constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attack enumeration.

### 2.2 Canonical Path Normalization
Query parameters and trailing slashes are stripped prior to signature generation and verification:
```typescript
export function normalizeCanonicalPath(rawPath: string): string {
  const pathOnly = rawPath.split("?")[0].trim();
  if (pathOnly === "" || pathOnly === "/") return "/";
  return pathOnly.replace(/\/+$/, "");
}
```

### 2.3 Durable Single-Use Replay Protection (`AdminBffNonce`)
Each assertion `jti` is atomically recorded in MongoDB with a unique index constraint and TTL expiration (`{ expireAfterSeconds: 0 }`):
```typescript
export const consumeBffAssertionJti = async (jti: string, expiresAt: Date): Promise<boolean> => {
  try {
    await AdminBffNonce.create({ jti, expiresAt });
    return true;
  } catch (err: any) {
    if (err?.code === 11000) return false; // Duplicate JTI = Replay detected
    throw err;
  }
};
```
Reused assertions immediately fail with `BFF_ASSERTION_REPLAYED` (code `REPLAY_ASSERTION_DETECTED`).

---

## 3. Platform Admin Authentication & Lifecycle Endpoints

Mounted under `/api/platform-admin/auth`:

| Endpoint | Method | Security Guards | Purpose |
| :--- | :--- | :--- | :--- |
| `/bootstrap` | `POST` | `requireBffAssertion`, `authLimiter` | Single-use initial platform `SUPER_ADMIN` promotion (fails if already completed). |
| `/login` | `POST` | `requireBffAssertion`, `authLimiter` | Primary credentials check. Triggers MFA challenge or direct session issuance. |
| `/mfa/verify` | `POST` | `requireBffAssertion`, `authLimiter` | Validates MFA challenge token + 6-digit TOTP / recovery code, issues session. |
| `/mfa/enroll` | `POST` | `requireBffAssertion`, `authLimiter`, `optionalAdminSession` | Initiates TOTP setup, generates Base32 secret, returns `otpauth://` provisioning URI. |
| `/mfa/confirm` | `POST` | `requireBffAssertion`, `authLimiter`, `optionalAdminSession` | Confirms pending TOTP setup with 6-digit code, activates MFA, returns recovery codes. |
| `/mfa/regenerate-recovery-codes` | `POST` | `requireBffAssertion`, `authenticateAdminSession`, `authLimiter` | Regenerates recovery codes for authenticated admin guarded by current TOTP token. |
| `/me` | `GET` | `requireBffAssertion`, `authenticateAdminSession` | Returns authenticated admin profile, platformRole, session lifetime, and MFA status. |
| `/logout` | `POST` | `requireBffAssertion`, `authenticateAdminSession` | Atomically revokes `AdminSession` and clears host-only cookie. |

---

## 4. Secure Read-Only Platform Admin Dashboard Endpoints

Mounted under `/api/platform-admin/dashboard`:

| Endpoint | Method | Role Guard | Aggregation & Security Controls |
| :--- | :--- | :--- | :--- |
| `/overview` | `GET` | `SUPER_ADMIN`, `FINANCE_ADMIN` | Aggregates total workspaces, total users, active subscriptions, total BDT revenue, pending bank transfers, and plan breakdowns. |
| `/revenue` | `GET` | `SUPER_ADMIN`, `FINANCE_ADMIN` | Aggregates revenue time-series by month (`$dateToString`), breakdown by payment method (`BKASH`, `CITY_BANK_CARD`, `CITY_BANK_TRANSFER`), and success rate. |
| `/workspaces` | `GET` | `SUPER_ADMIN`, `FINANCE_ADMIN` | Paginated workspace listings with owner details and joined active subscription plan/status. Supports `search` and `status` filters. |
| `/subscriptions` | `GET` | `SUPER_ADMIN`, `FINANCE_ADMIN` | Paginated subscriptions with populated workspace data. Supports `planCode`, `status`, and `search` filters. |
| `/payments` | `GET` | `SUPER_ADMIN`, `FINANCE_ADMIN` | Paginated payments with workspace and initiator info. **Strictly scrubs raw gateway responses** (`-gatewayData.rawGatewayResponse`). |
| `/invoices` | `GET` | `SUPER_ADMIN`, `FINANCE_ADMIN` | Paginated invoices with issuedTo workspace and user metadata. Supports search by invoice number or customer. |
| `/users` | `GET` | `SUPER_ADMIN` (Strictly 403 for `FINANCE_ADMIN`) | Paginated user accounts excluding password hashes (`-password`). Supports `search`, `role`, and `platformRole` filters. |
| `/audit-logs` | `GET` | `SUPER_ADMIN` (Strictly 403 for `FINANCE_ADMIN`) | Paginated append-only security audit events sorted descending by timestamp. Filterable by `eventType` and `search`. |

---

## 5. Security Gates & Role Isolation Matrix

| Access Role | Overview | Revenue | Workspaces | Subscriptions | Payments | Invoices | Users | Audit Logs | Financial Mutations |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **SUPER_ADMIN** | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | **STRICTLY BLOCKED** |
| **FINANCE_ADMIN** | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | **403 FORBIDDEN** | **403 FORBIDDEN** | **STRICTLY BLOCKED** |
| **Customer USER / OWNER** | **401/403** | **401/403** | **401/403** | **401/403** | **401/403** | **401/403** | **401/403** | **401/403** | **STRICTLY BLOCKED** |
| **Customer JWT Bearer** | **401 REJECT** | **401 REJECT** | **401 REJECT** | **401 REJECT** | **401 REJECT** | **401 REJECT** | **401 REJECT** | **401 REJECT** | **401 REJECT** |

---

## 6. Automated Test Verification & Metrics

All 14 test suites executed cleanly in sequence via `tsx --test --test-concurrency=1`:

```text
▶ 1. RFC 4648 Base32 Encoding & Cryptographic Entropy (4.9ms)
▶ 2. AES-256-GCM Encryption, Key Validation & Tamper Resistance (2.4ms)
▶ 3. RFC 6238 Mathematical Compliance & Provisioning URI (1.0ms)
▶ 4. Clock Drift Windows & Replay Protection Boundaries (1.2ms)
▶ 5. MFA Enrollment Lifecycle & Platform Authorization Gates (16.8ms)
▶ 6. TOTP Verification & Atomic Concurrency Replay Defense (2.9ms)
▶ 7. Single-Use Recovery Code Architecture & Atomic Consumption (2.8ms)
▶ 8. Security Audit Event Logging & Credential Scrubbing (1.9ms)
▶ 9. Platform Admin Session Environment Validation (1.7ms)
▶ BFF Cryptographic Assertion & Replay Protection (10.8ms)
▶ requireBffAssertion Express Middleware (11.3ms)
▶ Platform Admin Authentication & Lifecycle (667.8ms)
▶ Platform Admin Dashboard & Role Authorization (14.9ms)
...
ℹ tests 342
ℹ suites 76
ℹ pass 342
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16457.123
```

- **TypeScript Compilation:** `npm run typecheck` returned 0 errors.
- **Production Build:** `npm run build` (`tsc -p tsconfig.build.json`) succeeded with code 0.

