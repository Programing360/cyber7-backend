import { Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import WhatsAppConversation from "../whatsapp/conversation.model.js";
import WhatsAppMessage from "../whatsapp/message.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";

export interface DashboardStatsOverview {
  totalContacts: number;
  totalConversations: number;
  openConversations: number;
  closedConversations: number;
  pendingConversations: number;
  totalMessages: number;
  inboundMessages: number;
  outboundMessages: number;
}

export interface DashboardWhatsAppStats {
  totalAccounts: number;
  connectedAccounts: number;
  disconnectedAccounts: number;
}

export interface DashboardMessageDateStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
}

export interface DashboardRecentConversationItem {
  id: string;
  name: string;
  phoneNumber: string;
  message: string;
  time: string;
  timestamp: string;
  initials: string;
  color: string;
  unread: number;
  status: string;
}

export interface DashboardMessageActivityItem {
  date: string;
  day: string;
  incoming: number;
  outgoing: number;
}

export interface DashboardStatsResult {
  overview: DashboardStatsOverview;
  whatsapp: DashboardWhatsAppStats;
  messages: DashboardMessageDateStats;
  recentConversations: DashboardRecentConversationItem[];
  messageActivity: DashboardMessageActivityItem[];
}

const AVATAR_COLORS = [
  "bg-purple-100 text-purple-700",
  "bg-blue-100 text-blue-700",
  "bg-pink-100 text-pink-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) {
    const single = parts[0];
    return single ? single.substring(0, 2).toUpperCase() : "??";
  }
  const first = parts[0];
  const second = parts[1];
  return `${first ? first[0] : ""}${second ? second[0] : ""}`.toUpperCase();
}

