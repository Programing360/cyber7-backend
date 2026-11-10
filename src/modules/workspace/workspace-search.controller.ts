import type { Response, NextFunction } from "express";
import mongoose from "mongoose";

import WhatsAppContact from "../whatsapp/contact.model.js";
import WhatsAppMessage from "../whatsapp/message.model.js";
import Campaign from "../campaign/campaign.model.js";
import AutomationRule from "../whatsapp/automation-rule.model.js";
import CallLog from "../Calling/CallLog.js";
import SupportTicket from "../support/support-ticket.model.js";
import Workspace from "./workspace.model.js";
import User from "../auth/user.model.js";
import Subscription from "../billing/subscription.model.js";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";

function escapeRegex(text: string): string {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle: string;
  type: "contact" | "campaign" | "automation" | "ticket" | "call" | "navigation";
  url: string;
}

const SYSTEM_NAVIGATION_PAGES = [
  {
    id: "nav-dashboard",
    title: "Dashboard Overview",
    subtitle: "Analytics, summaries & quick stats",
    url: "/dashboard",
    keywords: ["home", "stats", "overview", "analytics", "dashboard"],
  },
  {
    id: "nav-chat",
    title: "Live Chat & Inbox",
    subtitle: "WhatsApp conversations & messages",
    url: "/chat",
    keywords: ["chat", "messages", "inbox", "whatsapp", "conversation"],
  },
  {
    id: "nav-contacts",
    title: "Contacts Directory",
    subtitle: "Audience & contact management",
    url: "/contacts",
    keywords: ["contacts", "audience", "customers", "leads", "phonebook"],
  },
  {
    id: "nav-campaigns",
    title: "WhatsApp Campaigns",
    subtitle: "Broadcast marketing & scheduled campaigns",
    url: "/campaigns",
    keywords: ["campaigns", "broadcast", "bulk", "marketing", "promo"],
  },
  {
    id: "nav-automations",
    title: "Automations & Bots",
    subtitle: "Auto-replies, keyword triggers & rules",
    url: "/automations",
    keywords: ["automation", "auto-reply", "bot", "rules", "triggers", "workflows"],
  },
  {
    id: "nav-calling",
    title: "Voice Calling",
    subtitle: "WebRTC browser softphone & call logs",
    url: "/calling",
    keywords: ["call", "calling", "phone", "voice", "softphone", "dialer"],
  },
  {
    id: "nav-templates",
    title: "Message Templates",
    subtitle: "Approved Meta WhatsApp templates",
    url: "/templates",
    keywords: ["templates", "meta", "hsm", "approved"],
  },
  {
    id: "nav-team",
    title: "Team & Members",
    subtitle: "Workspace collaborators & permissions",
    url: "/team",
    keywords: ["team", "members", "users", "agents", "invite", "roles"],
  },
  {
    id: "nav-support",
    title: "Customer Support Desk",
    subtitle: "Helpdesk tickets & platform inquiries",
    url: "/support",
    keywords: ["support", "tickets", "help", "issues", "desk"],
  },
  {
    id: "nav-billing",
    title: "Billing & Plans",
    subtitle: "Subscriptions, invoices & payments",
    url: "/billing",
    keywords: ["billing", "subscription", "plans", "pricing", "invoice", "payment", "zinipay", "bkash"],
  },
  {
    id: "nav-settings",
    title: "Workspace Settings",
    subtitle: "General configurations, API keys & webhooks",
    url: "/settings",
    keywords: ["settings", "config", "api", "webhook", "profile"],
  },
  {
    id: "nav-profile",
    title: "My Profile",
    subtitle: "Personal account settings & credentials",
    url: "/my-profile",
    keywords: ["profile", "account", "user", "password"],
  },
];

/**
 * Universal runtime workspace search controller
 * GET /api/workspaces/:workspaceId/search?q={query}
 */
