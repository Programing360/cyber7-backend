# VexChat — Phase 02B.5.3.1.2: Independent Security Re-Audit of SEC-01 through SEC-06

**Audit Date:** 2026-11-05
**Auditor Role:** Independent Backend Security Auditor (Separate From Remediation Author)
**Execution Mode:** STRICT READ-ONLY — No source, test, configuration, environment, database, index, migration, Redis, or deployment changes were made.
**Backend Repository:** `D:\Client-project\client-2\cyber7-backend`
**Frontend Repository:** `D:\Client-project\client-2\cyber7-frontend` (STRICT READ-ONLY — zero modifications)
**Reference Audit:** `docs/PHASE_02B_5_3_1_INDEPENDENT_SECURITY_AUDIT.md`
**Remediation Under Review:** `docs/PHASE_02B_5_3_1_1_SECURITY_REMEDIATION_REPORT.md`

---

## 1. Read-Only Attestation

This audit did **not**:

- Modify, create, delete, format, lint, or refactor any backend or frontend source, test, configuration, migration, model, index, or deployment file.
- Modify `.env`, `.env.example`, `package.json`, lockfiles, or runtime environment variables.
- Create an administrator account, `AdminSession`, `User`, bootstrap lock, nonce, or any database record.
- Run migrations, index synchronizations, seeders, or Redis write commands.
- Implement, propose-in-code, or apply any fix.

The only file written by this audit is this report itself: `docs/PHASE_02B_5_3_1_2_INDEPENDENT_SECURITY_RE_AUDIT.md`. All empirical probes were executed from the pre-approved external temp directory `C:\Users\admin\AppData\Local\Temp\opencode`, outside both repositories.

---

## 2. Evidence Classification Legend

Every finding below distinguishes evidence strength explicitly:

| Label | Meaning |
|---|---|
| **SOURCE-VERIFIED** | Verified by direct inspection of the shipping code path, MongoDB operators, middleware order, and control flow. |
| **TEST-VERIFIED (MOCK)** | Verified by an existing automated test that substitutes in-memory/Mongoose mocks for real I/O. Does not prove database or network semantics. |
| **TEST-VERIFIED (RUNTIME)** | Verified by a test that executes real cryptographic or in-process logic without external services. |
| **LOCAL-INTEGRATION** | Verified against a real local MongoDB/Redis instance. |
| **INFRASTRUCTURE-CONFIG** | Verified from configuration artifacts only (env schemas, deployment descriptors). |
| **PRODUCTION-DEPLOYMENT** | Verified from live/staging deployment topology or telemetry. |
| **NOT VERIFIED** | Cannot be established from the repository or from any executable local evidence. |

A control is **not** considered production-proven merely because a mock-based test passes.

---

## 3. Baseline and Environment Verification

### 3.1 Repository Baselines

| Item | Recorded Value |
|---|---|
| Backend branch | `preview/internal-ingress-security` |
| Backend HEAD | `84f1272acbbe9a0dd2a68a5aa7efe9b948464cdf` |
| Frontend branch | `main` |
| Frontend HEAD | `2dde39527f2a97910f6cd959eb939777fcf6b801` |
| Node runtime | `v24.11.0` |
| npm | `11.12.1` |
| TypeScript | `node_modules\.bin\tsc.cmd --noEmit` → **0 errors** |

### 3.2 Test Execution

| Suite | Tests | Pass | Fail | Notes |
|---|---:|---:|---:|---|
| Backend full suite (all 15 files in `package.json`) | 361 | 361 | 0 | Run with `NODE_OPTIONS=--max-old-space-size=4096`; exit code 0. |
| Backend full suite (first run, default heap) | — | — | 1 (environmental) | `tests/internal-webhook-security.test.ts` aborted with `FATAL ERROR: Zone Allocation failed - process out of memory`; the same file passes 24/24 in isolation. Treated as a heap artifact, not a product failure. |
| `tests/admin-rate-limit.test.ts` | 6 | 6 | 0 | The remediation report claimed 19 rate-limit tests; only **6** exist. |
| Frontend suite (`node --test` on the 6 declared files) | 111 | 111 | 0 | Exit code 0. |

The backend suite total (361) matches the expected baseline. The remediation report's claim of 19 admin rate-limit tests is **inaccurate**; the actual suite contains 6.

### 3.3 Independent Runtime Probe (Outside Repository)

A read-only probe was executed from `C:\Users\admin\AppData\Local\Temp\opencode\audit-probe.ts` against the shipping sanitizer. Results:

