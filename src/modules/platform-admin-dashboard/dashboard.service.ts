import type { Types } from "mongoose";
import Workspace from "../workspace/workspace.model.js";
import User from "../auth/user.model.js";
import Subscription from "../billing/subscription.model.js";
import Payment, { PaymentModel } from "../billing/payment.model.js";
import Invoice from "../billing/invoice.model.js";
import AdminSecurityAuditLog from "../admin-auth/admin-security-audit.model.js";
import type { PlanCode } from "../billing/billing.config.js";

export interface PaginationParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  source: "LIVE_BACKEND";
}

export class PlatformAdminDashboardService {
  /**
   * Retrieves high-level platform overview metrics aggregated across MongoDB collections.
   */
  async getOverviewMetrics() {
    const [
      totalWorkspaces,
      totalUsers,
      activeSubscriptions,
      plansBreakdownAgg,
      revenueAgg,
      pendingTransfersAgg,
      recentAuditLogs,
    ] = await Promise.all([
      Workspace.countDocuments().exec(),
      User.countDocuments().exec(),
      Subscription.countDocuments({ status: "ACTIVE" }).exec(),
      Subscription.aggregate([
        { $match: { status: "ACTIVE" } },
        { $group: { _id: "$planCode", count: { $sum: 1 } } },
      ]).exec(),
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
      ]).exec(),
      Payment.aggregate([
        {
          $match: {
            paymentMethod: "CITY_BANK_TRANSFER",
            status: "PENDING_VERIFICATION",
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
          },
        },
      ]).exec(),
      AdminSecurityAuditLog.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
        .exec(),
    ]);

    const plansBreakdown: Record<PlanCode, number> = {
      STARTER: 0,
      BUSINESS_PRO: 0,
      ENTERPRISE: 0,
    };

    for (const item of plansBreakdownAgg) {
      if (item._id in plansBreakdown) {
        plansBreakdown[item._id as PlanCode] = item.count;
      }
    }

    const subscriptionRevenueBdt = revenueAgg[0]?.totalRevenue || 0;
    const pendingTransfersCount = pendingTransfersAgg[0]?.count || 0;
    const pendingTransfersAmountBdt = pendingTransfersAgg[0]?.totalAmount || 0;

    return {
      metrics: {
        totalWorkspaces,
        totalUsers,
        activeSubscriptions,
        subscriptionRevenueBdt,
        pendingTransfersCount,
        pendingTransfersAmountBdt,
        plansBreakdown,
        backendSupport: {
          totalWorkspaces: "IMPLEMENTED" as const,
          totalUsers: "IMPLEMENTED" as const,
          activeSubscriptions: "IMPLEMENTED" as const,
          subscriptionRevenue: "IMPLEMENTED" as const,
          pendingTransfers: "IMPLEMENTED" as const,
        },
      },
      recentActivity: recentAuditLogs,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Retrieves revenue time-series and method breakdown.
   */
  async getRevenueMetrics() {
    const [monthlyAgg, methodAgg, totalRevenueAgg] = await Promise.all([
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        {
          $group: {
            _id: "$paymentMethod",
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]).exec(),
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).exec(),
    ]);

    return {
      totalRevenueBdt: totalRevenueAgg[0]?.total || 0,
      monthly: monthlyAgg.map((m) => ({
        month: m._id,
        amount: m.totalAmount,
        count: m.count,
      })),
      byMethod: methodAgg.map((m) => ({
        method: m._id,
        amount: m.totalAmount,
        count: m.count,
      })),
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Retrieves comprehensive platform analytics for growth, MRR, plan adoption, and payment distributions.
   */
  async getAnalyticsMetrics() {
    const [
      totalWorkspaces,
      activeWorkspaces,
      totalUsers,
      trialUsers,
      paidUsers,
      activeSubs,
      monthlyRevenueAgg,
      plansBreakdownAgg,
      paymentMethodAgg,
      userMonthlyGrowthAgg,
      workspaceMonthlyGrowthAgg,
      totalRevenueAgg,
    ] = await Promise.all([
      Workspace.countDocuments().exec(),
      Workspace.countDocuments({ status: "ACTIVE" }).exec(),
      User.countDocuments().exec(),
      User.countDocuments({
        $or: [{ subscriptionStatus: "trial" }, { isPaid: false }],
      }).exec(),
      User.countDocuments({ isPaid: true }).exec(),
      Subscription.find({ status: "ACTIVE" })
        .select("price planCode")
        .lean()
        .exec(),
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
      Subscription.aggregate([
        { $match: { status: "ACTIVE" } },
        {
          $group: {
            _id: "$planCode",
            count: { $sum: 1 },
            totalValue: { $sum: "$price" },
          },
        },
      ]).exec(),
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        {
          $group: {
            _id: "$paymentMethod",
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { totalAmount: -1 } },
      ]).exec(),
      User.aggregate([
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
      Workspace.aggregate([
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
      Payment.aggregate([
        { $match: { status: "COMPLETED" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).exec(),
    ]);

    const totalRevenueBdt = totalRevenueAgg[0]?.total || 0;
    const monthlyRecurringRevenueBdt = activeSubs.reduce(
      (sum, s) => sum + (s.price || 0),
      0,
    );
    const totalActiveSubscriptions = activeSubs.length;
    const averageRevenuePerAccount =
      totalActiveSubscriptions > 0
        ? Math.round(monthlyRecurringRevenueBdt / totalActiveSubscriptions)
        : 0;

    const planConfigMap: Record<string, { label: string; color: string }> = {
      STARTER: { label: "Starter (৳3,000/mo)", color: "#0284c7" },
      BUSINESS_PRO: { label: "Business Pro (৳7,400/mo)", color: "#10b981" },
      ENTERPRISE: { label: "Enterprise (৳18,600/mo)", color: "#8b5cf6" },
    };

    const planDistribution = ["STARTER", "BUSINESS_PRO", "ENTERPRISE"].map(
      (code) => {
        const found = plansBreakdownAgg.find((p) => p._id === code);
        const meta = planConfigMap[code];
        return {
          planCode: code,
          name: meta.label,
          value: found?.count || 0,
          revenueBdt: found?.totalValue || 0,
          color: meta.color,
        };
      },
    );

    const paymentMethodLabels: Record<string, string> = {
      BKASH_DIRECT: "bKash Direct",
      NAGAD_DIRECT: "Nagad Direct",
      CITY_BANK_TRANSFER: "City Bank Transfer",
      PORTPOS_CARD: "Debit / Credit Cards",
      SSLCOMMERZ: "SSLCommerz Gateway",
      STRIPE: "Stripe International",
    };

    const paymentMethods = paymentMethodAgg.map((item) => ({
      method: item._id,
      label: paymentMethodLabels[item._id] || item._id,
      amount: item.totalAmount,
      count: item.count,
    }));

    // Merge monthly user & workspace growth
    const monthsSet = new Set<string>();
    userMonthlyGrowthAgg.forEach((u) => monthsSet.add(u._id));
    workspaceMonthlyGrowthAgg.forEach((w) => monthsSet.add(w._id));
    monthlyRevenueAgg.forEach((r) => monthsSet.add(r._id));

    const sortedMonths = Array.from(monthsSet).sort();
    const growthTrend = sortedMonths.map((month) => {
      const users =
        userMonthlyGrowthAgg.find((u) => u._id === month)?.count || 0;
      const workspaces =
        workspaceMonthlyGrowthAgg.find((w) => w._id === month)?.count || 0;
      const revItem = monthlyRevenueAgg.find((r) => r._id === month);
      return {
        month,
        users,
        workspaces,
        revenue: revItem?.totalAmount || 0,
        transactions: revItem?.count || 0,
      };
    });

    return {
      overview: {
        totalRevenueBdt,
        monthlyRecurringRevenueBdt,
        totalActiveSubscriptions,
        averageRevenuePerAccount,
        totalUsers,
        trialUsers,
        paidUsers,
        totalWorkspaces,
        activeWorkspaces,
      },
      revenueTrend: monthlyRevenueAgg.map((m) => ({
        month: m._id,
        revenue: m.totalAmount,
        count: m.count,
      })),
      planDistribution,
      paymentMethods,
      growthTrend,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Generates a downloadable CSV string representing the latest platform analytics.
   */
  async generateAnalyticsCsv(): Promise<string> {
    const data = await this.getAnalyticsMetrics();

    const lines: string[] = [];
    lines.push("VEXCHAT PLATFORM ANALYTICS & GROWTH REPORT");
    lines.push(`Generated At,${new Date().toISOString()}`);
    lines.push(`Total Platform Revenue (BDT),${data.overview.totalRevenueBdt}`);
    lines.push(
      `Monthly Recurring Revenue (BDT),${data.overview.monthlyRecurringRevenueBdt}`,
    );
    lines.push(
      `Total Active Subscriptions,${data.overview.totalActiveSubscriptions}`,
    );
    lines.push(
      `Average Revenue Per Account (BDT),${data.overview.averageRevenuePerAccount}`,
    );
    lines.push(`Total Workspaces,${data.overview.totalWorkspaces}`);
    lines.push(`Active Workspaces,${data.overview.activeWorkspaces}`);
    lines.push(`Total Registered Users,${data.overview.totalUsers}`);
    lines.push(`Free Trial Users,${data.overview.trialUsers}`);
    lines.push(`Paid Converted Users,${data.overview.paidUsers}`);
    lines.push("");

    lines.push("--- MONTHLY PERFORMANCE & GROWTH ---");
    lines.push("Month,Revenue (BDT),Transactions,New Workspaces,New Users");
    for (const item of data.growthTrend) {
      lines.push(
        `"${item.month}",${item.revenue},${item.transactions},${item.workspaces},${item.users}`,
      );
    }
    lines.push("");

    lines.push("--- ACTIVE SUBSCRIPTION PLANS BREAKDOWN ---");
    lines.push("Plan Code,Plan Label,Active Workspaces,Monthly Value (BDT)");
    for (const plan of data.planDistribution) {
      lines.push(
        `"${plan.planCode}","${plan.name}",${plan.value},${plan.revenueBdt}`,
      );
    }
    lines.push("");

    lines.push("--- COMPLETED PAYMENTS BY METHOD ---");
    lines.push(
      "Method Code,Method Name,Completed Volume (BDT),Transactions Count",
    );
    for (const pm of data.paymentMethods) {
      lines.push(`"${pm.method}","${pm.label}",${pm.amount},${pm.count}`);
    }

    return lines.join("\n");
  }

  /**
   * Lists workspaces with search, status filters, and pagination.
   */
  async listWorkspaces(params: PaginationParams & { status?: string }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.status && params.status !== "ALL") {
      filter.status = params.status;
    }
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { slug: { $regex: q, $options: "i" } },
      ];
    }

    const [workspaces, total] = await Promise.all([
      Workspace.find(filter)
        .populate("ownerId", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Workspace.countDocuments(filter).exec(),
    ]);

    // Fetch active subscriptions for these workspaces
    const workspaceIds = workspaces.map((w) => w._id);
    const subscriptions = await Subscription.find({
      workspaceId: { $in: workspaceIds },
      status: "ACTIVE",
    })
      .lean()
      .exec();

    const subMap = new Map(subscriptions.map((s) => [String(s.workspaceId), s]));

    const items = workspaces.map((w: any) => {
      const activeSub = subMap.get(String(w._id));
      const owner = w.ownerId || {};
      return {
        id: String(w._id),
        name: w.name,
        slug: w.slug,
        ownerId: String(owner._id || ""),
        ownerName: owner.name || "Unknown",
        ownerEmail: owner.email || "Unknown",
        status: w.status,
        timezone: w.timezone || "Asia/Dhaka",
        currency: w.currency || "BDT",
        memberCount: 1,
        activePlan: activeSub?.planCode || "STARTER",
        subscriptionStatus: activeSub?.status || "INACTIVE",
        createdAt: w.createdAt?.toISOString?.() || new Date(w.createdAt).toISOString(),
        updatedAt: w.updatedAt?.toISOString?.() || new Date(w.updatedAt).toISOString(),
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Lists platform users. SUPER_ADMIN only. Excludes password hashes.
   */
  async listUsers(
    params: PaginationParams & {
      role?: string;
      platformRole?: string;
      isActive?: boolean;
    },
  ) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.role && params.role !== "ALL") {
      filter.role = params.role;
    }
    if (params.platformRole && params.platformRole !== "ALL") {
      filter.platformRole = params.platformRole;
    }
    if (params.isActive !== undefined) {
      filter.isActive = params.isActive;
    }
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("-password")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      User.countDocuments(filter).exec(),
    ]);

    const items = users.map((u: any) => ({
      id: String(u._id),
      name: u.name,
      email: u.email,
      platformRole: u.platformRole || "USER",
      workspaceRole: u.role,
      isEmailVerified: Boolean(u.isEmailVerified),
      isActive: Boolean(u.isActive),
      createdAt: u.createdAt?.toISOString?.() || new Date(u.createdAt).toISOString(),
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Lists subscriptions with workspace details.
   */
  async listSubscriptions(
    params: PaginationParams & {
      plan?: string;
      status?: string;
    },
  ) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.plan && params.plan !== "ALL") {
      filter.planCode = params.plan;
    }
    if (params.status && params.status !== "ALL") {
      filter.status = params.status;
    }

    if (params.search && params.search.trim()) {
      const matchingWorkspaces = await Workspace.find({
        name: { $regex: params.search.trim(), $options: "i" },
      })
        .select("_id")
        .lean()
        .exec();

      filter.workspaceId = { $in: matchingWorkspaces.map((w) => w._id) };
    }

    const [subs, total] = await Promise.all([
      Subscription.find(filter)
        .populate("workspaceId", "name slug")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Subscription.countDocuments(filter).exec(),
    ]);

    const items = subs.map((s: any) => {
      const workspace = s.workspaceId || {};
      return {
        id: String(s._id),
        workspaceId: String(workspace._id || ""),
        workspaceName: workspace.name || "Unknown",
        planCode: s.planCode,
        planName: s.planName,
        status: s.status,
        currency: s.currency || "BDT",
        price: s.price,
        billingCycle: s.billingCycle || "MONTHLY",
        billingCycleAnchorDay: s.billingCycleAnchorDay || 1,
        currentPeriodStart:
          s.currentPeriodStart?.toISOString?.() ||
          new Date(s.currentPeriodStart).toISOString(),
        currentPeriodEnd:
          s.currentPeriodEnd?.toISOString?.() ||
          new Date(s.currentPeriodEnd).toISOString(),
        lastPaymentId: s.lastPaymentId ? String(s.lastPaymentId) : undefined,
        limits: s.limits || { maxWhatsAppNumbers: 1, maxTeamMembers: 3 },
        features: s.features || [],
        createdAt: s.createdAt?.toISOString?.() || new Date(s.createdAt).toISOString(),
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Lists payments with workspace and initiator info.
   * Excludes raw gateway responses for sensitive data isolation.
   */
  async listPayments(
    params: PaginationParams & {
      status?: string;
      method?: string;
    },
  ) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.status && params.status !== "ALL") {
      filter.status = params.status;
    }
    if (params.method && params.method !== "ALL") {
      filter.paymentMethod = params.method;
    }
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      const [matchingWorkspaces, matchingUsers] = await Promise.all([
        Workspace.find({ name: { $regex: q, $options: "i" } })
          .select("_id")
          .lean()
          .exec(),
        User.find({
          $or: [
            { name: { $regex: q, $options: "i" } },
            { email: { $regex: q, $options: "i" } },
          ],
        })
          .select("_id")
          .lean()
          .exec(),
      ]);

      const wsIds = matchingWorkspaces.map((w) => w._id);
      const userIds = matchingUsers.map((u) => u._id);

      const orConditions: Array<Record<string, unknown>> = [
        { invoiceNumber: { $regex: q, $options: "i" } },
        { "gatewayData.trxID": { $regex: q, $options: "i" } },
      ];

      if (wsIds.length > 0) {
        orConditions.push({ workspaceId: { $in: wsIds } });
      }
      if (userIds.length > 0) {
        orConditions.push({ initiatedBy: { $in: userIds } });
      }

      filter.$or = orConditions;
    }

    const [payments, total] = await Promise.all([
      PaymentModel.find(filter)
        .select("-gatewayData.rawGatewayResponse")
        .populate("workspaceId", "name")
        .populate("initiatedBy", "name email phoneNumber")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      PaymentModel.countDocuments(filter).exec(),
    ]);

    // Handle any unpopulated or missing workspace/user IDs
    const missingWsIds: any[] = [];
    const missingUserIds: any[] = [];

    for (const p of payments as any[]) {
      if (p.workspaceId && typeof p.workspaceId !== "object") {
        missingWsIds.push(p.workspaceId);
      }
      if (p.initiatedBy && typeof p.initiatedBy !== "object") {
        missingUserIds.push(p.initiatedBy);
      }
    }

    let fallbackWsMap = new Map<string, any>();
    let fallbackUserMap = new Map<string, any>();

    if (missingWsIds.length > 0) {
      const wsDocs = await Workspace.find({ _id: { $in: missingWsIds } })
        .select("name")
        .lean()
        .exec();
      fallbackWsMap = new Map(wsDocs.map((w) => [String(w._id), w]));
    }

    if (missingUserIds.length > 0) {
      const userDocs = await User.find({ _id: { $in: missingUserIds } })
        .select("name email phoneNumber")
        .lean()
        .exec();
      fallbackUserMap = new Map(userDocs.map((u) => [String(u._id), u]));
    }

    const items = payments.map((p: any) => {
      // 1. Resolve Workspace
      let wsObj: any = null;
      let wsIdStr = "";
      let wsName = "";

      if (
        p.workspaceId &&
        typeof p.workspaceId === "object" &&
        ("_id" in p.workspaceId || "name" in p.workspaceId)
      ) {
        wsObj = p.workspaceId;
        wsIdStr = String(wsObj._id || "");
        wsName = wsObj.name || "";
      } else if (p.workspaceId) {
        wsIdStr = String(p.workspaceId);
        const fallback = fallbackWsMap.get(wsIdStr);
        if (fallback) {
          wsObj = fallback;
          wsName = fallback.name || "";
        }
      }

      if (!wsName && p.workspaceName) {
        wsName = p.workspaceName;
      }
      if (!wsName && wsIdStr) {
        wsName = `Workspace (${wsIdStr.slice(-6)})`;
      }
      if (!wsName) {
        wsName = "Unknown Workspace";
      }

      // 2. Resolve Initiator / Customer
      let userObj: any = null;
      let userIdStr = "";
      let userName = "";
      let userEmail = "";
      let userPhone = "";

      if (
        p.initiatedBy &&
        typeof p.initiatedBy === "object" &&
        ("_id" in p.initiatedBy ||
          "email" in p.initiatedBy ||
          "name" in p.initiatedBy)
      ) {
        userObj = p.initiatedBy;
        userIdStr = String(userObj._id || "");
        userName = userObj.name || "";
        userEmail = userObj.email || "";
        userPhone = userObj.phoneNumber || "";
      } else if (p.initiatedBy) {
        userIdStr = String(p.initiatedBy);
        const fallback = fallbackUserMap.get(userIdStr);
        if (fallback) {
          userObj = fallback;
          userName = fallback.name || "";
          userEmail = fallback.email || "";
          userPhone = fallback.phoneNumber || "";
        }
      }

      if (!userName && p.customerName) userName = p.customerName;
      if (!userEmail && p.customerEmail) userEmail = p.customerEmail;
      if (!userPhone && (p.customerPhone || p.customerPhoneNumber)) {
        userPhone = p.customerPhone || p.customerPhoneNumber;
      }
      if (!userName && userEmail) {
        userName = userEmail.split("@")[0];
      }
      if (!userName && userIdStr) {
        userName = `User (${userIdStr.slice(-6)})`;
      }
      if (!userName) userName = "Unknown Customer";
      if (!userEmail) userEmail = "Unknown";

      return {
        id: String(p._id),
        workspaceId: wsObj
          ? {
              _id: wsIdStr,
              id: wsIdStr,
              name: wsName,
            }
          : wsIdStr,
        workspaceName: wsName,
        initiatedBy: {
          id: userIdStr,
          _id: userIdStr,
          name: userName,
          email: userEmail,
          phoneNumber: userPhone || undefined,
        },
        customer: {
          id: userIdStr,
          name: userName,
          email: userEmail,
          phoneNumber: userPhone || undefined,
        },
        paymentMethod: p.paymentMethod,
        planCode: p.planCode,
        planName: p.planName,
        amount: p.amount,
        currency: p.currency || "BDT",
        status: p.status,
        invoiceNumber: p.invoiceNumber,
        idempotencyKey: p.idempotencyKey,
        gatewayData: {
          trxID: p.gatewayData?.trxID,
          cblOrderId: p.gatewayData?.cblOrderId,
          cblTransactionId: p.gatewayData?.cblTransactionId,
          bankTransfer: p.gatewayData?.bankTransfer,
        },
        failureReason: p.failureReason,
        completedAt: p.completedAt
          ? new Date(p.completedAt).toISOString()
          : undefined,
        createdAt:
          p.createdAt?.toISOString?.() || new Date(p.createdAt).toISOString(),
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Lists invoices with pagination and search.
   */
  async listInvoices(params: PaginationParams) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      filter.$or = [
        { invoiceNumber: { $regex: q, $options: "i" } },
        { "issuedTo.userName": { $regex: q, $options: "i" } },
        { "issuedTo.userEmail": { $regex: q, $options: "i" } },
        { "issuedTo.workspaceName": { $regex: q, $options: "i" } },
      ];
    }

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Invoice.countDocuments(filter).exec(),
    ]);

    const items = invoices.map((i: any) => ({
      id: String(i._id),
      invoiceNumber: i.invoiceNumber,
      workspaceId: String(i.workspaceId),
      paymentId: String(i.paymentId),
      issuedTo: i.issuedTo,
      planCode: i.planCode,
      planName: i.planName,
      billingCycle: i.billingCycle || "MONTHLY",
      periodCoveredStart:
        i.periodCoveredStart?.toISOString?.() ||
        new Date(i.periodCoveredStart).toISOString(),
      periodCoveredEnd:
        i.periodCoveredEnd?.toISOString?.() ||
        new Date(i.periodCoveredEnd).toISOString(),
      amount: i.amount,
      currency: i.currency || "BDT",
      status: i.status,
      paymentMethod: i.paymentMethod,
      paidAt: i.paidAt ? new Date(i.paidAt).toISOString() : undefined,
      createdAt: i.createdAt?.toISOString?.() || new Date(i.createdAt).toISOString(),
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      source: "LIVE_BACKEND" as const,
    };
  }

  /**
   * Lists security audit logs. SUPER_ADMIN only.
   */
  async listAuditLogs(
    params: PaginationParams & {
      eventType?: string;
    },
  ) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.eventType && params.eventType !== "ALL") {
      filter.eventType = params.eventType;
    }
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      filter.$or = [
        { reason: { $regex: q, $options: "i" } },
        { adminEmail: { $regex: q, $options: "i" } },
      ];
    }

    const [logs, total] = await Promise.all([
      AdminSecurityAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      AdminSecurityAuditLog.countDocuments(filter).exec(),
    ]);

    const items = logs.map((l: any) => ({
      id: String(l._id),
      eventType: l.eventType,
      adminUserId: l.adminUserId ? String(l.adminUserId) : undefined,
      adminEmail: l.adminEmail,
      sessionId: l.sessionId ? String(l.sessionId) : undefined,
      reason: l.reason,
      ipAddress: l.ipAddress,
      userAgent: l.userAgent,
      metadata: l.metadata,
      createdAt: l.createdAt?.toISOString?.() || new Date(l.createdAt).toISOString(),
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      source: "LIVE_BACKEND" as const,
    };
  }
}

export const platformAdminDashboardService = new PlatformAdminDashboardService();