function formatRelativeTime(date: Date, now = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "Just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Calculates date boundaries strictly in the Asia/Dhaka (+06:00) timezone.
 * Asia/Dhaka has a permanent offset of UTC+6 (no Daylight Saving Time).
 */
export function getDhakaDateBoundaries(now = new Date()) {
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
  const dhakaLocal = new Date(now.getTime() + DHAKA_OFFSET_MS);

  const year = dhakaLocal.getUTCFullYear();
  const month = dhakaLocal.getUTCMonth();
  const date = dhakaLocal.getUTCDate();
  const dayOfWeek = dhakaLocal.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Start of today in Dhaka (00:00:00.000 Dhaka local time) converted to UTC
  const startOfTodayUtc = new Date(
    Date.UTC(year, month, date, 0, 0, 0, 0) - DHAKA_OFFSET_MS,
  );

  // Start of this week in Dhaka (Monday 00:00:00.000 Dhaka local time)
  // Standard ISO-8601 week starts on Monday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const startOfWeekUtc = new Date(
    startOfTodayUtc.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000,
  );

  // Start of this month in Dhaka (1st of current month at 00:00:00.000 Dhaka local time)
  const startOfMonthUtc = new Date(
    Date.UTC(year, month, 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS,
  );

  return {
    startOfTodayUtc,
    startOfWeekUtc,
    startOfMonthUtc,
  };
}

interface GetDashboardStatsOptions {
  workspaceId: string;
  activityDays?: number;
}

export async function getWorkspaceDashboardStats({
  workspaceId,
  activityDays = 7,
}: GetDashboardStatsOptions): Promise<DashboardStatsResult> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const targetWorkspaceId = new Types.ObjectId(workspaceId);
  const now = new Date();
  const { startOfTodayUtc, startOfWeekUtc, startOfMonthUtc } =
    getDhakaDateBoundaries(now);

  const validDays = [7, 30, 90].includes(activityDays) ? activityDays : 7;
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
  const periodStartUtc = new Date(
    startOfTodayUtc.getTime() - (validDays - 1) * 24 * 60 * 60 * 1000,
  );
  const periodEndUtc = new Date(
    startOfTodayUtc.getTime() + 24 * 60 * 60 * 1000,
  );

  // Parallelized workspace-scoped queries with zero N+1 database operations
  const [
    totalContacts,
    conversationStatusAggregation,
    messageDirectionAggregation,
    whatsappAccountAggregation,
    messagesToday,
    messagesThisWeek,
    messagesThisMonth,
    recentConversationsRaw,
    activityAggregation,
  ] = await Promise.all([
    // 1. Total Contacts count
    WhatsAppContact.countDocuments({ workspaceId: targetWorkspaceId }),

    // 2. Conversation counts grouped by status
    WhatsAppConversation.aggregate<{ _id: string; count: number }>([
      { $match: { workspaceId: targetWorkspaceId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // 3. Message counts grouped by direction
    WhatsAppMessage.aggregate<{ _id: string; count: number }>([
      { $match: { workspaceId: targetWorkspaceId } },
      { $group: { _id: "$direction", count: { $sum: 1 } } },
    ]),

    // 4. WhatsApp accounts grouped by status
    WhatsAppAccount.aggregate<{ _id: string; count: number }>([
      { $match: { workspaceId: targetWorkspaceId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // 5. Messages today (Asia/Dhaka)
    WhatsAppMessage.countDocuments({
      workspaceId: targetWorkspaceId,
      timestamp: { $gte: startOfTodayUtc },
    }),

    // 6. Messages this week (Asia/Dhaka)
    WhatsAppMessage.countDocuments({
      workspaceId: targetWorkspaceId,
      timestamp: { $gte: startOfWeekUtc },
    }),

    // 7. Messages this month (Asia/Dhaka)
    WhatsAppMessage.countDocuments({
      workspaceId: targetWorkspaceId,
      timestamp: { $gte: startOfMonthUtc },
    }),

    // 8. Recent conversations (top 5 sorted by last activity)
    WhatsAppConversation.find({ workspaceId: targetWorkspaceId })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(5)
      .populate("contactId", "profileName phoneNumber waId")
      .lean(),

    // 9. Message activity over requested window grouped by Dhaka calendar date and direction
    WhatsAppMessage.aggregate<{
      _id: { date: string; direction: string };
      count: number;
    }>([
      {
        $match: {
          workspaceId: targetWorkspaceId,
          timestamp: { $gte: periodStartUtc, $lt: periodEndUtc },
        },
      },
      {
        $project: {
          direction: 1,
          dateStr: {
            $dateToString: {
              date: "$timestamp",
              timezone: "+06:00",
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $group: {
          _id: {
            date: "$dateStr",
            direction: "$direction",
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  // Process Conversation Statuses
  let openConversations = 0;
  let closedConversations = 0;
  let pendingConversations = 0;

  for (const item of conversationStatusAggregation) {
    if (item._id === "OPEN") openConversations = item.count;
    else if (item._id === "CLOSED") closedConversations = item.count;
    else if (item._id === "PENDING") pendingConversations = item.count;
  }
  const totalConversations =
    openConversations + closedConversations + pendingConversations;

  // Process Message Directions
  let inboundMessages = 0;
  let outboundMessages = 0;

  for (const item of messageDirectionAggregation) {
    if (item._id === "INBOUND") inboundMessages = item.count;
    else if (item._id === "OUTBOUND") outboundMessages = item.count;
  }
  const totalMessages = inboundMessages + outboundMessages;

  // Process WhatsApp Account Statuses
  let connectedAccounts = 0;
  let disconnectedAccounts = 0;
  let totalAccounts = 0;

  for (const item of whatsappAccountAggregation) {
    totalAccounts += item.count;
    if (item._id === "CONNECTED") {
      connectedAccounts = item.count;
    } else {
      disconnectedAccounts += item.count;
    }
  }

  // Process Recent Conversations (Batch fetch latest message and unread count)
  const conversationIds = recentConversationsRaw.map((c) => c._id);
  const latestMessageMap = new Map<string, { text?: string; type?: string; timestamp: Date }>();
  const unreadCountMap = new Map<string, number>();

  if (conversationIds.length > 0) {
    const [latestMessages, unreadAggregations] = await Promise.all([
      WhatsAppMessage.aggregate([
        {
          $match: {
            conversationId: { $in: conversationIds },
            workspaceId: targetWorkspaceId,
          },
        },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: "$conversationId",
            lastMessage: {
              $first: {
                text: "$text",
                type: "$type",
                timestamp: "$timestamp",
              },
            },
          },
        },
      ]),
      WhatsAppMessage.aggregate<{ _id: Types.ObjectId; count: number }>([
        {
          $match: {
            conversationId: { $in: conversationIds },
            workspaceId: targetWorkspaceId,
            direction: "INBOUND",
            status: { $ne: "READ" },
          },
        },
        {
          $group: {
            _id: "$conversationId",
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    for (const item of latestMessages) {
      latestMessageMap.set(item._id.toString(), item.lastMessage);
    }
    for (const item of unreadAggregations) {
      unreadCountMap.set(item._id.toString(), item.count);
    }
  }

  const recentConversations: DashboardRecentConversationItem[] =
    recentConversationsRaw.map((conv, index) => {
      const convIdStr = conv._id.toString();
      const contact = conv.contactId as
        | { profileName?: string; phoneNumber?: string; waId?: string }
        | undefined;
      const lastMsg = latestMessageMap.get(convIdStr);
      const unread = unreadCountMap.get(convIdStr) || 0;

      const name =
        contact?.profileName?.trim() ||
        contact?.phoneNumber?.trim() ||
        contact?.waId?.trim() ||
        "Unknown Contact";
      const phoneNumber = contact?.phoneNumber || contact?.waId || "";

      let messageSnippet = "No messages yet";
      if (lastMsg) {
        if (lastMsg.text && lastMsg.text.trim()) {
          messageSnippet = lastMsg.text.trim();
        } else if (lastMsg.type) {
          messageSnippet = `[${lastMsg.type.charAt(0).toUpperCase() + lastMsg.type.slice(1).toLowerCase()}]`;
        }
      }

      const msgTimestamp =
        lastMsg?.timestamp || conv.lastMessageAt || conv.createdAt;
      const dateObj = new Date(msgTimestamp);
      const initials = getInitials(name);
      const color =
        AVATAR_COLORS[index % AVATAR_COLORS.length] || "bg-blue-100 text-blue-700";

      return {
        id: convIdStr,
        name,
        phoneNumber,
        message: messageSnippet,
        time: formatRelativeTime(dateObj, now),
        timestamp: dateObj.toISOString(),
        initials,
        color,
        unread,
        status: conv.status || "OPEN",
      };
    });

  // Process Message Activity Matrix for the requested days
  const activityMap = new Map<string, number>();
  for (const item of activityAggregation) {
    activityMap.set(`${item._id.date}_${item._id.direction}`, item.count);
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const messageActivity: DashboardMessageActivityItem[] = [];

  for (let i = validDays - 1; i >= 0; i--) {
    const dayStartUtc = new Date(
      startOfTodayUtc.getTime() - i * 24 * 60 * 60 * 1000,
    );
    const dayInDhaka = new Date(dayStartUtc.getTime() + DHAKA_OFFSET_MS);

    const yearStr = dayInDhaka.getUTCFullYear();
    const monthStr = String(dayInDhaka.getUTCMonth() + 1).padStart(2, "0");
    const dateStr = String(dayInDhaka.getUTCDate()).padStart(2, "0");
    const formattedDate = `${yearStr}-${monthStr}-${dateStr}`;

    const dayName = dayNames[dayInDhaka.getUTCDay()] || "Day";

    const incoming = activityMap.get(`${formattedDate}_INBOUND`) || 0;
    const outgoing = activityMap.get(`${formattedDate}_OUTBOUND`) || 0;

    messageActivity.push({
      date: formattedDate,
      day: dayName,
      incoming,
      outgoing,
    });
  }

  return {
    overview: {
      totalContacts,
      totalConversations,
      openConversations,
      closedConversations,
      pendingConversations,
      totalMessages,
      inboundMessages,
      outboundMessages,
    },
    whatsapp: {
      totalAccounts,
      connectedAccounts,
      disconnectedAccounts,
    },
    messages: {
      today: messagesToday,
      thisWeek: messagesThisWeek,
      thisMonth: messagesThisMonth,
    },
    recentConversations,
    messageActivity,
  };
}