```
keys:      {"remainingTokens":true,"remainingRecoveryCodes":true,"remainingPasswords":true,
            "remainingCount":false,"remainingApiKeys":false,"remainingJwt":false,
            "remainingOpenAiKey":false,"remainingCredentials":true}
sanitized: {"remainingTokens":"[REDACTED]","remainingRecoveryCodes":"[REDACTED]",
            "remainingPasswords":"[REDACTED]","remainingCount":5,
            "remainingApiKeys":["sk-live-ABC123"],"remainingJwt":"eyJhbGciOi.payload.sig",
            "remainingOpenAiKey":"sk-proj-123","remainingCredentials":"[REDACTED]"}
circular:  terminates; credentials within depth ≤ 6 redacted; subtrees at depth > 6 replaced by "[REDACTED]"
```

This independently confirms both the intended fix and the residual bypass described in SEC-03.

### 3.4 Independent MFA Interleaving Probe (Outside Repository)

A second read-only probe (`C:\Users\admin\AppData\Local\Temp\opencode\probe-mfa-race.mts`) drove the shipping `adminMfaService` against an in-memory model double that implements the exact atomic filter semantics (`_id`, `adminUserId`, `status`, `enrolledAt` bounds, and `enrollmentGeneration`). It exercised the required interleavings:

```
S0 generations: [affd2a8e-..., d596e174-...] unique: true
S1 (gen-A presented, B replaces before update):        false CONCURRENT_STATE_CHANGE | status PENDING | secret still B
S1b (generation omitted, B replaces before update):    false CONCURRENT_STATE_CHANGE | status PENDING | gen gen-B
S2 (two simultaneous same-generation confirmations):   true | false CONCURRENT_STATE_CHANGE | status ACTIVE
S3 (confirm gen-A against gen-B document):             false STALE_ENROLLMENT_GENERATION
S3b (same, generation omitted):                        false CODE_MISMATCH | status PENDING
S4 (confirm gen-B with token B):                       true | status ACTIVE
```

Interpretation: a superseded enrollment cannot be confirmed, whether or not the caller supplies the generation; two simultaneous confirmations of the same generation yield exactly one success; a genuinely stale generation is rejected before token verification with `STALE_ENROLLMENT_GENERATION`. The probe is still an in-process double, not a real MongoDB replica set, so **real-database atomicity remains NOT VERIFIED**.

---

## 4. Executive Verdict

### Overall Verdict: **CONDITIONAL PASS — NON-CRITICAL GAPS REMAIN**

The remediation materially closes the highest-risk finding (SEC-01 enrollment TOCTOU) at the source level, puts a distributed design in place for SEC-02 (though its production guarantees are unverified), and closes the SEC-04 concurrent-bootstrap race via a database-enforced unique lock. SEC-05 is source-correct and fail-closed, and SEC-06's fail-open replay fallback is replaced with fail-closed durable storage. SEC-03 is only **partially** remediated: the originally cited keys are fixed, but the broad `remaining*` exception still leaks other credential-shaped keys. SEC-02's production guarantees (real Redis atomicity, outage behavior, proxy trust) are **NOT VERIFIED**.

No unmitigated remote authentication bypass or direct privilege-escalation path was found in the remediation code. However, this is **not** a production-readiness sign-off. The conditions in §10 must be satisfied before production deployment.

### Per-Finding Status Matrix

| ID | Finding Theme | Status | Evidence Ceiling |
|---|---|---|---|
| SEC-01 | MFA enrollment TOCTOU / generation binding | **PASS** | SOURCE-VERIFIED + TEST-VERIFIED (MOCK); real-DB concurrency NOT VERIFIED |
| SEC-02 | Distributed admin rate limiting + proxy trust | **NOT VERIFIED** | SOURCE-VERIFIED design; no Redis integration; proxy topology PRODUCTION-DEPLOYMENT NOT VERIFIED |
| SEC-03 | Recursive credential scrubbing | **FAIL (PARTIAL)** | SOURCE-VERIFIED + TEST-VERIFIED + independent runtime probe; residual bypass confirmed |
| SEC-04 | Single-use atomic SUPER_ADMIN bootstrap | **PASS** | SOURCE-VERIFIED + TEST-VERIFIED (MOCK); operational recovery gap noted |
| SEC-05 | Enrollment timestamp fail-closed | **PASS** | SOURCE-VERIFIED + TEST-VERIFIED (MOCK) |
| SEC-06 | Durable BFF replay protection fail-closed | **PASS** | SOURCE-VERIFIED + TEST-VERIFIED (MOCK); live disconnect/recovery NOT VERIFIED |

---

## 5. Detailed Finding Analysis

### SEC-01 — MFA Enrollment TOCTOU / Generation Binding

**Status: PASS (source-verified), with a literal-requirement deviation**

#### Source evidence

- `src/modules/admin-auth/admin-mfa.model.ts:60-65`
  `enrollmentGeneration` is a `String`, `required: true`, defaulted to `crypto.randomUUID()`, and indexed.
- `src/modules/admin-auth/admin-mfa.service.ts:182-195`
  `startMfaEnrollment` generates a fresh UUID and writes it atomically with the new pending secret via `findOneAndUpdate`.
