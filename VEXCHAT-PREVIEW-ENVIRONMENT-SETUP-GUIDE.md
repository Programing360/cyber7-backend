# VexChat Backend — Vercel Preview Environment Setup Guide

**Repository:** `D:\Client-project\client-2\cyber7-backend`  
**GitHub Remote:** `https://github.com/Programing360/cyber7-backend.git`  
**Target Branch:** `main`  
**Target Commit SHA:** `87495e542a97530654f40c31a77f599d70150086`  
**Target Deployment Stage:** **Preview** (Do NOT deploy to Production)  

---

## Overview

This guide provides operational instructions for configuring the Vercel Preview deployment and MongoDB Atlas for the VexChat Express/TypeScript backend.

In this architecture:
* The backend runs as a stateless serverless function powered by `@vercel/node` and `api/index.ts`.
* All incoming requests (`/(.*)`) are routed to the Express application.
* Background queue workers (BullMQ / Redis) remain dormant and disabled in the serverless API runtime.
* The preview database is isolated from production data.

---

## 1. Vercel Dashboard — Environment Variables Configuration

Configure these variables in **Vercel Project Settings → Environment Variables**.

> **Crucial Scope Rule:**  
> When creating or updating each environment variable in the Vercel dashboard, select the **Preview** checkbox. Leave the **Production** checkbox **unchecked** so production settings remain unaffected.

The variables are categorized below based on actual source-code enforcement:

### 1.1. Required for API Initialization (Core Boot)
If this variable is missing, the serverless handler throws an error on the very first incoming request and fails to initialize.

| Variable Name | Environment Scope | Expected Format / Example Pattern | Purpose & Source Enforcement |
| :--- | :--- | :--- | :--- |
| `MONGODB_URI` | **Preview** | `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<preview_db>?retryWrites=true&w=majority` | MongoDB Atlas connection string. Throws `Error("MONGODB_URI is missing from environment variables")` on first request (`src/config/database.ts:33`). |

### 1.2. Required for Specific Features
These variables are not evaluated during initial boot, but are required when specific endpoints or features are invoked.

| Variable Name | Environment Scope | Expected Format / Example Pattern | Purpose & Source Enforcement |
| :--- | :--- | :--- | :--- |
| `JWT_ACCESS_SECRET` | **Preview** | High-entropy string of at least 32 characters (e.g. 64-byte hex string) | Signs and verifies user authentication tokens. Throws `Error("JWT_ACCESS_SECRET must be configured with a sufficiently strong secret")` if `< 32` characters (`src/utils/jwt.ts:6`). |
| `WHATSAPP_ENCRYPTION_KEY` | **Preview** | Exactly 32-byte canonical Base64 string (44 characters ending with `=`) | Encrypts and decrypts Meta WhatsApp access tokens using AES-256-GCM. Throws `Error("WHATSAPP_ENCRYPTION_KEY must be a valid 32-byte Base64 key")` if invalid (`src/utils/encryption.ts:16`). |
| `CLIENT_URL` | **Preview** | `https://<frontend-preview-domain>.vercel.app` *(No trailing slash)* | Configures allowed browser CORS origin (`src/app.ts:20`). Required when frontend makes credentialed requests to the backend. |
| `META_APP_SECRET` | **Preview** | 32-character hexadecimal string | Required for HMAC SHA-256 signature verification (`x-hub-signature-256`) of incoming Meta webhook POST events (`src/modules/controllers/whatsapp-webhook.controller.ts:49`). |
| `META_WEBHOOK_VERIFY_TOKEN` | **Preview** | Custom secret token string | Required for Meta webhook GET challenge verification handshake (`src/modules/controllers/whatsapp-webhook.controller.ts:16`). |

### 1.3. Optional with Safe Defaults
These variables provide configuration options but fall back to safe built-in defaults if omitted.

| Variable Name | Environment Scope | Default Value | Purpose & Source Enforcement |
| :--- | :--- | :--- | :--- |
| `CAMPAIGN_EXECUTION_ENABLED` | **Preview** | `false` | **Must remain `false`** in the Vercel serverless runtime to prevent campaign workers from running inside lambdas (`src/config/env.ts:91`). |
| `PUBLIC_API_URL` / `WEBHOOK_PUBLIC_URL` | **Preview** | `null` | Used by `/api/whatsapp/:workspaceId/config-status` to construct the public webhook callback URL (`src/modules/config/whatsapp.config.ts:13`). |
| `JWT_ACCESS_EXPIRES_IN` | **Preview** | `15m` | Token expiration time (`src/utils/jwt.ts:16`). Must match `/^\d+(s\|m\|h\|d)$/`. |
| `META_GRAPH_API_VERSION` | **Preview** | `v26.0` | Meta Graph API version used in outgoing HTTP calls (`src/modules/config/whatsapp.config.ts:62`). |
| `META_APP_ID` | **Preview** | `""` | Meta Application ID (`src/modules/config/whatsapp.config.ts:54`). |
| `NODE_ENV` | **Preview** | Automatically `production` | Managed automatically by Vercel; suppresses stack traces in error responses (`src/middlewares/error-handler.ts:28`). |

