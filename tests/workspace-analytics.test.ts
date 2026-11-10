import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  getWorkspaceAnalytics,
} from "../src/modules/dashboard/dashboard.service.js";
import {
  getWorkspaceAnalyticsController,
} from "../src/modules/dashboard/dashboard.controller.js";
import WhatsAppMessage from "../src/modules/whatsapp/message.model.js";
import Campaign from "../src/modules/campaign/campaign.model.js";
import CampaignRecipient from "../src/modules/campaign/campaign-recipient.model.js";
import type { WorkspaceRequest } from "../src/middlewares/require-workspace-membership.js";

describe("Workspace Analytics Service & Controller", () => {
  const testWorkspaceId = new mongoose.Types.ObjectId().toString();

  it("should aggregate runtime analytics and return accurate summary, rates, statusData, and chartData", async () => {
    // Save original implementations
    const origMessageAggregate = WhatsAppMessage.aggregate;
    const origRecipientAggregate = CampaignRecipient.aggregate;
    const origCampaignFind = Campaign.find;

    try {
      // Mock WhatsAppMessage aggregate calls
      const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
      const dhakaNow = new Date(Date.now() + DHAKA_OFFSET_MS);
      const year = dhakaNow.getUTCFullYear();
      const month = String(dhakaNow.getUTCMonth() + 1).padStart(2, "0");
      const day = String(dhakaNow.getUTCDate()).padStart(2, "0");
      const todayStr = `${year}-${month}-${day}`;

      WhatsAppMessage.aggregate = (async (pipeline: any[]) => {
        // If pipeline groups by { date, status }, return current period daily mock
        const groupStage = pipeline.find((stage) => stage.$group)?.$group;
        if (groupStage?._id?.date) {
          return [
            { _id: { date: todayStr, status: "DELIVERED" }, count: 5 },
            { _id: { date: todayStr, status: "READ" }, count: 10 },
            { _id: { date: todayStr, status: "SENT" }, count: 2 },
            { _id: { date: todayStr, status: "FAILED" }, count: 1 },
          ];
        }
        // Previous period mock
        return [
          { _id: "DELIVERED", count: 4 },
          { _id: "READ", count: 8 },
          { _id: "SENT", count: 1 },
          { _id: "FAILED", count: 2 },
        ];
      }) as any;

      // Mock CampaignRecipient aggregate calls
      CampaignRecipient.aggregate = (async (pipeline: any[]) => {
        const groupStage = pipeline.find((stage) => stage.$group)?.$group;
        if (groupStage?._id?.date) {
          return [
            { _id: { date: todayStr, status: "READ" }, count: 5 },
            { _id: { date: todayStr, status: "SENT" }, count: 1 },
          ];
        }
        return [
          { _id: "READ", count: 2 },
        ];
      }) as any;

      // Mock Campaign.find
      Campaign.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId(),
                name: "Summer Promo 2026",
                sentCount: 100,
                deliveredCount: 95,
                readCount: 80,
                failedCount: 5,
                status: "COMPLETED",
                createdAt: new Date(),
              },
            ],
          }),
        }),
      })) as any;

      const result = await getWorkspaceAnalytics({
        workspaceId: testWorkspaceId,
        period: "7d",
      });

      assert.equal(result.period, "7d");
      assert.equal(result.chartData.length, 7);

      // Check summary:
      // Messages today: DELIVERED: 5, READ: 10+5=15, SENT: 2+1=3, FAILED: 1
      // Delivered combined: 5 + 15 = 20
      // Sent total: 3 + 20 + 1 = 24
      assert.equal(result.summary.totalSent, 24);
      assert.equal(result.summary.delivered, 20);
      assert.equal(result.summary.read, 15);
      assert.equal(result.summary.failed, 1);
      assert.equal(result.summary.pending, 3);

      // Rates
      // deliveryRate = (20 / 24) * 100 = 83.3%
      assert.equal(result.rates.deliveryRate, 83.3);
      // readRate = (15 / 20) * 100 = 75.0%
      assert.equal(result.rates.readRate, 75.0);
      // failureRate = (1 / 24) * 100 = 4.2%
      assert.equal(result.rates.failureRate, 4.2);

      // Status data for donut chart
      // Delivered (unopened): 5, Read: 15, Pending: 3, Failed: 1
      // Sum = 5 + 15 + 3 + 1 = 24 = totalSent
      const statusTotal = result.statusData.reduce((acc, curr) => acc + curr.value, 0);
      assert.equal(statusTotal, 24);

      // Campaigns
      assert.equal(result.campaigns.length, 1);
      assert.equal(result.campaigns[0].name, "Summer Promo 2026");
      assert.equal(result.campaigns[0].sent, 100);
      assert.equal(result.campaigns[0].delivered, 95);
    } finally {
      WhatsAppMessage.aggregate = origMessageAggregate;
      CampaignRecipient.aggregate = origRecipientAggregate;
      Campaign.find = origCampaignFind;
    }
  });

  it("should handle empty zero-state without division by zero errors", async () => {
    const origMessageAggregate = WhatsAppMessage.aggregate;
    const origRecipientAggregate = CampaignRecipient.aggregate;
    const origCampaignFind = Campaign.find;

    try {
      WhatsAppMessage.aggregate = (async () => []) as any;
      CampaignRecipient.aggregate = (async () => []) as any;
      Campaign.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [],
          }),
        }),
      })) as any;

      const result = await getWorkspaceAnalytics({
        workspaceId: testWorkspaceId,
        period: "30d",
      });

      assert.equal(result.period, "30d");
      assert.equal(result.chartData.length, 30);
      assert.equal(result.summary.totalSent, 0);
      assert.equal(result.summary.delivered, 0);
      assert.equal(result.summary.read, 0);
      assert.equal(result.summary.failed, 0);
      assert.equal(result.summary.pending, 0);
      assert.equal(result.rates.deliveryRate, 0);
      assert.equal(result.rates.readRate, 0);
      assert.equal(result.rates.failureRate, 0);
      assert.equal(result.trends.totalSentChange, "0.0%");
      assert.equal(result.campaigns.length, 0);
    } finally {
      WhatsAppMessage.aggregate = origMessageAggregate;
      CampaignRecipient.aggregate = origRecipientAggregate;
      Campaign.find = origCampaignFind;
    }
  });

  it("should respond with 200 from getWorkspaceAnalyticsController", async () => {
    const origMessageAggregate = WhatsAppMessage.aggregate;
    const origRecipientAggregate = CampaignRecipient.aggregate;
    const origCampaignFind = Campaign.find;

    try {
      WhatsAppMessage.aggregate = (async () => []) as any;
      CampaignRecipient.aggregate = (async () => []) as any;
      Campaign.find = (() => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [],
          }),
        }),
      })) as any;

      let statusCode = 0;
      let responseBody: any = null;

      const req = {
        params: { workspaceId: testWorkspaceId },
        query: { period: "7d" },
      } as unknown as WorkspaceRequest;

      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (data: any) => {
          responseBody = data;
          return res;
        },
      } as any;

      const next = (err?: any) => {
        if (err) throw err;
      };

      await getWorkspaceAnalyticsController(req, res, next);

      assert.equal(statusCode, 200);
      assert.equal(responseBody.success, true);
      assert.equal(responseBody.data.period, "7d");
    } finally {
      WhatsAppMessage.aggregate = origMessageAggregate;
      CampaignRecipient.aggregate = origRecipientAggregate;
      Campaign.find = origCampaignFind;
    }
  });
});