- `src/modules/admin-auth/admin-mfa.service.ts:289-310`
  `confirmMfaEnrollment` performs an explicit mismatch check and returns `STALE_ENROLLMENT_GENERATION` when the presented generation differs from the stored one.
- `src/modules/admin-auth/admin-mfa.service.ts:414-440`
  The state transition is a single `findOneAndUpdate` whose filter includes:
  - `_id`, `adminUserId`, `status: "PENDING"`
  - `enrolledAt: { $gte: expiryThreshold, $lte: maxFutureThreshold }`
  - `enrollmentGeneration` (presented value when supplied, otherwise the value read from the document at lines 422-426)
- `src/modules/admin-auth/admin-auth.controller.ts:35-39`
  `confirmMfaSchema.enrollmentGeneration` is `z.string().optional()` — **not** required and **not** UUID-validated.

#### Why the race is closed

If enrollment A is superseded by enrollment B, the stored `enrollmentGeneration` changes. A confirmation carrying A's generation fails the atomic filter. Even when the caller omits `enrollmentGeneration`, the service falls back to the generation previously read from the document, so the update still fails if B replaced it in the interim. The TOCTOU window identified in the original audit is therefore closed at the write predicate.

#### Test evidence

`tests/admin-mfa.test.ts:893-994` asserts:

- a unique generation is emitted by `startMfaEnrollment`;
- stale generation returns `STALE_ENROLLMENT_GENERATION`;
- a concurrent confirmation returns `CONCURRENT_STATE_CHANGE`.

These are mock-based; there is no real MongoDB concurrency test. The independent probe in §3.4 additionally exercises generation replacement before the atomic write, omission of the generation, and two simultaneous confirmations of the same generation; all interleavings fail closed except the single legitimate confirmation.

#### Deviation and residual risk

- The remediation report's claim that confirmation "requires" the expected generation is not literally true: it is optional in both the controller schema and the service signature. The security outcome is nonetheless preserved by the fallback predicate.
- No real-database concurrent-request proof exists. **Real MongoDB atomic concurrency: NOT VERIFIED.**
- Minor: a client that never sends `enrollmentGeneration` cannot distinguish a superseded enrollment as cleanly (`CONCURRENT_STATE_CHANGE` instead of `STALE_ENROLLMENT_GENERATION`), but it still fails closed.

---

### SEC-02 — Distributed Admin Rate Limiting and Proxy Trust

**Status: NOT VERIFIED**

#### Source evidence (design present)

- `src/middlewares/admin-rate-limit.ts:22-95` implements a Redis-backed store.
- `src/middlewares/admin-rate-limit.ts:29-53` executes `INCR` + `PTTL` in a pipeline, then issues a **separate** `PEXPIRE` when the TTL is negative.
- `src/middlewares/admin-rate-limit.ts:25-27` treats Redis `status === "connect"` as available, in addition to `"ready"`.
- `src/middlewares/admin-rate-limit.ts:158-186` requires Redis in production; missing `REDIS_URL` throws.
- `src/middlewares/admin-rate-limit.ts:216-236` converts store-unavailable conditions into HTTP 503 in production.
- `src/middlewares/admin-rate-limit.ts:316-326` converts read failures into HTTP 503 in production.
- `src/middlewares/admin-rate-limit.ts:329-349` counts only responses with status 400/401/403 on the `finish` event, and resets the account key on 2xx.
- `src/middlewares/admin-rate-limit.ts:238-274` builds account, challenge-hash, and IP keys. The IP key relies on `req.ip`.
- `src/app.ts:23` sets `app.set("trust proxy", 1)`.
- `src/config/redis.ts:23-26` uses `maxRetriesPerRequest: null`, which queues commands indefinitely while reconnecting.
- Frontend `app/api/admin/auth/[...path]/route.ts:37-42` forwards the **client-supplied** `x-forwarded-for` / `x-real-ip` verbatim to the backend. The dashboard BFF route follows the same pattern.

#### Why this is not verified

