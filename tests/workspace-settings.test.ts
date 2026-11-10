import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { workspaceSettingsService } from "../src/modules/setting/workspace-settings.service.js";
import WorkspaceSettings from "../src/modules/setting/workspace-settings.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";

describe("Workspace Settings — Service & Configuration Suite", () => {
  const dummyWorkspaceId = new mongoose.Types.ObjectId().toString();
  const dummyUserId = new mongoose.Types.ObjectId().toString();

  it("should generate random API key with 'vx_live_' prefix", () => {
    const key = workspaceSettingsService.generateRandomApiKey();
    assert.ok(key.startsWith("vx_live_"));
    assert.ok(key.length > 20);
  });

  it("should generate webhook secret with 'whsec_' prefix", () => {
    const secret = workspaceSettingsService.generateWebhookSecret();
    assert.ok(secret.startsWith("whsec_"));
    assert.ok(secret.length > 15);
  });

  it("should initialize default workspace settings with business, notification, security, and api structures", async () => {
    // Mock Workspace and WorkspaceSettings find
    const origFindById = Workspace.findById;
    const origFindOne = WorkspaceSettings.findOne;
    const origSave = WorkspaceSettings.prototype.save;

    try {
      (Workspace as any).findById = async () => ({
        _id: new mongoose.Types.ObjectId(dummyWorkspaceId),
        name: "Test Business Inc",
        timezone: "Asia/Dhaka",
      });

      let savedDoc: any = null;
      (WorkspaceSettings as any).findOne = async () => null;
      (WorkspaceSettings.prototype as any).save = async function () {
        savedDoc = this;
        return this;
      };

      const settings = await workspaceSettingsService.getSettings(dummyWorkspaceId, {
        userId: dummyUserId,
        userEmail: "owner@test.com",
      });

      assert.ok(settings);
      assert.equal(settings.business.businessName, "Test Business Inc");
      assert.equal(settings.business.businessEmail, "owner@test.com");
      assert.equal(settings.notifications.emailNotifications, true);
      assert.equal(settings.security.twoFactorEnabled, false);
      assert.ok(settings.api.apiKey.startsWith("vx_live_"));
      assert.ok(settings.api.webhookSecret.startsWith("whsec_"));
    } finally {
      Workspace.findById = origFindById;
      WorkspaceSettings.findOne = origFindOne;
      WorkspaceSettings.prototype.save = origSave;
    }
  });

  it("should update workspace settings and synchronize workspace name", async () => {
    const origFindById = Workspace.findById;
    const origFindOne = WorkspaceSettings.findOne;
    const origSave = WorkspaceSettings.prototype.save;
    let updatedWorkspaceName = "";

    try {
      const mockSettingsDoc: any = {
        workspaceId: new mongoose.Types.ObjectId(dummyWorkspaceId),
        business: {
          businessName: "Old Name",
          businessEmail: "old@test.com",
          timezone: "Asia/Dhaka",
        },
        notifications: { emailNotifications: true },
        security: { twoFactorEnabled: false },
        api: { apiKey: "vx_live_test", webhookUrl: "", webhookEvents: [] },
        save: async function () {
          return this;
        },
      };

      (WorkspaceSettings as any).findOne = async () => mockSettingsDoc;

      (Workspace as any).findById = async () => ({
        _id: new mongoose.Types.ObjectId(dummyWorkspaceId),
        name: "Old Name",
        nameNormalized: "old name",
        timezone: "Asia/Dhaka",
        save: async function () {
          updatedWorkspaceName = this.name;
          return this;
        },
      });

      const updated = await workspaceSettingsService.updateSettings(
        dummyWorkspaceId,
        {
          business: {
            businessName: "New Upgraded Business",
            website: "https://vexchat.io",
          },
          notifications: {
            campaignUpdates: false,
          },
          security: {
            twoFactorEnabled: true,
          },
          api: {
            webhookUrl: "https://api.example.com/webhook",
          },
        },
        {
          userId: dummyUserId,
        },
      );

      assert.equal(updated.business.businessName, "New Upgraded Business");
      assert.equal(updated.business.website, "https://vexchat.io");
      assert.equal(updated.notifications.campaignUpdates, false);
      assert.equal(updated.security.twoFactorEnabled, true);
      assert.equal(updated.api.webhookUrl, "https://api.example.com/webhook");
      assert.equal(updatedWorkspaceName, "New Upgraded Business");
    } finally {
      Workspace.findById = origFindById;
      WorkspaceSettings.findOne = origFindOne;
      WorkspaceSettings.prototype.save = origSave;
    }
  });

  it("should regenerate a new API key", async () => {
    const origFindOne = WorkspaceSettings.findOne;

    try {
      const mockSettingsDoc: any = {
        workspaceId: new mongoose.Types.ObjectId(dummyWorkspaceId),
        api: { apiKey: "vx_live_old" },
        save: async function () {
          return this;
        },
      };

      (WorkspaceSettings as any).findOne = async () => mockSettingsDoc;

      const result = await workspaceSettingsService.regenerateApiKey(dummyWorkspaceId, {
        userId: dummyUserId,
      });

      assert.ok(result.apiKey.startsWith("vx_live_"));
      assert.notEqual(result.apiKey, "vx_live_old");
      assert.equal(mockSettingsDoc.api.apiKey, result.apiKey);
    } finally {
      WorkspaceSettings.findOne = origFindOne;
    }
  });
});

