/**
 * Campaign Worker Engine
 * Handles batch processing and background dispatching of scheduled campaigns and recipients.
 */

import Campaign from "./campaign.model.js";
import CampaignRecipient from "./campaign-recipient.model.js";
import { dispatchCampaignRecipient } from "./campaign.service.js";

export interface CampaignWorkerProcessResult {
  processedCampaigns: number;
  dispatchedRecipients: number;
  failedRecipients: number;
  skippedRecipients: number;
}

/**
 * Process a single campaign recipient dispatch job (used by queue workers or direct invocation).
 */
export async function processCampaignRecipientJob(params: {
  workspaceId: string;
  campaignId: string;
  recipientId: string;
}) {
  return dispatchCampaignRecipient(params);
}

/**
 * Sweeps for SCHEDULED campaigns whose scheduledAt is due, marks them PROCESSING,
 * and iterates through PENDING recipients to dispatch.
 */
export async function processScheduledCampaignBatch(
  batchLimit = 10,
): Promise<CampaignWorkerProcessResult> {
  const now = new Date();
  const result: CampaignWorkerProcessResult = {
    processedCampaigns: 0,
    dispatchedRecipients: 0,
    failedRecipients: 0,
    skippedRecipients: 0,
  };

  const dueCampaigns = await Campaign.find({
    status: "SCHEDULED",
    scheduledAt: { $lte: now },
  }).limit(batchLimit);

  for (const campaign of dueCampaigns) {
    result.processedCampaigns += 1;

    // Transition campaign to PROCESSING if not already
    campaign.status = "PROCESSING";
    campaign.startedAt = campaign.startedAt || now;
    await campaign.save();

    const pendingRecipients = await CampaignRecipient.find({
      campaignId: campaign._id,
      status: "PENDING",
    }).limit(100);

    for (const recipient of pendingRecipients) {
      try {
        const dispatchResult = await dispatchCampaignRecipient({
          workspaceId: campaign.workspaceId.toString(),
          campaignId: campaign._id.toString(),
          recipientId: recipient._id.toString(),
        });

        if (dispatchResult.success) {
          result.dispatchedRecipients += 1;
        } else if (dispatchResult.skipped) {
          result.skippedRecipients += 1;
        }
      } catch {
        result.failedRecipients += 1;
      }
    }

    // Check if campaign is completed (no remaining PENDING or PROCESSING recipients)
    const remainingPending = await CampaignRecipient.countDocuments({
      campaignId: campaign._id,
      status: { $in: ["PENDING", "PROCESSING"] },
    });

    if (remainingPending === 0) {
      campaign.status = "COMPLETED";
      campaign.completedAt = new Date();
      await campaign.save();
    }
  }

  return result;
}