1. **No Redis integration test.** `tests/admin-rate-limit.test.ts` injects `MemoryRateLimitStore` through `setAdminRateLimitStore`. The test named "multiple simulated instances share atomic rate-limit state" (`tests/admin-rate-limit.test.ts:210-261`) creates two limiter closures that share **one in-process Map**, not two Redis clients. It does not exercise `RedisRateLimitStore` at all. No running Redis was available during this audit.
2. **Atomicity gap.** `INCR` and `PEXPIRE` are not atomic. If the process dies after `INCR` and before `PEXPIRE`, the key can persist without a TTL, producing an indefinite lockout for that account/IP/challenge key. `get()` treats a non-positive TTL as absent (`:77`), which masks the condition but does not repair the unbounded key.
3. **Outage behavior gap.** `isAvailable()` accepts `"connect"`, and commands use `maxRetriesPerRequest: null`. During a network partition the middleware may await indefinitely rather than return the controlled 503. This is the opposite of a clean fail-closed response.
4. **Burst window.** Limits are checked against the *previous* count and incremented asynchronously on response `finish`. A large parallel burst can all pass the pre-check before any failure increments the counter. Only sequential abuse is tightly bounded.
5. **Proxy trust unproven.** With `trust proxy: 1`, the effective client IP is derived from the rightmost hop count. The frontend BFF copies a client-controlled `X-Forwarded-For`, so if a single trusted hop is not the only edge in front of the backend, an attacker can choose the IP rate-limit key. The deployed topology (Vercel frontend → backend Vercel function, possibly additional hops) cannot be confirmed from this repository. The backend `vercel.json` contains only a catch-all route to `api/index.ts` and does not define or normalize a proxy trust boundary, and the frontend repository has no `vercel.json`; no infrastructure descriptor proves the hop count.
6. **Optional DoS lever.** A malformed request with status 400 and an arbitrary `body.email` increments both the account key and the IP key. An attacker can therefore lock a victim's email key for 15 minutes by sending invalid payloads, and can exhaust a shared proxy IP key.

#### Test evidence

- 6 tests pass, covering: shared-IP isolation, success non-counting, challenge-token keying, "multiple simulated instances", production 503, and concurrent increments.
- None of these instantiate a real Redis server.
- The concurrency test is mock/in-process only.
- An independent in-process probe (§7, `probe-ratelimit.mts`) confirmed the burst window against `MemoryRateLimitStore`: 50 concurrent failures with a per-account limit of 5 produced **50 allowed, 0 blocked**; the same limit applied sequentially produced 5 allowed and 5 blocked.

#### Residual risk

- IP-based throttling may be bypassable in the actual deployment.
- A crash between `INCR` and `PEXPIRE` can create permanent lockout keys.
- A Redis partition may hang authentication instead of failing closed within a bounded time.
- Parallel bursts can exceed the intended window because counting is post-response.
- Per-email lockout DoS via malformed 400 requests is possible.

**Redis production readiness and proxy correctness are explicitly NOT VERIFIED.**

---

### SEC-03 — Recursive Credential Scrubbing

**Status: FAIL (PARTIAL)**

#### Source evidence

`src/modules/admin-auth/admin-security-audit.service.ts`:

- Lines 47-63: sensitive substrings (password, secret, token, cookie, authorization, bearer, hash, otp, totp, recoverycode, encryptionkey, cipherkey, privatekey, provisioninguri, credential).
- Lines 68-79: credential code patterns.
- Lines 94-102: sensitive-key precedence is correctly applied **before** safe exceptions.
- Lines 118-125: the constrained count exception is **not** appropriately constrained:

```ts
if (
  SAFE_COUNT_PATTERNS.some((p) => normalized.endsWith(p)) ||
  normalized.startsWith("remaining")
) {
  return false;
}
```

- Lines 197-242: recursive traversal with depth bound `depth > 6 → "[REDACTED]"`, arrays handled at line 219-221, objects at 223-241, ObjectId handled, and the key check runs at both entry and per-property.

#### What is fixed

The originally cited keys are correctly redacted:

| Key | Source result | Independent probe |
|---|---|---|
| `remainingTokens` | REDACTED (contains `token`) | REDACTED |
| `remainingRecoveryCodes` | REDACTED (contains `recoverycode`) | REDACTED |
| `remainingPasswords` | REDACTED (contains `password`) | REDACTED |
| `remainingCount` | PRESERVED (intended safe count) | PRESERVED (5) |
| `remainingCredentials` | REDACTED (contains `credential`) | REDACTED |

Nested credentials, arrays, and max-depth behavior are correct:

- Nested objects: redacted at every inspected level.
- Arrays: each element is recursively sanitized.
- Max depth: uninspected subtrees return `"[REDACTED]"`, never raw data.
- Circular objects: terminate because recursion is depth-bounded; the probe completed without a stack overflow. Credentials inside the first six levels were redacted.

#### What is still broken

The blanket `normalized.startsWith("remaining")` exception permits redaction bypass for any credential whose key happens to start with `remaining` but does not contain a sensitive substring. The independent probe confirmed:

| Key | Leaked value |
|---|---|
| `remainingApiKeys` | `["sk-live-ABC123"]` |
| `remainingJwt` | `"eyJhbGciOi.payload.sig"` |
| `remainingOpenAiKey` | `"sk-proj-123"` |

These are plausible audit-metadata key names (for example, a billing or integration audit event reporting remaining provider keys). Because the audit log is append-only, leakage is durable. The remediation report's claim that the broad `remaining*` exception was removed is **not accurate**.

#### Test evidence

