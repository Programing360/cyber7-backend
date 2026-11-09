import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { platformAdminDashboardService } from "../src/modules/platform-admin-dashboard/dashboard.service.js";
import { platformAdminDashboardController } from "../src/modules/platform-admin-dashboard/dashboard.controller.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import User from "../src/modules/auth/user.model.js";
import Subscription from "../src/modules/billing/subscription.model.js";
import Payment from "../src/modules/billing/payment.model.js";

describe("Platform Admin Analytics — Service & Export Validation", () => {
  it("should have getAnalyticsMetrics and generateAnalyticsCsv defined on dashboard service", () => {
    assert.equal(
      typeof platformAdminDashboardService.getAnalyticsMetrics,
      "function",
    );
    assert.equal(
      typeof platformAdminDashboardService.generateAnalyticsCsv,
      "function",
    );
    assert.equal(
      typeof platformAdminDashboardController.getAnalytics,
      "function",
    );
    assert.equal(
      typeof platformAdminDashboardController.exportAnalyticsCsv,
      "function",
    );
  });

  it("should aggregate metrics correctly and return expected structure", async () => {
    // Stub Mongoose models
    const origWorkspaceCount = Workspace.countDocuments;
    const origWorkspaceAggregate = Workspace.aggregate;
    const origUserCount = User.countDocuments;
    const origUserAggregate = User.aggregate;
    const origSubscriptionFind = Subscription.find;
    const origSubscriptionAggregate = Subscription.aggregate;
    const origPaymentAggregate = Payment.aggregate;

    try {
      Workspace.countDocuments = (() => ({
        exec: async () => 10,
      })) as any;

      Workspace.aggregate = (() => ({
        exec: async () => [{ _id: "2026-03", count: 2 }],
      })) as any;

      User.countDocuments = (() => ({
        exec: async () => 25,
      })) as any;

      User.aggregate = (() => ({
        exec: async () => [{ _id: "2026-03", count: 5 }],
      })) as any;

      Subscription.find = (() => ({
        select: () => ({
          lean: () => ({
            exec: async () => [
              { planCode: "STARTER", price: 3000 },
              { planCode: "BUSINESS_PRO", price: 7400 },
            ],
          }),
        }),
      })) as any;

      Subscription.aggregate = (() => ({
        exec: async () => [
          { _id: "STARTER", count: 1, totalValue: 3000 },
          { _id: "BUSINESS_PRO", count: 1, totalValue: 7400 },
        ],
      })) as any;

      Payment.aggregate = ((pipeline: any[]) => {
        const group = pipeline.find((stage) => stage.$group)?.$group;
        return {
          exec: async () => {
            if (group?._id?.$dateToString) {
              return [{ _id: "2026-03", totalAmount: 10400, count: 2 }];
            } else if (group?._id === "$paymentMethod") {
              return [{ _id: "BKASH_DIRECT", totalAmount: 10400, count: 2 }];
            } else {
              return [{ _id: null, total: 10400 }];
            }
          },
        };
      }) as any;

      const data = await platformAdminDashboardService.getAnalyticsMetrics();

      assert.equal(data.source, "LIVE_BACKEND");
      assert.equal(data.overview.totalRevenueBdt, 10400);
      assert.equal(data.overview.monthlyRecurringRevenueBdt, 10400);
      assert.equal(data.overview.totalActiveSubscriptions, 2);
      assert.equal(data.overview.averageRevenuePerAccount, 5200);

      // Verify plan distribution contains STARTER, BUSINESS_PRO, ENTERPRISE
      assert.equal(data.planDistribution.length, 3);
      const starter = data.planDistribution.find((p) => p.planCode === "STARTER");
      assert.equal(starter?.value, 1);
      assert.equal(starter?.revenueBdt, 3000);

      // Verify payment methods
      assert.equal(data.paymentMethods.length, 1);
      assert.equal(data.paymentMethods[0].method, "BKASH_DIRECT");
      assert.equal(data.paymentMethods[0].label, "bKash Direct");
      assert.equal(data.paymentMethods[0].amount, 10400);

      // Verify CSV Export
      const csv = await platformAdminDashboardService.generateAnalyticsCsv();
      assert.ok(csv.includes("VEXCHAT PLATFORM ANALYTICS & GROWTH REPORT"));
      assert.ok(csv.includes("Total Platform Revenue (BDT),10400"));
      assert.ok(csv.includes("Monthly Recurring Revenue (BDT),10400"));
      assert.ok(csv.includes('"STARTER","Starter (৳3,000/mo)",1,3000'));
      assert.ok(csv.includes('"BKASH_DIRECT","bKash Direct",10400,2'));
    } finally {
      // Restore stubs
      Workspace.countDocuments = origWorkspaceCount;
      Workspace.aggregate = origWorkspaceAggregate;
      User.countDocuments = origUserCount;
      User.aggregate = origUserAggregate;
      Subscription.find = origSubscriptionFind;
      Subscription.aggregate = origSubscriptionAggregate;
      Payment.aggregate = origPaymentAggregate;
    }
  });
});
