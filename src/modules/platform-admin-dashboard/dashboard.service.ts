import type { Types } from "mongoose";
import Workspace from "../workspace/workspace.model.js";
import User from "../auth/user.model.js";
import Subscription from "../billing/subscription.model.js";
import Payment from "../billing/payment.model.js";
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
      filter.$or = [
        { invoiceNumber: { $regex: q, $options: "i" } },
        { "gatewayData.trxID": { $regex: q, $options: "i" } },
      ];
    }

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .select("-gatewayData.rawGatewayResponse")
        .populate("workspaceId", "name slug")
        .populate("initiatedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Payment.countDocuments(filter).exec(),
    ]);

    const items = payments.map((p: any) => {
      const workspace = p.workspaceId || {};
      const initiator = p.initiatedBy || {};
      return {
        id: String(p._id),
        workspaceId: String(workspace._id || ""),
        workspaceName: workspace.name || "Unknown",
        initiatedBy: {
          id: String(initiator._id || ""),
          name: initiator.name || "Unknown",
          email: initiator.email || "Unknown",
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
        completedAt: p.completedAt ? new Date(p.completedAt).toISOString() : undefined,
        createdAt: p.createdAt?.toISOString?.() || new Date(p.createdAt).toISOString(),
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