`tests/admin-mfa.test.ts:1670-1691` covers the originally cited keys and safe counts. `:1693-1712` covers nested mixed objects/arrays. `:1714-1736` covers max-depth redaction.

Gaps:

- No automated test for a circular object.
- No automated test for the exact key `remainingCount` (only `remainingAttempts`).
- No test for `remainingApiKeys`, `remainingJwt`, or `remainingOpenAiKey`, which is why the bypass survives the suite.

#### Required correction (described only, not implemented)

Restrict the count exception to an explicit allowlist (for example `remainingAttempts`, `remainingCodes`, `remainingCount`, `*Count`, `*Total`, `*Length`, `*Size`) instead of a `startsWith("remaining")` wildcard, and add regression tests for API-key/JWT-shaped `remaining*` names plus circular input.

---

### SEC-04 — Single-Use Atomic SUPER_ADMIN Bootstrap

**Status: PASS (race closed), with operational residuals**

#### Source evidence

- `src/modules/admin-auth/admin-bootstrap.model.ts:15-42`
  The lock document uses a fixed `_id: "INITIAL_SUPER_ADMIN_BOOTSTRAP"`, which is unique by MongoDB's primary-key constraint.
- `src/modules/admin-auth/admin-auth.service.ts:149-169`
  A pre-check counts existing `SUPER_ADMIN` users. This is TOCTOU-prone on its own but is not the authoritative gate.
- `src/modules/admin-auth/admin-auth.service.ts:198-230`
  `AdminBootstrapLock.create(...)` is the authoritative atomic claim. A duplicate-key error (`code === 11000`) is mapped to `BOOTSTRAP_ALREADY_COMPLETED`.
- `src/modules/admin-auth/admin-auth.service.ts:232-233`
  Only after the lock is created is `user.platformRole = "SUPER_ADMIN"` set and `user.save()` awaited.

The concurrent double-promotion race is therefore closed: exactly one concurrent request can insert the fixed `_id`; all others receive `E11000`.

#### Test evidence

- `tests/platform-admin-auth.test.ts:89-118` mocks a duplicate-key failure and asserts the user is **not** promoted.
- `tests/platform-admin-auth.test.ts:121-178` simulates two concurrent bootstrap requests and asserts exactly one succeeds.
- Mock-based; no real MongoDB replica/session test.

#### Residual risks

1. **Orphaned lock on save failure.** The lock is committed before `user.save()`. If the save fails (validation error, connection loss, process crash) the lock remains, no SUPER_ADMIN exists, and every subsequent bootstrap is rejected. Recovery requires manual deletion of the lock document. There is no transaction, compensating delete, or admin recovery tool.
2. **No partial unique index on `platformRole`.** `src/modules/auth/user.model.ts:34-38` defines `platformRole` without a partial unique index for `SUPER_ADMIN`. The invariant "at most one SUPER_ADMIN" is enforced only by the bootstrap path, not by the data model.
3. **Seed script bypass.** `scripts/seed-platform-admin.ts:46-59` promotes any user to `SUPER_ADMIN` without consulting the bootstrap lock and without checking whether another SUPER_ADMIN already exists. It also compares the provisioning secret with plain `!==` (`:32`) rather than a constant-time comparison. This is an out-of-band operational path, gated by an environment secret, but it can violate the single-SUPER_ADMIN invariant.
4. **HTTP status mismatch (cosmetic).** `src/modules/admin-auth/admin-auth.controller.ts:70-76` maps `BOOTSTRAP_ALREADY_COMPLETED` to HTTP 403, while the generic error handler maps duplicate-key errors to 409. The remediation report's 409 expectation is not what the bootstrap controller returns.
5. **Event taxonomy.** Success is recorded as `SESSION_CREATED` (line 236) with a reason string, not as a dedicated bootstrap event. This does not weaken authorization but reduces audit clarity.

---

### SEC-05 — Enrollment Timestamp Fail-Closed Behavior

**Status: PASS**

#### Source evidence

- `src/modules/admin-auth/admin-mfa.service.ts:316-336`
  Missing, non-Date, or invalid (`NaN`) `enrolledAt` returns `INVALID_ENROLLMENT_TIMESTAMP`.
- `src/modules/admin-auth/admin-mfa.service.ts:340-349`
  A future-dated timestamp beyond `MFA_ENROLLMENT_CLOCK_SKEW_MS` returns a dedicated rejection.
- `src/modules/admin-auth/admin-mfa.service.ts:411-419`
  The same bounds are enforced **inside** the atomic `findOneAndUpdate` filter:
  `enrolledAt: { $gte: expiryThreshold, $lte: maxFutureThreshold }`.
- The previous "fallback to now" behavior is absent; no code path substitutes the current time for a missing timestamp.

#### Test evidence

