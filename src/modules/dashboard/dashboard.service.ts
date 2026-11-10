import { Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import WhatsAppConversation from "../whatsapp/conversation.model.js";
import WhatsAppMessage from "../whatsapp/message.model.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import Campaign from "../campaign/campaign.model.js";
import CampaignRecipient from "../campaign/campaign-recipient.model.js";

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

export type AnalyticsPeriod = "7d" | "30d" | "90d";

export interface GetWorkspaceAnalyticsOptions {
  workspaceId: string;
  period?: AnalyticsPeriod;
}

export interface WorkspaceAnalyticsSummary {
  totalSent: number;
  delivered: number;
  read: number;
  failed: number;
  pending: number;
}

export interface WorkspaceAnalyticsTrend {
  totalSentChange: string;
  totalSentPositive: boolean;
  deliveredChange: string;
  deliveredPositive: boolean;
  readChange: string;
  readPositive: boolean;
  failedChange: string;
  failedPositive: boolean;
}

export interface WorkspaceAnalyticsRates {
  deliveryRate: number;
  readRate: number;
  failureRate: number;
}

export interface WorkspaceAnalyticsTimeSeriesItem {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

export interface WorkspaceAnalyticsStatusItem {
  name: string;
  value: number;
}

export interface WorkspaceAnalyticsCampaignItem {
  id: string;
  name: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  status: string;
  createdAt: string;
}

export interface WorkspaceAnalyticsResult {
  period: AnalyticsPeriod;
  summary: WorkspaceAnalyticsSummary;
  trends: WorkspaceAnalyticsTrend;
  rates: WorkspaceAnalyticsRates;
  chartData: WorkspaceAnalyticsTimeSeriesItem[];
  statusData: WorkspaceAnalyticsStatusItem[];
  campaigns: WorkspaceAnalyticsCampaignItem[];
}

/**
 * Aggregates runtime analytics for the requested workspace and period (7d, 30d, 90d).
 * Integrates live metrics across 1-on-1 WhatsApp messages and broadcast campaign recipients.
 * Timezone strictly aligned with Asia/Dhaka (+06:00).
 */
export async function getWorkspaceAnalytics({
  workspaceId,
  period = "30d",
}: GetWorkspaceAnalyticsOptions): Promise<WorkspaceAnalyticsResult> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const targetWorkspaceId = new Types.ObjectId(workspaceId);
  const validDays = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const now = new Date();
  const { startOfTodayUtc } = getDhakaDateBoundaries(now);
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

  // Window for current period: validDays ending at end of today UTC
  const periodEndUtc = new Date(
    startOfTodayUtc.getTime() + 24 * 60 * 60 * 1000,
  );
  const periodStartUtc = new Date(
    startOfTodayUtc.getTime() - (validDays - 1) * 24 * 60 * 60 * 1000,
  );

  // Window for previous period: identical duration immediately prior to current period
  const prevPeriodEndUtc = periodStartUtc;
  const prevPeriodStartUtc = new Date(
    periodStartUtc.getTime() - validDays * 24 * 60 * 60 * 1000,
  );

  // Parallelized database aggregations
  const [
    messageCurrentAgg,
    recipientCurrentAgg,
    messagePrevAgg,
    recipientPrevAgg,
    recentCampaignsRaw,
  ] = await Promise.all([
    // 1. Current period outbound WhatsAppMessages grouped by date and status
    WhatsAppMessage.aggregate<{
      _id: { date: string; status: string };
      count: number;
    }>([
      {
        $match: {
          workspaceId: targetWorkspaceId,
          direction: "OUTBOUND",
          timestamp: { $gte: periodStartUtc, $lt: periodEndUtc },
        },
      },
      {
        $project: {
          status: 1,
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
          _id: { date: "$dateStr", status: "$status" },
          count: { $sum: 1 },
        },
      },
    ]),

    // 2. Current period dispatched campaign recipients grouped by date and status
    CampaignRecipient.aggregate<{
      _id: { date: string; status: string };
      count: number;
    }>([
      {
        $match: {
          workspaceId: targetWorkspaceId,
          status: { $in: ["SENT", "DELIVERED", "READ", "FAILED"] },
          $or: [
            { sentAt: { $gte: periodStartUtc, $lt: periodEndUtc } },
            {
              sentAt: { $exists: false },
              createdAt: { $gte: periodStartUtc, $lt: periodEndUtc },
            },
          ],
        },
      },
      {
        $project: {
          status: 1,
          dateStr: {
            $dateToString: {
              date: { $ifNull: ["$sentAt", "$createdAt"] },
              timezone: "+06:00",
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $group: {
          _id: { date: "$dateStr", status: "$status" },
          count: { $sum: 1 },
        },
      },
    ]),

    // 3. Previous period WhatsAppMessages grouped by status
    WhatsAppMessage.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          workspaceId: targetWorkspaceId,
          direction: "OUTBOUND",
          timestamp: { $gte: prevPeriodStartUtc, $lt: prevPeriodEndUtc },
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),

    // 4. Previous period CampaignRecipients grouped by status
    CampaignRecipient.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          workspaceId: targetWorkspaceId,
          status: { $in: ["SENT", "DELIVERED", "READ", "FAILED"] },
          $or: [
            { sentAt: { $gte: prevPeriodStartUtc, $lt: prevPeriodEndUtc } },
            {
              sentAt: { $exists: false },
              createdAt: { $gte: prevPeriodStartUtc, $lt: prevPeriodEndUtc },
            },
          ],
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),

    // 5. Recent 10 campaigns in this workspace
    Campaign.find({ workspaceId: targetWorkspaceId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  // Aggregate day-by-day counts
  const dailyStatusMap = new Map<string, number>();

  for (const item of messageCurrentAgg) {
    const key = `${item._id.date}_${item._id.status}`;
    dailyStatusMap.set(key, (dailyStatusMap.get(key) || 0) + item.count);
  }

  for (const item of recipientCurrentAgg) {
    const key = `${item._id.date}_${item._id.status}`;
    dailyStatusMap.set(key, (dailyStatusMap.get(key) || 0) + item.count);
  }

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const chartData: WorkspaceAnalyticsTimeSeriesItem[] = [];

  let totalPending = 0;
  let totalDeliveredSlices = 0; // DELIVERED but not yet READ (for status donut)
  let totalDeliveredCombined = 0; // DELIVERED + READ (for KPI and rate calculations)
  let totalRead = 0;
  let totalFailed = 0;
  let totalSent = 0;

  for (let i = validDays - 1; i >= 0; i--) {
    const dayStartUtc = new Date(
      startOfTodayUtc.getTime() - i * 24 * 60 * 60 * 1000,
    );
    const dayInDhaka = new Date(dayStartUtc.getTime() + DHAKA_OFFSET_MS);

    const yearStr = dayInDhaka.getUTCFullYear();
    const monthStr = String(dayInDhaka.getUTCMonth() + 1).padStart(2, "0");
    const dateStr = String(dayInDhaka.getUTCDate()).padStart(2, "0");
    const dateKey = `${yearStr}-${monthStr}-${dateStr}`;

    const displayDate = `${monthNames[dayInDhaka.getUTCMonth()]} ${dateStr}`;

    const sentPending = dailyStatusMap.get(`${dateKey}_SENT`) || 0;
    const deliveredRaw = dailyStatusMap.get(`${dateKey}_DELIVERED`) || 0;
    const readRaw = dailyStatusMap.get(`${dateKey}_READ`) || 0;
    const failedRaw = dailyStatusMap.get(`${dateKey}_FAILED`) || 0;

    // A message that was read was also delivered
    const deliveredTotal = deliveredRaw + readRaw;
    const daySentTotal = sentPending + deliveredTotal + failedRaw;

    totalPending += sentPending;
    totalDeliveredSlices += deliveredRaw;
    totalRead += readRaw;
    totalDeliveredCombined += deliveredTotal;
    totalFailed += failedRaw;
    totalSent += daySentTotal;

    chartData.push({
      date: displayDate,
      sent: daySentTotal,
      delivered: deliveredTotal,
      read: readRaw,
      failed: failedRaw,
    });
  }

  // Calculate status breakdown for donut chart
  const statusData: WorkspaceAnalyticsStatusItem[] = [
    { name: "Delivered", value: totalDeliveredSlices },
    { name: "Read", value: totalRead },
    { name: "Pending", value: totalPending },
    { name: "Failed", value: totalFailed },
  ];

  // Calculate rates
  const deliveryRate =
    totalSent > 0
      ? Number(((totalDeliveredCombined / totalSent) * 100).toFixed(1))
      : 0;
  const readRate =
    totalDeliveredCombined > 0
      ? Number(((totalRead / totalDeliveredCombined) * 100).toFixed(1))
      : 0;
  const failureRate =
    totalSent > 0
      ? Number(((totalFailed / totalSent) * 100).toFixed(1))
      : 0;

  // Process previous period for trends
  let prevSentPending = 0;
  let prevDeliveredRaw = 0;
  let prevReadRaw = 0;
  let prevFailedRaw = 0;

  for (const item of messagePrevAgg) {
    if (item._id === "SENT") prevSentPending += item.count;
    else if (item._id === "DELIVERED") prevDeliveredRaw += item.count;
    else if (item._id === "READ") prevReadRaw += item.count;
    else if (item._id === "FAILED") prevFailedRaw += item.count;
  }

  for (const item of recipientPrevAgg) {
    if (item._id === "SENT") prevSentPending += item.count;
    else if (item._id === "DELIVERED") prevDeliveredRaw += item.count;
    else if (item._id === "READ") prevReadRaw += item.count;
    else if (item._id === "FAILED") prevFailedRaw += item.count;
  }

  const prevDeliveredCombined = prevDeliveredRaw + prevReadRaw;
  const prevTotalSent = prevSentPending + prevDeliveredCombined + prevFailedRaw;

  function calcTrend(curr: number, prev: number) {
    if (prev === 0) {
      if (curr > 0) return { change: "+100%", positive: true };
      return { change: "0.0%", positive: true };
    }
    const diff = curr - prev;
    const pct = ((diff / prev) * 100).toFixed(1);
    return {
      change: `${diff >= 0 ? "+" : ""}${pct}%`,
      positive: diff >= 0,
    };
  }

  const sentTrend = calcTrend(totalSent, prevTotalSent);
  const deliveredTrend = calcTrend(
    totalDeliveredCombined,
    prevDeliveredCombined,
  );
  const readTrend = calcTrend(totalRead, prevReadRaw);
  const failedTrend = calcTrend(totalFailed, prevFailedRaw);

  // Format campaigns
  const campaigns: WorkspaceAnalyticsCampaignItem[] = recentCampaignsRaw.map(
    (c) => ({
      id: c._id.toString(),
      name: c.name,
      sent: c.sentCount || 0,
      delivered: c.deliveredCount || 0,
      read: c.readCount || 0,
      failed: c.failedCount || 0,
      status: c.status || "DRAFT",
      createdAt: c.createdAt
        ? new Date(c.createdAt).toISOString()
        : new Date().toISOString(),
    }),
  );

  return {
    period,
    summary: {
      totalSent,
      delivered: totalDeliveredCombined,
      read: totalRead,
      failed: totalFailed,
      pending: totalPending,
    },
    trends: {
      totalSentChange: sentTrend.change,
      totalSentPositive: sentTrend.positive,
      deliveredChange: deliveredTrend.change,
      deliveredPositive: deliveredTrend.positive,
      readChange: readTrend.change,
      readPositive: readTrend.positive,
      failedChange: failedTrend.change,
      failedPositive: failedTrend.positive,
    },
    rates: {
      deliveryRate,
      readRate,
      failureRate,
    },
    chartData,
    statusData,
    campaigns,
  };
}
