# WhatsApp Automation Engine — Comprehensive Code Audit & Architecture Report

**Project:** Cyber7 / VexChat (Multi-Tenant WhatsApp Cloud API SaaS)  
**Author:** Senior Backend & Meta WhatsApp Cloud API Solutions Architect  
**Audit Date:** November 10, 2026  
**Status:** Audit Complete — Actionable Blueprint & Implementation Roadmap Delivered  

---

## Executive Summary

An exhaustive End-to-End code audit was conducted on the **Cyber7 / VexChat** backend (`cyber7-backend`) to evaluate the implementation status of the **WhatsApp Automation & Workflow Engine**.

### High-Level Verdict:
- **Frontend State:** A rich builder UI and mock dashboard exists at [`cyber7-frontend/app/automations/page.tsx`](file:///d:/Client-project/client-2/cyber7-frontend/app/automations/page.tsx), demonstrating intended workflows (Triggers: *Incoming Message, Keyword Match, New Contact, No Reply, Order Received*; Actions: *Send Message, Assign Agent, Add Tag, Notify Team, Send Template*).
- **Backend State:** **Partially Implemented Infrastructure, Engine Not Yet Wired.**
  - **Meta Cloud API Webhook Ingress:** Fully implemented & functional (`/api/whatsapp/webhook`). Verifies HMAC-SHA256 signatures, deduplicates message IDs (`waMessageId`), parses text/media/location payloads, manages contacts, and opens the Meta 24-hour customer service window.
  - **Compliance Keyword Routing:** Implemented (`STOP`, `UNSUBSCRIBE`, `CANCEL`, `OPTOUT`, `START`, `UNSTOP`).
  - **Business Automation Engine:** **0% implemented in the backend.** There are currently **no** database models for automation rules, **no** trigger event bus, **no** business-hours schedule evaluator, and **no** auto-ticket generator.

---

## 1. Feature Completion Checklist

| Automation Feature | Status | Current Codebase Implementation Details |
| :--- | :---: | :--- |
| **Meta Webhook Ingress & Deduplication** | **100% COMPLETE** | Handled in [`whatsapp-webhook.controller.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/controllers/whatsapp-webhook.controller.ts) & [`whatsapp-message.service.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/services/whatsapp-message.service.ts). Prevents duplicate processing via unique MongoDB index on `waMessageId`. |
| **Meta 24h Customer Service Window Tracking** | **100% COMPLETE** | Handled in [`conversation.model.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/whatsapp/conversation.model.ts). Updates `lastCustomerMessageAt`, activates `isCustomerServiceWindowActive = true`, and sets `customerServiceWindowExpiresAt = now + 24h`. Outbound text message dispatcher verifies window status. |
| **Compliance Opt-Out / Opt-In Tracking** | **100% COMPLETE** | Implemented via regex in [`whatsapp-message.service.ts#L145`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/services/whatsapp-message.service.ts#L145). `STOP` marks contact `isOptedOut: true` and closes conversation. `START` restores opt-in status. |
| **Auto-Replies / Welcome Messages** | ❌ **0% MISSING** | `processIncomingWhatsAppMessage` upserts `WhatsAppContact`, but **never dispatches a welcome trigger or auto-reply message**. |
| **Away Messages / Business Hours Logic** | ❌ **0% MISSING** | [`workspace-settings.model.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/setting/workspace-settings.model.ts) stores `timezone`, but **no business operating hours schedule or away message templates exist**. |
| **Keyword-Based Chat Routing** | ❌ **0% MISSING** | No business keyword parser (e.g. "support", "price", "order"). No automated conversation assignment (`conversation.assignedTo`). |
| **Automatic Customer Tagging / Lead Pipeline** | ❌ **0% MISSING** | [`contact.model.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/whatsapp/contact.model.ts) **lacks a `tags` array or lead stage field**. No tagging engine exists. |
| **Auto-Ticket Creation on Triggers** | ❌ **0% MISSING** | Support ticket engine exists in [`modules/support`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/support), but tickets can only be created via manual HTTP POST. Inbound WhatsApp messages cannot trigger tickets. |
| **Asynchronous Automation Worker/Queue** | ❌ **0% MISSING** | Inbound webhooks process synchronously. There is no decoupled event queue (BullMQ / EventEmitter) for executing multi-step automation rules. |

---

## 2. In-Depth Gap Analysis

### Gap 1: Synchronous Ingress vs Decoupled Event Processing
**Risk Level: HIGH (Webhook Timeouts & Meta Webhook Degradation)**
- **Issue:** In [`whatsapp-webhook.controller.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/controllers/whatsapp-webhook.controller.ts), incoming messages are handled directly in the HTTP request loop:
  ```typescript
  const result = await processIncomingWhatsAppMessage({ ... });
  ```
- **Architectural Requirement:** Meta Cloud API expects webhooks to return `HTTP 200 OK` within **3 seconds**. If automations (API calls, AI responses, DB queries) run synchronously inside the webhook handler, high traffic will trigger 504 timeouts, prompting Meta to disable the webhook endpoint.
- **Solution:** Immediately acknowledge Meta with `200 OK`, persist the message, and emit a Node.js event `whatsapp.message.received` or push to a Redis/BullMQ queue `automationQueue.add('evaluateRules', payload)`.

---

### Gap 2: Meta 24-Hour Customer Service Window Constraints in Automations
**Risk Level: CRITICAL (Meta API 131047 Errors & Number Suspension)**
- **Meta Policy:** Once a customer sends a message, a business has **24 hours** to send freeform text/media messages. Once this window lapses, freeform messages fail with:
  ```json
  {
    "error": {
      "message": "(#131047) Re-engagement message",
      "code": 131047,
      "error_data": { "details": "Message failed to send because more than 24 hours have passed since the customer last replied." }
    }
  }
  ```
- **Audit Finding:**
  - `sendWhatsAppTextMessage` in [`whatsapp-message.service.ts`](file:///d:/Client-project/client-2/cyber7-backend/src/modules/services/whatsapp-message.service.ts) correctly checks `isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt)`.
  - **However, any delayed automation** (such as *"No Reply after 30 minutes"* or *"Follow-up after 24 hours"*):
    1. If inside window (&le; 24h): Freeform message is permitted.
    2. If outside window (> 24h): The automation **MUST** require a registered Meta Template (`templateName`), or gracefully abort.
    3. If contact `isOptedOut === true`: Automation **MUST abort immediately**.

---

### Gap 3: Infinite Auto-Reply Loop (Bot-to-Bot Storms)
**Risk Level: HIGH (Financial Cost & Meta Rate Limiting)**
- **Vulnerability:** When a customer has an automated auto-responder (e.g. WhatsApp Business away message or another SaaS bot), VexChat sending an auto-reply will trigger the customer's bot, which triggers VexChat again in an infinite loop.
- **Solution:** 
  1. Add a debounce/rate-limit per contact: A welcome or away message rule can trigger at most **once every 24 hours** per contact.
  2. Maintain a `lastAutomatedReplyAt` timestamp on `WhatsAppConversation`.

---

### Gap 4: Database Model Gaps
1. **Missing `AutomationRule` Model:** No schema to store triggers, conditions, actions, and status.
2. **Missing `tags` on `WhatsAppContact`:** `IWhatsAppContact` has no tags property.
3. **Missing `businessHours` on `WorkspaceSettings`:** No schedule configuration to determine "In Hours" vs "After Hours".

---

## 3. Production Architecture Blueprint

```
                     ┌────────────────────────────────────────────────────────┐
                     │              Meta WhatsApp Cloud API                   │
                     └──────────────────────────┬─────────────────────────────┘
                                                │ Inbound Webhook POST
                                                ▼
                     ┌────────────────────────────────────────────────────────┐
                     │          whatsapp-webhook.controller.ts                │
                     │          • Verify HMAC-SHA256 Signature                │
                     │          • Filter message types                        │
                     └──────────────────────────┬─────────────────────────────┘
                                                │
                                                ▼
                     ┌────────────────────────────────────────────────────────┐
                     │          whatsapp-message.service.ts                   │
                     │          • Deduplicate waMessageId                     │
                     │          • Check STOP/START compliance                 │
                     │          • Upsert Contact & Conversation (24h window)  │
                     │          • Save WhatsAppMessage (status: RECEIVED)     │
                     └──────────────────────────┬─────────────────────────────┘
                                                │
                                                ▼ (Asynchronous Dispatch)
                     ┌────────────────────────────────────────────────────────┐
                     │            automation-engine.service.ts                │
                     │  1. Check Contact.isOptedOut (Abort if opted out)      │
                     │  2. Check Loop Guard (Max 1 auto-reply per 24h)        │
                     │  3. Fetch active rules for workspace                   │
                     └──────┬───────────────────┬──────────────────────┬──────┘
                            │                   │                      │
       Trigger: NEW_CONTACT │ Trigger: KEYWORD  │ Trigger: AWAY_HOURS  │ Trigger: TICKET
                            ▼                   ▼                      ▼
                     ┌─────────────┐     ┌─────────────┐        ┌─────────────┐
                     │ Send Welcome│     │ Route Agent │        │ Auto-Create │
                     │ Text/Templ  │     │ Add Tags    │        │ Support     │
                     │ (Window ok) │     │ Send FAQ    │        │ Desk Ticket │
                     └─────────────┘     └─────────────┘        └─────────────┘
```

---

## 4. Implementation Codebase Specifications

### 4.1. Automation Rule Model (`src/modules/whatsapp/automation-rule.model.ts`)

```typescript
import mongoose, { Schema, Document, Types } from "mongoose";

export type AutomationTriggerType =
  | "NEW_CONTACT"
  | "INCOMING_MESSAGE"
  | "KEYWORD_MATCH"
  | "AWAY_HOURS"
  | "NO_REPLY";

export type AutomationActionType =
  | "SEND_MESSAGE"
  | "SEND_TEMPLATE"
  | "ASSIGN_AGENT"
  | "ADD_TAGS"
  | "CREATE_TICKET";

export interface IAutomationRule extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  trigger: AutomationTriggerType;
  // Keyword matching: comma-separated or array of phrases
  keywords?: string[];
  matchType?: "EXACT" | "CONTAINS" | "STARTS_WITH";
  // Actions
  action: AutomationActionType;
  actionConfig: {
    messageBody?: string;
    templateName?: string;
    templateLanguage?: string;
    assignedUserId?: Types.ObjectId;
    tags?: string[];
    ticketPriority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  };
  isActive: boolean;
  executionsCount: number;
  lastExecutedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const automationRuleSchema = new Schema<IAutomationRule>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    trigger: {
      type: String,
      enum: ["NEW_CONTACT", "INCOMING_MESSAGE", "KEYWORD_MATCH", "AWAY_HOURS", "NO_REPLY"],
      required: true,
      index: true,
    },
    keywords: [{ type: String, lowercase: true, trim: true }],
    matchType: { type: String, enum: ["EXACT", "CONTAINS", "STARTS_WITH"], default: "CONTAINS" },
    action: {
      type: String,
      enum: ["SEND_MESSAGE", "SEND_TEMPLATE", "ASSIGN_AGENT", "ADD_TAGS", "CREATE_TICKET"],
      required: true,
    },
    actionConfig: {
      messageBody: { type: String },
      templateName: { type: String },
      templateLanguage: { type: String, default: "en" },
      assignedUserId: { type: Schema.Types.ObjectId, ref: "User" },
      tags: [{ type: String, trim: true }],
      ticketPriority: { type: String, enum: ["LOW", "MEDIUM", "HIGH", "URGENT"], default: "MEDIUM" },
    },
    isActive: { type: Boolean, default: true, index: true },
    executionsCount: { type: Number, default: 0 },
    lastExecutedAt: { type: Date },
  },
  { timestamps: true }
);