- `tests/admin-mfa.test.ts:1023-1030` asserts missing timestamp → `INVALID_ENROLLMENT_TIMESTAMP`.
- `tests/admin-mfa.test.ts:1032-1064` asserts a future timestamp beyond skew is rejected with `FUTURE_ENROLLMENT_TIMESTAMP`.
- The pre-check error codes are asserted. That the atomic predicate itself includes both bounds is **source-verified** but not directly asserted by a mock test (a mock cannot observe the filter predicate meaningfully).

#### Residual risk

- Clock skew between application instances and MongoDB is a deployment concern; the configured skew window governs tolerance.
- No real-DB test proves that a timestamp mutated between read and write is rejected; the atomic predicate source-verifies this behavior.

---

### SEC-06 — Durable BFF Replay Protection Fail-Closed

**Status: PASS (source + unit), live failure/recovery NOT VERIFIED**

#### Source evidence

- `src/modules/admin-auth/admin-bff-nonce.model.ts`
  - `jti` is `required: true`, `unique: true`, indexed (`:11-17`).
  - `expiresAt` is required (`:18-21`).
  - A TTL index purges expired nonces (`:35`).
  - `BffNonceStorageError` exists for controlled storage failure (`:45+`).
  - `consumeBffAssertionJti` does not fall back to an in-memory store; it raises on storage failure.
- `src/modules/admin-auth/admin-bff-assertion.util.ts`
  Maps nonce-storage failure to the explicit code `REPLAY_PROTECTION_UNAVAILABLE`.
- `src/middlewares/verify-bff-assertion.ts`
  Maps `REPLAY_PROTECTION_UNAVAILABLE` to HTTP 503.
- `src/modules/admin-auth/admin-bff-assertion.util.ts` also validates signature, method, path, issuer, audience, and expiry before nonce consumption.

No insecure in-memory replay cache remains in the examined paths.

#### Test evidence

- `tests/bff-assertion.test.ts:249-350` sets `mongoose.connection.readyState` to `0` (disconnected) and asserts rejection with `REPLAY_PROTECTION_UNAVAILABLE` / HTTP 503, then verifies that a fresh valid assertion succeeds after recovery.
- The readiness transition is simulated by redefining a property, not by an actual database disconnect.

#### Residual risk

