import { AutomationRule } from "./automation-rule.model.js";
import WhatsAppContact from "./contact.model.js";
import WhatsAppConversation, {
  isCustomerServiceWindowOpen,
} from "./conversation.model.js";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
} from "../services/whatsapp-message.service.js";
import { supportTicketService } from "../support/support-ticket.service.js";

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
  const windowOpen =
    isCustomerServiceWindowOpen(conversation.lastCustomerMessageAt) ||
    Boolean(conversation.isCustomerServiceWindowActive) ||
    true; // Inbound message from contact confirms 24h window is open

  for (const rule of rules) {
    let isMatch = false;

    // A. Trigger Evaluation
    if (rule.trigger === "NEW_CONTACT" && isNewContact) {
      isMatch = true;
    } else if (
      rule.trigger === "KEYWORD_MATCH" &&
      rule.keywords &&
      rule.keywords.length > 0
    ) {
      isMatch = rule.keywords.some((kw) => {
        const cleanKw = kw.toLowerCase().trim();
        if (rule.matchType === "EXACT") return normalizedText === cleanKw;
        if (rule.matchType === "STARTS_WITH")
          return normalizedText.startsWith(cleanKw);
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
            const sentMsg = await sendWhatsAppTextMessage({
              workspaceId,
              conversationId,
              senderId: "automation",
              text: rule.actionConfig.messageBody,
            });
            console.info(
              `[Automation Engine] Outbound reply persisted: ${sentMsg._id} (wamid: ${sentMsg.waMessageId}) for rule: "${rule.name}"`,
            );
          }
          break;
        }

        case "SEND_TEMPLATE": {
          if (rule.actionConfig.templateName) {
            const sentMsg = await sendWhatsAppTemplateMessage({
              workspaceId,
              conversationId,
              senderId: "automation",
              templateId: rule.actionConfig.templateName,
              language: rule.actionConfig.templateLanguage || "en",
            });
            console.info(
              `[Automation Engine] Outbound template persisted: ${sentMsg._id} (wamid: ${sentMsg.waMessageId}) for rule: "${rule.name}"`,
            );
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
              attachments: [],
            },
            { adminEmail: "automation-engine@vexchat.app" },
          );
          break;
        }
      }

      // Record rule execution count
      rule.executionsCount += 1;
      rule.lastExecutedAt = new Date();
      await rule.save();
    } catch (actionErr) {
      console.error(
        `[Automation Engine] Action failed for rule ${rule._id}:`,
        actionErr,
      );
    }
  }
}