### 1.4. Not Required in the Vercel API Runtime
These variables are ignored or unused by the serverless entry point (`api/index.ts`):
* `PORT`: Only used by local standalone development (`src/server.ts`). Vercel serverless functions handle network binding automatically.
* `REDIS_URL`: Not imported or referenced by `api/index.ts`.
* `CAMPAIGN_*` worker variables (`CAMPAIGN_SCHEDULER_INTERVAL_MS`, `CAMPAIGN_PAGE_SIZE`, `CAMPAIGN_SEND_CONCURRENCY`, `CAMPAIGN_DISPATCH_CONCURRENCY`, `CAMPAIGN_MAX_ATTEMPTS`, `CAMPAIGN_RETRY_DELAY_MS`, `CAMPAIGN_LEASE_DURATION_MS`, `CAMPAIGN_HEARTBEAT_INTERVAL_MS`, `CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS`): Have built-in defaults; queue workers do not execute inside Vercel serverless functions.

---

## 2. Safe Secret Generation Guidance

Generate your secrets locally in a secure terminal. **Never share these generated values in chat, tickets, or Git.**

### A. Generating `JWT_ACCESS_SECRET`
The application strictly requires a secret of at least 32 characters (`src/utils/jwt.ts:6`). Generate a secure 64-byte (128-hex-character) secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
* Copy the output directly into Vercel's `JWT_ACCESS_SECRET` environment variable for the **Preview** environment.

### B. Generating `WHATSAPP_ENCRYPTION_KEY`
The application strictly validates that this key is **canonical Base64 encoding of exactly 32 bytes** (256 bits). If the key contains whitespace or does not decode to exactly 32 bytes, the application will throw `Error("WHATSAPP_ENCRYPTION_KEY must be a valid 32-byte Base64 key")`.

Generate it using:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
* **Output:** A 44-character Base64 string ending with `=`.
* Copy the output directly into Vercel's `WHATSAPP_ENCRYPTION_KEY` field for the **Preview** environment.
* **Important:** Do not add spaces, quotes, or trailing newlines when pasting into the Vercel dashboard.

---

## 3. MongoDB Atlas Configuration & Security Analysis