automationRuleSchema.index({ workspaceId: 1, isActive: 1, trigger: 1 });

export const AutomationRule = mongoose.model<IAutomationRule>("AutomationRule", automationRuleSchema);
export default AutomationRule;
```

---

### 4.2. Contact Schema Enhancement (`src/modules/whatsapp/contact.model.ts`)

Add `tags` and `leadStatus` to `IWhatsAppContact`:

```typescript
// Add to contact.model.ts Schema
tags: {
  type: [String],
  default: [],
  index: true,
},
leadStatus: {
  type: String,
  enum: ["NEW", "CONTACTED", "QUALIFIED", "UNQUALIFIED", "CONVERTED"],
  default: "NEW",
  index: true,
},
```

---

### 4.3. Business Hours & Away Settings (`src/modules/setting/workspace-settings.model.ts`)

Add `businessHours` and `awayMessage` to `IBusinessProfile`:

```typescript
export interface IBusinessHours {
  enabled: boolean;
  schedule: Array<{
    day: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
    isOpen: boolean;
    openTime: string;  // "09:00"
    closeTime: string; // "18:00"
  }>;
  awayMessageEnabled: boolean;
  awayMessageBody: string;
}
```

---

### 4.4. Automation Execution Engine (`src/modules/whatsapp/automation-engine.service.ts`)

```typescript
import { AutomationRule } from "./automation-rule.model.js";
import WhatsAppContact from "./contact.model.js";
import WhatsAppConversation, { isCustomerServiceWindowOpen } from "./conversation.model.js";
import { sendWhatsAppTextMessage, sendWhatsAppTemplateMessage } from "../services/whatsapp-message.service.js";
import { supportTicketService } from "../support/support-ticket.service.js";
import WorkspaceSettings from "../setting/workspace-settings.model.js";

