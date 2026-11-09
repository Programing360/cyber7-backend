import mongoose, { type Types } from "mongoose";
import PlatformSettings, {
  type IPlatformSettings,
} from "./platform-settings.model.js";
import { adminSecurityAuditService } from "../admin-auth/admin-security-audit.service.js";
import type { UpdatePlatformSettingsInput } from "./platform-settings.validation.js";

export interface AdminActorContext {
  adminUserId?: string | Types.ObjectId;
  adminEmail?: string;
  sessionId?: string | Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
}

export class PlatformSettingsService {
  /**
   * Fetch current singleton platform configuration (initializes default if absent)
   */
  public async getSettings(): Promise<IPlatformSettings> {
    let settings = await PlatformSettings.findOne({ key: "GLOBAL_CONFIG" });
    if (!settings) {
      settings = new PlatformSettings({
        key: "GLOBAL_CONFIG",
        currency: "BDT",
        sessionPolicies: {
          idleTimeoutMinutes: 15,
          absoluteLifetimeHours: 8,
          highValueStepUpThresholdBdt: 50000,
        },
        gatewayToggles: {
          bkashDirect: true,
          cityBankTransfer: true,
          portPosCards: true,
        },
      });
      await settings.save();
    }
    return settings;
  }

  /**
   * Upsert system policies & gateway toggles
   */
  public async updateSettings(
    input: UpdatePlatformSettingsInput,
    actor: AdminActorContext,
  ): Promise<IPlatformSettings> {
    let settings = await PlatformSettings.findOne({ key: "GLOBAL_CONFIG" });
    if (!settings) {
      settings = new PlatformSettings({ key: "GLOBAL_CONFIG" });
    }

    if (input.currency) {
      settings.currency = input.currency.toUpperCase();
    }

    if (input.sessionPolicies) {
      settings.sessionPolicies = {
        idleTimeoutMinutes:
          input.sessionPolicies.idleTimeoutMinutes ??
          settings.sessionPolicies?.idleTimeoutMinutes ??
          15,
        absoluteLifetimeHours:
          input.sessionPolicies.absoluteLifetimeHours ??
          settings.sessionPolicies?.absoluteLifetimeHours ??
          8,
        highValueStepUpThresholdBdt:
          input.sessionPolicies.highValueStepUpThresholdBdt ??
          settings.sessionPolicies?.highValueStepUpThresholdBdt ??
          50000,
      };
    }

    if (input.gatewayToggles) {
      settings.gatewayToggles = {
        bkashDirect:
          input.gatewayToggles.bkashDirect ??
          settings.gatewayToggles?.bkashDirect ??
          true,
        cityBankTransfer:
          input.gatewayToggles.cityBankTransfer ??
          settings.gatewayToggles?.cityBankTransfer ??
          true,
        portPosCards:
          input.gatewayToggles.portPosCards ??
          settings.gatewayToggles?.portPosCards ??
          true,
      };
    }

    if (actor.adminUserId) {
      settings.updatedBy = new mongoose.Types.ObjectId(actor.adminUserId);
    }

    await settings.save();

    await adminSecurityAuditService.recordSecurityEvent({
      eventType: "PLATFORM_SETTINGS_UPDATED",
      adminUserId: actor.adminUserId,
      adminEmail: actor.adminEmail,
      sessionId: actor.sessionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      reason: `Platform settings updated by ${actor.adminEmail || "Super Admin"}`,
      metadata: {
        currency: settings.currency,
        sessionPolicies: settings.sessionPolicies,
        gatewayToggles: settings.gatewayToggles,
      },
    });

    return settings;
  }
}

export const platformSettingsService = new PlatformSettingsService();