Follow these steps in the [MongoDB Atlas Dashboard](https://cloud.mongodb.com):

### 3.1. Create an Isolated Preview Database
To ensure preview testing does not mutate production data:
1. You do not need to provision a separate Atlas cluster.
2. In MongoDB, a database is created automatically upon its first write operation.
3. Designate a distinct database name in your Atlas connection string path:
   * **Production:** `...mongodb.net/cyber7?retryWrites=true&w=majority`
   * **Preview:** `...mongodb.net/cyber7_preview?retryWrites=true&w=majority`
4. Set this preview connection string as the `MONGODB_URI` environment variable for the Vercel **Preview** environment only.

### 3.2. Least-Privilege Database User Permissions
1. In the Atlas sidebar, navigate to **Security → Database Access**.
2. Avoid granting administrative or `readWriteAnyDatabase` privileges to application users.
3. Instead, configure a database user with permissions scoped strictly to the preview database:
   * **Role:** `readWrite`
   * **Specific Database:** `cyber7_preview` (or your chosen preview database name).
4. Ensure the database user password does not contain unencoded special characters that break URI parsing (such as `@`, `:`, or `/`).

### 3.3. Configuring Network Access & Understanding `0.0.0.0/0`
1. In the Atlas sidebar, navigate to **Security → Network Access**.
2. Click **Add IP Address**.
3. Select **Allow Access from Anywhere** (`0.0.0.0/0`).
4. Set an entry comment: `Vercel Serverless Dynamic IPs (Preview)`.
5. Click **Confirm**.

> **Security Implications of `0.0.0.0/0`:**  
> Configuring `0.0.0.0/0` allows TCP connections to the Atlas cluster endpoint from any public IP address.  
> * **Why it is necessary:** Vercel serverless functions execute on dynamic cloud infrastructure with constantly shifting IP ranges. Static outbound IP whitelisting is not supported on standard Vercel serverless plans.  
> * **It is NOT risk-free:** Exposing the network port to the public internet means the database relies entirely on:
>   1. Strong database user credentials (using SCRAM-SHA authentication).
>   2. Enforced TLS/SSL transport encryption.
>   3. Strict database user role scoping (least privilege).
> * **Best practices:** Use a dedicated, complex password for the preview user and avoid reusing credentials across clusters or environments. For high-compliance enterprise setups, VPC Peering or AWS PrivateLink on dedicated Atlas tiers is required to eliminate public IP access.

---

## 4. Frontend CORS Configuration

The backend CORS policy is implemented in `src/app.ts`:

```typescript
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
```

### Purpose of `credentials: true`
* `credentials: true` (`Access-Control-Allow-Credentials: true`) is required when the frontend makes cross-origin credentialed requests, such as requests that transmit HTTP cookies, TLS client certificates, or authentication sessions.
* **Why Wildcards Fail:** Under the WHATWG / W3C Fetch specification, whenever `credentials: true` is configured, browsers strictly forbid using a wildcard `Access-Control-Allow-Origin: *`. If `CLIENT_URL` is set to `*`, the browser will immediately block the cross-origin response.

### Exact Origin Rules:
* Set `CLIENT_URL` to the **exact origin** of the frontend preview deployment:
  * Example: `https://cyber7-frontend-git-main-username.vercel.app`
* **Rule 1:** Must include the protocol (`https://`).
* **Rule 2:** Must **NOT** have a trailing slash (`https://domain.com/` will fail CORS origin string comparison; use `https://domain.com`).
* **Rule 3:** Direct server-to-server calls (e.g. Meta webhooks, curl, Postman, automated backend tests) do not send browser `Origin` headers and are unaffected by CORS.

---

## 5. Deployment Preparation & Safety Guardrails

### 5.1. Connecting the GitHub Repository to Vercel
1. In the Vercel Dashboard, select **Add New... → Project**.
2. Under **Import Git Repository**, select `Programing360/cyber7-backend`.
3. In project settings:
   * **Framework Preset:** Other
   * **Root Directory:** `./`
   * **Build Command:** Leave default (`npm run build`)
   * **Output Directory:** Leave default
4. In the **Environment Variables** section, enter the Preview variables documented in Section 1. Ensure the **Preview** checkbox is checked and **Production** is unchecked.

### 5.2. Linking and Deploying via Vercel CLI (Safe Preview Mode)
If deploying from the local command line:
1. Ensure you are in `D:\Client-project\client-2\cyber7-backend` on commit `87495e5`.
2. Link the local repository to the correct existing Vercel project:
   ```bash
   vercel link
   ```
3. Trigger a **Preview deployment** by running `vercel` without the `--prod` flag:
   ```bash
   vercel
   ```
4. **Safety Rule:** **NEVER** include the `--prod` flag during this phase. Running `vercel --prod` targets Production. Running `vercel` without `--prod` targets the **Preview** environment and binds to your Preview environment variables.

---

## 6. Comprehensive Completion Checklist

Verify each task in order before and after triggering the preview deployment:

### Phase A: MongoDB Atlas Setup
- [ ] Log in to [cloud.mongodb.com](https://cloud.mongodb.com).
- [ ] Network Access: Confirm `0.0.0.0/0` is active.
- [ ] Database Access: Create/verify user with `readWrite` permissions scoped strictly to `cyber7_preview`.
- [ ] Connection String: Prepare preview connection URI targeting `cyber7_preview`.

### Phase B: Local Secret Generation
- [ ] Generate `JWT_ACCESS_SECRET` (minimum 32 characters, 64-byte hex recommended).
- [ ] Generate `WHATSAPP_ENCRYPTION_KEY` (32-byte Base64, exactly 44 characters ending with `=`).
- [ ] Verify neither secret contains unescaped whitespace or quotes.

### Phase C: Vercel Dashboard Configuration
- [ ] Open the Vercel project settings (**Settings → Environment Variables**).
- [ ] Add `MONGODB_URI` (Scope: **Preview** only).
- [ ] Add `JWT_ACCESS_SECRET` (Scope: **Preview** only).
- [ ] Add `WHATSAPP_ENCRYPTION_KEY` (Scope: **Preview** only).
- [ ] Add `CLIENT_URL` (Scope: **Preview** only; exact HTTPS origin, no trailing slash).
- [ ] Add `CAMPAIGN_EXECUTION_ENABLED=false` (Scope: **Preview** only).
- [ ] (Optional) Add Meta webhook credentials if testing Cloud API integration.

### Phase D: Deployment Execution & Health Probe
- [ ] Confirm local branch is `main` at commit `87495e542a97530654f40c31a77f599d70150086`.
- [ ] Deploy using `vercel` (without `--prod`) or via GitHub Pull Request.
- [ ] Once deployed, probe the health endpoint:
  ```text
  GET https://<preview-domain>.vercel.app/api/health
  ```
- [ ] **Expected Health Response:**
  ```json
  {
    "success": true,
    "message": "Cyber7 API is running successfully!",
    "timestamp": "2026-11-01T..."
  }
  ```
  *(Note on branding: The source code in `src/app.ts:61` currently returns `"Cyber7 API is running successfully!"`. Target future branding is `"VexChat API"`, which will be updated in a dedicated branding task without altering source code in this setup phase).*