export const workspaceSearchController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) {
      res.status(400).json({ success: false, message: "Workspace context missing." });
      return;
    }

    const rawQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!rawQuery) {
      res.status(200).json({
        success: true,
        data: {
          contacts: [],
          campaigns: [],
          automations: [],
          tickets: [],
          calls: [],
          navigation: [],
          totalCount: 0,
        },
      });
      return;
    }

    const queryLower = rawQuery.toLowerCase();
    const escaped = escapeRegex(rawQuery);
    const searchRegex = new RegExp(escaped, "i");
    const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);

    // Concurrently search across runtime MongoDB collections
    const [
      contacts,
      campaigns,
      automations,
      tickets,
      calls,
    ] = await Promise.all([
      // 1. Contacts
      WhatsAppContact.find({
        workspaceId: workspaceObjId,
        $or: [
          { profileName: searchRegex },
          { phoneNumber: searchRegex },
          { waId: searchRegex },
          { tags: searchRegex },
        ],
      })
        .select("_id profileName phoneNumber waId leadStatus")
        .limit(5)
        .lean(),

      // 2. Campaigns
      Campaign.find({
        workspaceId: workspaceObjId,
        $or: [
          { name: searchRegex },
          { status: searchRegex },
        ],
      })
        .select("_id name status totalRecipients sentCount")
        .limit(5)
        .lean(),

      // 3. Automations
      AutomationRule.find({
        workspaceId: workspaceObjId,
        $or: [
          { name: searchRegex },
          { trigger: searchRegex },
          { keywords: searchRegex },
        ],
      })
        .select("_id name trigger action isActive")
        .limit(5)
        .lean(),

      // 4. Support Tickets
      SupportTicket.find({
        workspaceId: workspaceObjId,
        $or: [
          { ticketNumber: searchRegex },
          { subject: searchRegex },
          { customerName: searchRegex },
          { customerEmail: searchRegex },
        ],
      })
        .select("_id ticketNumber subject priority status")
        .limit(5)
        .lean(),

      // 5. Call Logs
      CallLog.find({
        workspaceId: workspaceObjId,
        $or: [
          { callerName: searchRegex },
          { phoneNumber: searchRegex },
        ],
      })
        .select("_id callerName phoneNumber callType status createdAt")
        .limit(5)
        .lean(),
    ]);

    // 6. Navigation matches
    const matchedNavigation = SYSTEM_NAVIGATION_PAGES.filter(
      (page) =>
        page.title.toLowerCase().includes(queryLower) ||
        page.subtitle.toLowerCase().includes(queryLower) ||
        page.url.toLowerCase().includes(queryLower) ||
        page.keywords.some((k) => k.toLowerCase().includes(queryLower)),
    ).slice(0, 5);

    const formattedContacts: SearchResultItem[] = contacts.map((c) => ({
      id: c._id.toString(),
      title: c.profileName || c.phoneNumber || "Unknown Contact",
      subtitle: `${c.phoneNumber} • ${c.leadStatus || "Contact"}`,
      type: "contact",
      url: `/chat?contactId=${c._id.toString()}`,
    }));

    const formattedCampaigns: SearchResultItem[] = campaigns.map((cmp) => ({
      id: cmp._id.toString(),
      title: cmp.name,
      subtitle: `Status: ${cmp.status} • ${cmp.totalRecipients || 0} recipients`,
      type: "campaign",
      url: "/campaigns",
    }));

    const formattedAutomations: SearchResultItem[] = automations.map((a) => ({
      id: a._id.toString(),
      title: a.name,
      subtitle: `Trigger: ${a.trigger} • Action: ${a.action} (${a.isActive ? "Active" : "Paused"})`,
      type: "automation",
      url: "/automations",
    }));

    const formattedTickets: SearchResultItem[] = tickets.map((t) => ({
      id: t._id.toString(),
      title: `#${t.ticketNumber} - ${t.subject}`,
      subtitle: `Status: ${t.status} • Priority: ${t.priority}`,
      type: "ticket",
      url: "/support",
    }));

    const formattedCalls: SearchResultItem[] = calls.map((cl) => ({
      id: (cl as any)._id.toString(),
      title: (cl as any).callerName || (cl as any).phoneNumber || "Call",
      subtitle: `${(cl as any).callType || "CALL"} • ${(cl as any).status || "ENDED"}`,
      type: "call",
      url: "/calling",
    }));

    const formattedNav: SearchResultItem[] = matchedNavigation.map((n) => ({
      id: n.id,
      title: n.title,
      subtitle: n.subtitle,
      type: "navigation",
      url: n.url,
    }));

    const totalCount =
      formattedContacts.length +
      formattedCampaigns.length +
      formattedAutomations.length +
      formattedTickets.length +
      formattedCalls.length +
      formattedNav.length;

    res.status(200).json({
      success: true,
      data: {
        contacts: formattedContacts,
        campaigns: formattedCampaigns,
        automations: formattedAutomations,
        tickets: formattedTickets,
        calls: formattedCalls,
        navigation: formattedNav,
        totalCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

export interface WorkspaceNotificationItem {
  id: string;
  category: "message" | "call" | "campaign" | "support" | "system";
  title: string;
  description: string;
  timestamp: string;
  read: boolean;
  url: string;
}

/**
 * Workspace notifications & activity stream controller
 * GET /api/workspaces/:workspaceId/notifications
 */
export const workspaceNotificationsController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) {
      res.status(400).json({ success: false, message: "Workspace context missing." });
      return;
    }

    const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);

    // Concurrently fetch recent workspace activity
    const [
      workspace,
      latestMessages,
      recentCalls,
      recentCampaigns,
      recentTickets,
      activeSubscription,
    ] = await Promise.all([
      Workspace.findById(workspaceObjId).select("ownerId name status").lean(),
      WhatsAppMessage.find({
        workspaceId: workspaceObjId,
        direction: "INBOUND",
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      CallLog.find({
        workspaceId: workspaceObjId,
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      Campaign.find({
        workspaceId: workspaceObjId,
      })
        .sort({ updatedAt: -1 })
        .limit(3)
        .lean(),
      SupportTicket.find({
        workspaceId: workspaceObjId,
      })
        .sort({ updatedAt: -1 })
        .limit(3)
        .lean(),
      Subscription.findOne({
        workspaceId: workspaceObjId,
        status: "ACTIVE",
      }).lean(),
    ]);

    const notifications: WorkspaceNotificationItem[] = [];

    // 1. Inbound message notifications
    for (const msg of latestMessages) {
      const previewText = msg.text
        ? msg.text.slice(0, 60) + (msg.text.length > 60 ? "..." : "")
        : msg.type ? `Received ${msg.type.toLowerCase()}` : "New incoming message";

      notifications.push({
        id: `msg-${msg._id.toString()}`,
        category: "message",
        title: "New WhatsApp Message",
        description: previewText,
        timestamp: new Date(msg.createdAt).toISOString(),
        read: msg.status === "READ",
        url: "/chat",
      });
    }

    // 2. Call notifications
    for (const call of recentCalls) {
      const isMissed = (call as any).status === "MISSED" || (call as any).status === "FAILED";
      const title = isMissed
        ? `Missed Call (${(call as any).callerName || (call as any).phoneNumber || "Unknown"})`
        : `Call ${(call as any).status} with ${(call as any).callerName || (call as any).phoneNumber || "Customer"}`;

      notifications.push({
        id: `call-${(call as any)._id.toString()}`,
        category: "call",
        title,
        description: `${(call as any).callType || "CALL"} • ${(call as any).phoneNumber || ""}`,
        timestamp: new Date((call as any).createdAt).toISOString(),
        read: !isMissed,
        url: "/calling",
      });
    }

    // 3. Campaign updates
    for (const cmp of recentCampaigns) {
      notifications.push({
        id: `cmp-${cmp._id.toString()}`,
        category: "campaign",
        title: `Campaign: ${cmp.name}`,
        description: `Status: ${cmp.status} • Delivered: ${cmp.deliveredCount || 0}/${cmp.totalRecipients || 0}`,
        timestamp: new Date(cmp.updatedAt).toISOString(),
        read: cmp.status === "COMPLETED",
        url: "/campaigns",
      });
    }

    // 4. Support Ticket updates
    for (const t of recentTickets) {
      notifications.push({
        id: `ticket-${t._id.toString()}`,
        category: "support",
        title: `Ticket #${t.ticketNumber}: ${t.subject}`,
        description: `Status: ${t.status} • Priority: ${t.priority}`,
        timestamp: new Date(t.updatedAt).toISOString(),
        read: t.status === "RESOLVED" || t.status === "CLOSED",
        url: "/support",
      });
    }

    // 5. System Trial / Plan notification
    if (workspace?.ownerId) {
      const owner = await User.findById(workspace.ownerId).select("trialEndDate isPaid subscriptionStatus").lean();
      if (owner) {
        const now = Date.now();
        if (!owner.isPaid && owner.trialEndDate) {
          const endMs = new Date(owner.trialEndDate).getTime();
          const diffDays = Math.ceil((endMs - now) / (1000 * 60 * 60 * 24));
          if (diffDays > 0) {
            notifications.push({
              id: "sys-trial-status",
              category: "system",
              title: "Free Trial Active",
              description: `You have ${diffDays} day${diffDays === 1 ? "" : "s"} left on your free trial.`,
              timestamp: new Date().toISOString(),
              read: diffDays > 2,
              url: "/billing",
            });
          } else {
            notifications.push({
              id: "sys-trial-expired",
              category: "system",
              title: "Free Trial Expired",
              description: "Your 7-day trial has ended. Subscribe to a plan to continue messaging.",
              timestamp: new Date().toISOString(),
              read: false,
              url: "/billing",
            });
          }
        } else if (activeSubscription) {
          notifications.push({
            id: `sys-sub-${activeSubscription._id.toString()}`,
            category: "system",
            title: `Plan: ${activeSubscription.planName}`,
            description: `Active subscription renewing on ${new Date(activeSubscription.currentPeriodEnd).toLocaleDateString()}`,
            timestamp: new Date(activeSubscription.updatedAt || new Date()).toISOString(),
            read: true,
            url: "/billing",
          });
        }
      }
    }

    // Sort by timestamp descending
    notifications.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const unreadCount = notifications.filter((n) => !n.read).length;

    res.status(200).json({
      success: true,
      data: {
        notifications,
        unreadCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

