import crypto from "node:crypto";
import mongoose from "mongoose";
import WorkspaceSettings, {
  type IWorkspaceSettings,
} from "./workspace-settings.model.js";
import Workspace from "../workspace/workspace.model.js";
import type { UpdateWorkspaceSettingsInput } from "./setting.validation.js";

export interface SettingsActorContext {
  userId: string;
  userEmail?: string;
  userName?: string;
}

export class WorkspaceSettingsService {
  /**
   * Helper: Generate a unique secure API key
   */
  public generateRandomApiKey(): string {
    const randomHex = crypto.randomBytes(24).toString("hex");
    return `vx_live_${randomHex}`;
  }

  /**
   * Helper: Generate a secure webhook secret
   */
  public generateWebhookSecret(): string {
    const randomHex = crypto.randomBytes(20).toString("hex");
    return `whsec_${randomHex}`;
  }

  /**
   * Fetch workspace settings with automatic initial seeding
   */
  public async getSettings(
    workspaceId: string,
    actor?: SettingsActorContext,
  ): Promise<IWorkspaceSettings> {
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      throw new Error("Invalid workspace ID format");
    }

    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
    let settings = await WorkspaceSettings.findOne({ workspaceId: wsObjectId });

    if (!settings) {
      // Find workspace for default metadata
      const workspace = await Workspace.findById(wsObjectId);
      const wsName = workspace?.name || "My Business";
      const wsTimezone = workspace?.timezone || "Asia/Dhaka";

      settings = new WorkspaceSettings({
        workspaceId: wsObjectId,
        business: {
          businessName: wsName,
          businessEmail: actor?.userEmail || "",
          phoneNumber: "",
          website: "",
          industry: "Technology",
          timezone: wsTimezone,
          country: "Bangladesh",
          description: `Workspace settings for ${wsName}`,
        },
        notifications: {
          emailNotifications: true,
          campaignUpdates: true,
          messageFailureAlerts: true,
          teamActivityAlerts: false,
          weeklyReports: true,
          productUpdates: false,
        },
        security: {
          twoFactorEnabled: false,
          loginAlerts: true,
          sessionTimeout: "30",
        },
        api: {
          apiKey: this.generateRandomApiKey(),
          webhookUrl: "",
          webhookSecret: this.generateWebhookSecret(),
          webhookEvents: [
            "message.delivered",
            "message.failed",
            "message.read",
            "message.received",
            "campaign.completed",
          ],
        },
        updatedBy: actor?.userId && mongoose.Types.ObjectId.isValid(actor.userId)
          ? new mongoose.Types.ObjectId(actor.userId)
          : null,
      });

      await settings.save();
    } else {
      // Ensure apiKey and webhookSecret exist if older document lacked them
      let needsSave = false;
      if (!settings.api.apiKey) {
        settings.api.apiKey = this.generateRandomApiKey();
        needsSave = true;
      }
      if (!settings.api.webhookSecret) {
        settings.api.webhookSecret = this.generateWebhookSecret();
        needsSave = true;
      }
      if (needsSave) {
        await settings.save();
      }
    }

    return settings;
  }

  /**
   * Update workspace settings
   */
  public async updateSettings(
    workspaceId: string,
    input: UpdateWorkspaceSettingsInput,
    actor: SettingsActorContext,
  ): Promise<IWorkspaceSettings> {
    const settings = await this.getSettings(workspaceId, actor);
    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);

    // 1. Update Business Profile
    if (input.business) {
      const prevName = settings.business.businessName;
      settings.business = {
        ...settings.business,
        ...input.business,
      };

      // Synchronize workspace name & timezone if modified
      if (
        input.business.businessName &&
        input.business.businessName !== prevName
      ) {
        const workspace = await Workspace.findById(wsObjectId);
        if (workspace) {
          workspace.name = input.business.businessName.trim();
          workspace.nameNormalized = input.business.businessName
            .trim()
            .toLowerCase();
          if (input.business.timezone) {
            workspace.timezone = input.business.timezone;
          }
          await workspace.save();
        }
      } else if (input.business.timezone) {
        await Workspace.findByIdAndUpdate(wsObjectId, {
          timezone: input.business.timezone,
        });
      }
    }

    // 2. Update Notifications
    if (input.notifications) {
      settings.notifications = {
        ...settings.notifications,
        ...input.notifications,
      };
    }

    // 3. Update Security
    if (input.security) {
      settings.security = {
        ...settings.security,
        ...input.security,
      };
    }

    // 4. Update API
    if (input.api) {
      settings.api = {
        ...settings.api,
        webhookUrl: input.api.webhookUrl !== undefined ? input.api.webhookUrl : settings.api.webhookUrl,
        webhookEvents: input.api.webhookEvents ?? settings.api.webhookEvents,
      };
    }

    if (actor.userId && mongoose.Types.ObjectId.isValid(actor.userId)) {
      settings.updatedBy = new mongoose.Types.ObjectId(actor.userId);
    }

    await settings.save();
    return settings;
  }

  /**
   * Regenerate API Key
   */
  public async regenerateApiKey(
    workspaceId: string,
    actor: SettingsActorContext,
  ): Promise<{ apiKey: string }> {
    const settings = await this.getSettings(workspaceId, actor);
    const newApiKey = this.generateRandomApiKey();

    settings.api.apiKey = newApiKey;
    if (actor.userId && mongoose.Types.ObjectId.isValid(actor.userId)) {
      settings.updatedBy = new mongoose.Types.ObjectId(actor.userId);
    }

    await settings.save();
    return { apiKey: newApiKey };
  }
}

export const workspaceSettingsService = new WorkspaceSettingsService();