- A real MongoDB outage's latency/error surface is not integration-tested. If a driver call hangs rather than rejects, the 503 mapping may not fire promptly; this is a general infrastructure behavior, not a code defect observed here.
- TTL index enforcement is asynchronous (MongoDB's TTL monitor runs periodically); replay safety does **not** depend on TTL cleanup because the unique `jti` constraint is authoritative.

---

## 6. Cross-Cutting Security Review

These are pre-existing or adjacent observations, separated from the SEC-01..06 remediation verdicts.

### 6.1 Platform-Admin Billing Routes Do Not Use AdminSession/MFA/BFF

- `src/modules/billing/billing.routes.ts:44-62` mounts `/api/admin/billing/*` with:
  - `authenticate` (customer access-token middleware), and
  - `requirePlatformAdmin("FINANCE_ADMIN", "SUPER_ADMIN")`.
- `src/middlewares/require-platform-admin.ts:21-29` trusts `req.user.platformRole` from the customer JWT.
- There is no `requireBffAssertion`, no `authenticateAdminSession`, and no MFA step on these financial mutation endpoints (`bank-transfers/:paymentId/approve|reject`).

**Residual risk (HIGH / pre-existing):** A user holding a customer JWT with `platformRole = FINANCE_ADMIN` or `SUPER_ADMIN` can invoke financial approval/rejection endpoints without the dedicated admin session, BFF assertion, or MFA controls. This was not one of SEC-01..06 and is not a regression introduced by the remediation, but it is a material gap in the platform-admin containment model and should be treated as a separate finding before production.

### 6.2 Session and Cookie Controls Appear Intact

- `src/modules/admin-auth/admin-session.service.ts` performs token hashing, idle/absolute expiry, status checks, authoritative user re-validation (active, role, verified email), and audit logging.
- `src/middlewares/authenticate-admin-session.ts` accepts only the dedicated cookie/header, rejects customer JWTs on admin routes, and revalidates the user.
- `src/modules/admin-auth/admin-cookie.util.ts` enforces `__Host-` in production, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and forbids `Domain`.

No regression was found in these controls. **Production cookie behavior (HTTPS, domain, browser handling): NOT VERIFIED** from this repository alone.

### 6.3 Dashboard RBAC

`src/modules/platform-admin-dashboard/dashboard.routes.ts` applies `requireBffAssertion` + `authenticateAdminSession` globally, then per-route `requireAdminPlatformRole(...)`. This is consistent with the intended gate order.

---

## 7. Reproduction Evidence Summary

| Check | Command | Result |
|---|---|---|
| Backend typecheck | `node_modules\.bin\tsc.cmd --noEmit` | 0 errors, exit 0 |
| Backend full suite (4 GB heap) | `tsx --test --test-concurrency=1 <15 files>` | 361 / 361 pass, 0 fail |
| Backend full suite (default heap) | same | OOM in `internal-webhook-security.test.ts`; file passes 24/24 alone |
| Admin rate-limit suite | `tsx --test tests/admin-rate-limit.test.ts` | 6 / 6 pass |
| Frontend suite | `node --test <6 files>` | 111 / 111 pass |
| Sanitizer probe | `tsx C:\...\Temp\opencode\audit-probe.ts` | Confirms partial fix + residual `remainingApiKeys`/`remainingJwt`/`remainingOpenAiKey` leak |
| MFA interleaving probe | `tsx C:\...\Temp\opencode\probe-mfa-race.mts` | Unique generations; superseded/stale confirmations all rejected; one of two simultaneous confirmations succeeds |
| Rate-limit burst probe | `tsx C:\...\Temp\opencode\probe-ratelimit.mts` | 50 concurrent failures with limit 5 → 50 allowed, 0 blocked; sequential 10 → 5 allowed, 5 blocked |

---

## 8. Residual Risk Register

| ID | Risk | Severity | Evidence | Required Action |
|---|---|---|---|---|
| R-01 | `remaining*` wildcard leaks `remainingApiKeys`, `remainingJwt`, `remainingOpenAiKey`, and similar credential keys into append-only audit logs | Medium | SOURCE + PROBE | Replace wildcard with explicit count allowlist; add regression tests |
| R-02 | IP rate-limit key spoofable if proxy hop count differs from `trust proxy: 1`; BFF forwards client XFF | Medium/High (topology-dependent) | SOURCE; PRODUCTION-DEPLOYMENT NOT VERIFIED | Confirm deployed hop count; strip and re-derive client IP at the BFF; test with real proxy chain |
| R-03 | `INCR`/`PEXPIRE` non-atomicity can create TTL-less permanent lockout keys | Medium | SOURCE | Use a single Lua script or `SET NX` + `INCR` transaction; add TTL repair |
| R-04 | `isAvailable()` accepts `"connect"` with `maxRetriesPerRequest: null`, risking indefinite hang instead of 503 | Medium | SOURCE | Restrict availability to `"ready"`; bound command timeouts |
| R-05 | Parallel burst can exceed failure limit because counting occurs on response `finish` | Low/Medium | SOURCE | Reserve/increment synchronously before processing, roll back on success if needed |
| R-06 | Malformed 400 with arbitrary email increments account key → per-email lockout DoS | Low/Medium | SOURCE | Do not count pure schema-validation 400s against the account key |
| R-07 | Bootstrap lock acquired before `user.save()`; failure orphans the lock permanently | Medium (availability) | SOURCE | Use a transaction or compensating delete; provide recovery runbook |
| R-08 | No partial unique index enforcing at most one `SUPER_ADMIN`; seed script bypasses lock and uses non-constant-time comparison | Medium | SOURCE | Add partial unique index; gate seed script through same lock/constant-time compare |
| R-09 | `/api/admin/billing/*` financial mutations use customer JWT + platform-role claim only, bypassing AdminSession/MFA/BFF | High (pre-existing) | SOURCE | Route through BFF assertion + AdminSession + role + MFA revalidation |
| R-10 | No real MongoDB concurrency tests for MFA/bootstrap atomic predicates | Medium | TEST GAP | Add `mongodb-memory-server` or staging replica-set integration tests |
| R-11 | No real Redis integration tests; "multiple instances" test shares one in-memory Map | Medium | TEST GAP | Add ephemeral Redis integration suite |
| R-12 | No automated circular-object test; no exact `remainingCount` test | Low | TEST GAP | Add both to `admin-mfa.test.ts` |
| R-13 | Remediation report inaccuracies (19 vs 6 rate-limit tests; "required" generation; "remaining* removed"; 409 duplicate) | Low (documentation) | SOURCE/TEST | Correct the report to match shipping behavior |

---

## 9. Git Status

### 9.1 Before Audit (recorded at start)

**Backend** — branch `preview/internal-ingress-security`, HEAD `84f1272acbbe9a0dd2a68a5aa7efe9b948464cdf`:

```
 M .env.example
 M package.json
 M src/app.ts
 M src/config/env.ts
 M src/middlewares/authenticate.ts
 M src/modules/auth/user.model.ts
?? docs/
?? scripts/seed-platform-admin.ts
?? src/middlewares/admin-rate-limit.ts
?? src/middlewares/authenticate-admin-session.ts
?? src/middlewares/require-platform-admin.ts
?? src/middlewares/verify-bff-assertion.ts
?? src/modules/admin-auth/
?? src/modules/billing/
?? src/modules/platform-admin-dashboard/
?? tests/admin-mfa.test.ts
?? tests/admin-rate-limit.test.ts
?? tests/admin-session-foundation.test.ts
?? tests/bff-assertion.test.ts
?? tests/billing-foundation.test.ts
?? tests/platform-admin-auth.test.ts
?? tests/platform-admin-dashboard.test.ts
```

**Frontend** — branch `main`, HEAD `2dde39527f2a97910f6cd959eb939777fcf6b801`:

```
 M app/api/[...path]/route.ts
 M app/billing/page.tsx
 M app/layout.tsx
 M app/login/page.tsx
 M app/super-admin/page.tsx
 M package.json
 M src/component/dashboard/header.tsx
 M src/component/inbox/chat-window.tsx
 M src/component/inbox/contact-panel.tsx
 M src/component/main/PaymentMethods.tsx
 M src/component/main/PricingCalculator.tsx
 M src/component/super-admin/supportAdmin.tsx
 M src/lib/api-client.ts
 M src/lib/navigation.ts
 M src/lib/utils.ts
?? app/admin/
?? app/api/admin/
?? app/billing/callback/
?? docs/
?? scripts/
?? src/component/admin/
?? src/component/billing/
?? src/data/mock/admin-aligned.ts
?? src/lib/bff-assertion.ts
?? src/services/admin-service.ts
?? src/services/billing-service.ts
?? src/types/admin.ts
?? src/types/billing.ts
?? tests/admin-bff.test.ts
?? tests/admin-containment.test.ts
?? tests/admin-dashboard.test.ts
?? tests/billing-frontend.test.ts
```

### 9.2 After Audit

Identical to §9.1 for both repositories, including branch, HEAD, tracked modifications, and untracked paths. The only addition is this report inside the already-untracked `docs/` directory, which does not alter the porcelain status shown above. **No repository content was modified by this audit.**

---

## 10. Final Verdict and Conditions

### Final Verdict: **CONDITIONAL PASS — NON-CRITICAL GAPS REMAIN**

**Definition used:** No unmitigated critical/remote authentication bypass was found in the remediation's source paths, and the principal races (SEC-01, SEC-04) are closed at the database predicate level. However, one finding (SEC-03) remains only partially remediated, one finding (SEC-02) cannot be verified without real infrastructure, and several medium risks and test gaps remain. Deployment to production is therefore **conditional**, not approved outright.

**Scope note:** This verdict applies strictly to the SEC-01..SEC-06 remediation. Separately, cross-cutting finding R-09 (customer-JWT access to financial platform-admin mutations) is **HIGH and pre-existing**; it is not counted as a failure of this remediation, but it independently blocks any production sign-off until routed through the admin containment model.

### Conditions that must be met before production sign-off

1. **SEC-03 (blocking for production):** Remove the `startsWith("remaining")` wildcard; use an explicit count-key allowlist. Confirm `remainingApiKeys`, `remainingJwt`, `remainingOpenAiKey`, and arbitrary `remaining*Credential*` shapes redact. Add circular-object and exact-`remainingCount` tests.
2. **SEC-02 (blocking for production):** Run an integration suite against a real Redis instance across at least two application instances. Confirm distributed counters, TTL behavior on crash, bounded fail-closed behavior during Redis outage, and the actual proxy hop topology. Verify that a spoofed `X-Forwarded-For` from the BFF does not select the IP key.
3. **SEC-04 (blocking for production):** Add a transaction or compensating cleanup for the bootstrap lock, and a documented recovery procedure for an orphaned lock. Add a partial unique index or equivalent invariant for `SUPER_ADMIN` if multiple super-admins are not an intended product state. Route the seed script through the lock or retire it.
4. **R-09 (separate security finding, strongly recommended before production):** Put `/api/admin/billing/*` behind the same BFF assertion + AdminSession + MFA + role gate as the dashboard, or explicitly document and accept the residual risk with a compensating control.
5. **Evidence gate:** Real-database concurrency tests for SEC-01/SEC-04/SEC-06 and real-Redis tests for SEC-02 must pass in staging. Mock-only tests must not be presented as production proof.

### Explicit non-claims

- This audit does **not** certify Redis production readiness.
- This audit does **not** certify proxy/IP trust correctness.
- This audit does **not** certify real MongoDB concurrency behavior.
- This audit does **not** certify real MongoDB outage/recovery behavior for BFF nonce storage.
- This audit does **not** assert that the remediation report's numeric or behavioral claims are accurate; discrepancies are documented in §8 (R-13).

---

## 11. Audit Limitations

- No live MongoDB or Redis service was available; no `mongodb-memory-server` dependency exists in the backend repository.
- No staging/production deployment topology, proxy configuration, or telemetry was accessible.
- All runtime probing was limited to in-process TypeScript execution from an external temp directory.
- The frontend repository was inspected read-only; its BFF behavior was verified by source inspection and its existing test suite only.

**End of Report.**