export interface ExecuteAutomationsParams {
  workspaceId: string;
  contactId: string;
  conversationId: string;
  messageText?: string;
  isNewContact: boolean;
}

export async function executeInboundAutomations({
  workspaceId,
  contactId,
  conversationId,
  messageText = "",
  isNewContact,
}: ExecuteAutomationsParams): Promise<void> {
  const contact = await WhatsAppContact.findById(contactId);
  const conversation = await WhatsAppConversation.findById(conversationId);
  if (!contact || !conversation) return;

  // 1. Compliance Guard: Do not run automations if user opted out (STOP)
  if (contact.isOptedOut) {
    return;
  }

  // 2. Fetch all active rules for this workspace
  const rules = await AutomationRule.find({
    workspaceId,
    isActive: true,
  });
  if (rules.length === 0) return;

  const normalizedText = messageText.trim().toLowerCase();
  const windowOpen = isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt);

  for (const rule of rules) {
    let isMatch = false;

    // A. Trigger Evaluation
    if (rule.trigger === "NEW_CONTACT" && isNewContact) {
      isMatch = true;
    } else if (rule.trigger === "KEYWORD_MATCH" && rule.keywords && rule.keywords.length > 0) {
      isMatch = rule.keywords.some((kw) => {
        const cleanKw = kw.toLowerCase().trim();
        if (rule.matchType === "EXACT") return normalizedText === cleanKw;
        if (rule.matchType === "STARTS_WITH") return normalizedText.startsWith(cleanKw);
        return normalizedText.includes(cleanKw);
      });
    } else if (rule.trigger === "INCOMING_MESSAGE") {
      isMatch = true;
    }

    if (!isMatch) continue;

    // B. Action Execution
    try {
      switch (rule.action) {
        case "SEND_MESSAGE": {
          if (rule.actionConfig.messageBody && windowOpen) {
            await sendWhatsAppTextMessage({
              workspaceId,
              conversationId,
              text: rule.actionConfig.messageBody,
            });
          }
          break;
        }

        case "SEND_TEMPLATE": {
          if (rule.actionConfig.templateName) {
            await sendWhatsAppTemplateMessage({
              workspaceId,
              conversationId,
              templateName: rule.actionConfig.templateName,
              language: rule.actionConfig.templateLanguage || "en",
            });
          }
          break;
        }

        case "ASSIGN_AGENT": {
          if (rule.actionConfig.assignedUserId) {
            conversation.assignedTo = rule.actionConfig.assignedUserId;
            await conversation.save();
          }
          break;
        }

        case "ADD_TAGS": {
          if (rule.actionConfig.tags && rule.actionConfig.tags.length > 0) {
            await WhatsAppContact.findByIdAndUpdate(contactId, {
              $addToSet: { tags: { $each: rule.actionConfig.tags } },
            });
          }
          break;
        }

        case "CREATE_TICKET": {
          await supportTicketService.createTicket(
            {
              workspaceId,
              customerName: contact.profileName || contact.phoneNumber,
              customerEmail: `${contact.phoneNumber}@whatsapp.customer`,
              subject: `WhatsApp Escalation: ${messageText.slice(0, 60)}...`,
              priority: rule.actionConfig.ticketPriority || "MEDIUM",
              initialMessage: messageText,
            },
            { adminEmail: "automation-engine@vexchat.app" }
          );
          break;
        }
      }

      // Record rule execution count
      rule.executionsCount += 1;
      rule.lastExecutedAt = new Date();
      await rule.save();
    } catch (actionErr) {
      console.error(`[Automation Engine] Action failed for rule ${rule._id}:`, actionErr);
    }
  }
}
```

---

### 4.5. Hooking into `whatsapp-webhook.controller.ts`

Right after saving the incoming message in `whatsapp-webhook.controller.ts`:
```typescript
// Asynchronously trigger automation engine (do not block Meta Webhook HTTP response)
setImmediate(() => {
  executeInboundAutomations({
    workspaceId: account.workspaceId.toString(),
    contactId: contact._id.toString(),
    conversationId: conversation._id.toString(),
    messageText: message.text || "",
    isNewContact: Boolean(contactCreatedAtSameAsIncoming),
  }).catch((err) => console.error("[Automation Engine Ingress Error]", err));
});
```

---

## 5. Next Steps & Implementation Roadmap

1. **Phase 1: Persistence & Schema (Day 1)**
   - Create `AutomationRule` model and export schema.
   - Update `WhatsAppContact` model to support `tags: string[]` and `leadStatus`.
   - Update `WorkspaceSettings` to store business hours and away templates.

2. **Phase 2: Execution Engine & Webhook Hook (Day 2)**
   - Implement `executeInboundAutomations` in `src/modules/whatsapp/automation-engine.service.ts`.
   - Hook into `processIncomingWhatsAppMessage` / `whatsapp-webhook.controller.ts` with `setImmediate()` or a BullMQ queue.
   - Enforce Meta 24h Customer Service Window check & opt-out guards.

3. **Phase 3: Automation CRUD REST API (Day 3)**
   - Mount `/api/workspaces/:workspaceId/automations` with `GET`, `POST`, `PATCH`, `DELETE`.
   - Connect the existing Next.js frontend at `cyber7-frontend/app/automations/page.tsx` to live backend data (replacing the mock data array).

4. **Phase 4: Verification & Automated Integration Test Suite (Day 4)**
   - Write integration tests simulating:
     - New contact triggers welcome text.
     - "price" keyword triggers tag "pricing-lead" and auto-reply.
     - "broken / bug / support" triggers `SupportTicket` creation.
     - Out-of-window messages reject freeform text and require template.
     - "STOP" message halts all future automations.

