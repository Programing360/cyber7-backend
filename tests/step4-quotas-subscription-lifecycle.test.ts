import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// Ensure test environment variables
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-jwt-access-secret-super-safe-and-long-enough-32-chars";

import Workspace from "../src/modules/workspace/workspace.model.js";
import User from "../src/modules/auth/user.model.js";
import Subscription from "../src/modules/billing/subscription.model.js";
import CustomPlan from "../src/modules/billing/custom-plan.model.js";
import {
  BILLING_PLANS,
  type PlanDefinition,
} from "../src/modules/billing/billing.config.js";
import {
  updateWorkspaceQuotasSchema,
  modifySubscriptionPlanSchema,
  cancelSubscriptionSchema,
  createCustomPlanSchema,
} from "../src/modules/billing/subscription-lifecycle.validation.js";
import { subscriptionLifecycleService } from "../src/modules/billing/subscription-lifecycle.service.js";
import { platformAdminBillingRouter } from "../src/modules/billing/billing.routes.js";
import { platformAdminGovernanceRouter } from "../src/modules/platform-admin-dashboard/governance.routes.js";
import { AppError } from "../src/utils/app-error.js";

describe("Step 4: Quota Overrides & Subscription Lifecycle Test Suite", () => {
  const adminActor = {
    id: new mongoose.Types.ObjectId().toString(),
    email: "finance.admin@vexchat.app",
  };

  describe("Validation Schemas", () => {
    it("should validate updateWorkspaceQuotasSchema with positive numbers, -1, and null", () => {
      const validCustom = updateWorkspaceQuotasSchema.safeParse({
        maxWhatsAppNumbers: 5,
        maxTeamMembers: 25,
      });
      assert.ok(validCustom.success);
      assert.strictEqual(validCustom.data.maxWhatsAppNumbers, 5);
      assert.strictEqual(validCustom.data.maxTeamMembers, 25);

      const validReset = updateWorkspaceQuotasSchema.safeParse({
        maxWhatsAppNumbers: null,
        maxTeamMembers: null,
      });
      assert.ok(validReset.success);

      const validUnlimited = updateWorkspaceQuotasSchema.safeParse({
        maxWhatsAppNumbers: -1,
        maxTeamMembers: -1,
      });
      assert.ok(validUnlimited.success);

      const invalidNegative = updateWorkspaceQuotasSchema.safeParse({
        maxWhatsAppNumbers: -2,
      });
      assert.strictEqual(invalidNegative.success, false);

      const invalidZero = updateWorkspaceQuotasSchema.safeParse({
        maxTeamMembers: 0,
      });
      assert.strictEqual(invalidZero.success, false);
    });

    it("should validate modifySubscriptionPlanSchema requiring planCode and optional immediate flag", () => {
      const validImmediate = modifySubscriptionPlanSchema.safeParse({
        planCode: "ENTERPRISE",
        immediate: true,
        adminNotes: "VIP client tier upgrade",
      });
      assert.ok(validImmediate.success);
      assert.strictEqual(validImmediate.data.planCode, "ENTERPRISE");
      assert.strictEqual(validImmediate.data.immediate, true);

      const validScheduled = modifySubscriptionPlanSchema.safeParse({
        planCode: "BUSINESS_PRO",
        immediate: false,
      });
      assert.ok(validScheduled.success);
      assert.strictEqual(validScheduled.data.immediate, false);

      const invalidEmpty = modifySubscriptionPlanSchema.safeParse({
        planCode: "   ",
      });
      assert.strictEqual(invalidEmpty.success, false);
    });

    it("should validate cancelSubscriptionSchema requiring reason", () => {
      const valid = cancelSubscriptionSchema.safeParse({
        reason: "Customer requested account closure",
        cancelAtPeriodEnd: true,
      });
      assert.ok(valid.success);
      assert.strictEqual(valid.data.cancelAtPeriodEnd, true);

      const invalidShort = cancelSubscriptionSchema.safeParse({
        reason: "no",
      });
      assert.strictEqual(invalidShort.success, false);

      const invalidEmpty = cancelSubscriptionSchema.safeParse({});
      assert.strictEqual(invalidEmpty.success, false);
    });

    it("should validate createCustomPlanSchema requiring complete plan configuration", () => {
      const valid = createCustomPlanSchema.safeParse({
        planCode: "ENTERPRISE_CUSTOM_A",
        name: "Enterprise Custom Tier A",
        priceBdt: 25000,
        description: "Tailored enterprise setup with dedicated infrastructure",
        limits: {
          maxWhatsAppNumbers: 10,
          maxTeamMembers: 50,
        },
        features: ["10 WhatsApp Numbers", "50 Team Members", "Dedicated SLA"],
      });
      assert.ok(valid.success);
      assert.strictEqual(valid.data.planCode, "ENTERPRISE_CUSTOM_A");

      const invalidNegativePrice = createCustomPlanSchema.safeParse({
        planCode: "FAIL_PLAN",
        name: "Fail Plan",
        priceBdt: -100,
        limits: { maxWhatsAppNumbers: 1, maxTeamMembers: 1 },
      });
      assert.strictEqual(invalidNegativePrice.success, false);
    });
  });

  describe("Workspace Custom Quota Adjustments & Precedence Logic", () => {
    it("should fall back to subscription defaults when customLimits are not set", async () => {
      const workspaceId = new mongoose.Types.ObjectId();
      const originalWorkspaceFind = Workspace.findById;
      const originalSubFind = Subscription.findOne;

      try {
        (Workspace as any).findById = () => ({
          select: () => ({
            _id: workspaceId,
            customLimits: { maxWhatsAppNumbers: null, maxTeamMembers: null },
          }),
        });

        (Subscription as any).findOne = () => ({
          select: () => ({
            planCode: "STARTER",
            limits: { maxWhatsAppNumbers: 1, maxTeamMembers: 3 },
          }),
        });

        const effective = await subscriptionLifecycleService.getEffectiveWorkspaceLimits(
          workspaceId.toString(),
        );

        assert.strictEqual(effective.maxWhatsAppNumbers, 1);
        assert.strictEqual(effective.maxTeamMembers, 3);
        assert.strictEqual(effective.isCustomOverride.maxWhatsAppNumbers, false);
        assert.strictEqual(effective.isCustomOverride.maxTeamMembers, false);
      } finally {
        Workspace.findById = originalWorkspaceFind;
        Subscription.findOne = originalSubFind;
      }
    });

    it("should prioritize customLimits over subscription tier limits", async () => {
      const workspaceId = new mongoose.Types.ObjectId();
      const originalWorkspaceFind = Workspace.findById;
      const originalSubFind = Subscription.findOne;

      try {
        (Workspace as any).findById = () => ({
          select: () => ({
            _id: workspaceId,
            customLimits: { maxWhatsAppNumbers: 8, maxTeamMembers: 30 },
          }),
        });

        (Subscription as any).findOne = () => ({
          select: () => ({
            planCode: "STARTER", // standard starter tier has (1, 3)
            limits: { maxWhatsAppNumbers: 1, maxTeamMembers: 3 },
          }),
        });

        const effective = await subscriptionLifecycleService.getEffectiveWorkspaceLimits(
          workspaceId.toString(),
        );

        // Custom limits must override starter limits
        assert.strictEqual(effective.maxWhatsAppNumbers, 8);
        assert.strictEqual(effective.maxTeamMembers, 30);
        assert.strictEqual(effective.isCustomOverride.maxWhatsAppNumbers, true);
        assert.strictEqual(effective.isCustomOverride.maxTeamMembers, true);
      } finally {
        Workspace.findById = originalWorkspaceFind;
        Subscription.findOne = originalSubFind;
      }
    });

    it("should update and persist workspace customLimits", async () => {
      const workspaceId = new mongoose.Types.ObjectId();
      const mockWorkspace = {
        _id: workspaceId,
        name: "Growth Scale Ltd",
        customLimits: { maxWhatsAppNumbers: null, maxTeamMembers: null },
        save: async function () {
          return this;
        },
      };

      const originalWorkspaceFind = Workspace.findById;
      const originalSubFind = Subscription.findOne;

      try {
        (Workspace as any).findById = () => mockWorkspace;
        (Subscription as any).findOne = () => ({
          select: () => ({
            planCode: "BUSINESS_PRO",
            limits: { maxWhatsAppNumbers: 2, maxTeamMembers: 10 },
          }),
        });

        const result = await subscriptionLifecycleService.updateWorkspaceQuotas({
          workspaceId: workspaceId.toString(),
          quotas: { maxWhatsAppNumbers: 5, maxTeamMembers: 20 },
          adminUser: adminActor,
        });

        assert.strictEqual(mockWorkspace.customLimits.maxWhatsAppNumbers, 5);
        assert.strictEqual(mockWorkspace.customLimits.maxTeamMembers, 20);
        assert.strictEqual(result.effectiveLimits.maxWhatsAppNumbers, 5);
        assert.strictEqual(result.effectiveLimits.maxTeamMembers, 20);
      } finally {
        Workspace.findById = originalWorkspaceFind;
        Subscription.findOne = originalSubFind;
      }
    });
  });

  describe("Administrative Subscription Plan Modification (Upgrade / Downgrade Override)", () => {
    it("should immediately override subscription plan, updating price, limits, and history", async () => {
      const subscriptionId = new mongoose.Types.ObjectId();
      const workspaceId = new mongoose.Types.ObjectId();

      const mockSub = {
        _id: subscriptionId,
        workspaceId,
        planCode: "STARTER",
        planName: "Starter",
        status: "ACTIVE",
        price: 3000,
        limits: { maxWhatsAppNumbers: 1, maxTeamMembers: 3 },
        features: ["Basic"],
        history: [],
        currentPeriodStart: new Date("2026-11-01"),
        currentPeriodEnd: new Date("2026-12-01"),
        scheduledPlanChange: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = Subscription.findById;
      const originalWorkspaceUpdate = Workspace.updateOne;
      const originalUserUpdate = User.updateOne;

      try {
        (Subscription as any).findById = () => mockSub;
        (Workspace as any).updateOne = async () => ({ modifiedCount: 1 });
        (User as any).updateOne = async () => ({ modifiedCount: 1 });

        const updated = await subscriptionLifecycleService.modifySubscriptionPlan({
          subscriptionId: subscriptionId.toString(),
          input: {
            planCode: "ENTERPRISE",
            immediate: true,
            adminNotes: "Client upgraded by account manager",
          },
          adminUser: adminActor,
        });

        assert.strictEqual(updated.planCode, "ENTERPRISE");
        assert.strictEqual(updated.price, BILLING_PLANS.ENTERPRISE.priceBdt);
        assert.strictEqual(
          updated.limits.maxWhatsAppNumbers,
          BILLING_PLANS.ENTERPRISE.limits.maxWhatsAppNumbers,
        );
        assert.strictEqual(updated.history.length, 1);
        assert.strictEqual(updated.scheduledPlanChange, null);
      } finally {
        Subscription.findById = originalFindById;
        Workspace.updateOne = originalWorkspaceUpdate;
        User.updateOne = originalUserUpdate;
      }
    });

    it("should schedule a plan change at period end when immediate is false", async () => {
      const subscriptionId = new mongoose.Types.ObjectId();
      const periodEnd = new Date("2026-12-15T00:00:00Z");

      const mockSub = {
        _id: subscriptionId,
        planCode: "STARTER",
        status: "ACTIVE",
        currentPeriodEnd: periodEnd,
        scheduledPlanChange: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = Subscription.findById;

      try {
        (Subscription as any).findById = () => mockSub;

        const updated = await subscriptionLifecycleService.modifySubscriptionPlan({
          subscriptionId: subscriptionId.toString(),
          input: {
            planCode: "BUSINESS_PRO",
            immediate: false,
          },
          adminUser: adminActor,
        });

        // Plan code remains STARTER until period end
        assert.strictEqual(updated.planCode, "STARTER");
        assert.ok(updated.scheduledPlanChange !== null);
        assert.strictEqual(updated.scheduledPlanChange?.planCode, "BUSINESS_PRO");
        assert.strictEqual(
          updated.scheduledPlanChange?.effectiveAt.toISOString(),
          periodEnd.toISOString(),
        );
      } finally {
        Subscription.findById = originalFindById;
      }
    });

    it("should reject modification with invalid plan code", async () => {
      const subscriptionId = new mongoose.Types.ObjectId();

      await assert.rejects(
        async () => {
          await subscriptionLifecycleService.modifySubscriptionPlan({
            subscriptionId: subscriptionId.toString(),
            input: {
              planCode: "NON_EXISTENT_TIER",
              immediate: true,
            },
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes("Invalid plan code"));
          return true;
        },
      );
    });
  });

  describe("Subscription Cancellation Engine", () => {
    it("should schedule cancellation at period end without immediately revoking workspace", async () => {
      const subscriptionId = new mongoose.Types.ObjectId();
      const mockSub = {
        _id: subscriptionId,
        status: "ACTIVE",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancellationReason: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = Subscription.findById;

      try {
        (Subscription as any).findById = () => mockSub;

        const updated = await subscriptionLifecycleService.cancelSubscription({
          subscriptionId: subscriptionId.toString(),
          input: {
            reason: "Client downsizing operations",
            cancelAtPeriodEnd: true,
          },
          adminUser: adminActor,
        });

        assert.strictEqual(updated.status, "ACTIVE"); // stays active
        assert.strictEqual(updated.cancelAtPeriodEnd, true);
        assert.ok(updated.canceledAt instanceof Date);
        assert.strictEqual(updated.cancellationReason, "Client downsizing operations");
      } finally {
        Subscription.findById = originalFindById;
      }
    });

    it("should cancel immediately, transitioning status to CANCELLED and updating user", async () => {
      const subscriptionId = new mongoose.Types.ObjectId();
      const workspaceId = new mongoose.Types.ObjectId();
      const ownerId = new mongoose.Types.ObjectId();

      const mockSub = {
        _id: subscriptionId,
        workspaceId,
        status: "ACTIVE",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancellationReason: null,
        save: async function () {
          return this;
        },
      };

      const originalSubFind = Subscription.findById;
      const originalWsFind = Workspace.findById;
      const originalUserUpdate = User.updateOne;

      try {
        (Subscription as any).findById = () => mockSub;
        (Workspace as any).findById = () => ({
          _id: workspaceId,
          ownerId,
        });
        (User as any).updateOne = async () => ({ modifiedCount: 1 });

        const updated = await subscriptionLifecycleService.cancelSubscription({
          subscriptionId: subscriptionId.toString(),
          input: {
            reason: "Breach of acceptable use policy",
            cancelAtPeriodEnd: false,
          },
          adminUser: adminActor,
        });

        assert.strictEqual(updated.status, "CANCELLED");
        assert.strictEqual(updated.cancelAtPeriodEnd, false);
        assert.ok(updated.canceledAt instanceof Date);
        assert.strictEqual(updated.cancellationReason, "Breach of acceptable use policy");
      } finally {
        Subscription.findById = originalSubFind;
        Workspace.findById = originalWsFind;
        User.updateOne = originalUserUpdate;
      }
    });
  });

  describe("Custom Enterprise Plan Catalog Registration", () => {
    it("should create and register a new custom enterprise plan in catalog and memory", async () => {
      const customCode = `ENT_TEST_${Date.now()}`;
      const originalCreate = CustomPlan.create;
      const originalFindOne = CustomPlan.findOne;

      try {
        (CustomPlan as any).findOne = async () => null;
        (CustomPlan as any).create = async (doc: any) => ({
          ...doc,
          _id: new mongoose.Types.ObjectId(),
        });

        const plan = await subscriptionLifecycleService.registerCustomPlan({
          input: {
            planCode: customCode,
            name: "Enterprise Dedicated 100",
            priceBdt: 45000,
            description: "Dedicated cluster setup",
            limits: {
              maxWhatsAppNumbers: 25,
              maxTeamMembers: 100,
            },
            features: ["Dedicated Database", "Custom SLA"],
          },
          adminUser: adminActor,
        });

        assert.strictEqual(plan.code, customCode);
        assert.strictEqual(plan.priceBdt, 45000);
        assert.strictEqual(plan.limits.maxWhatsAppNumbers, 25);
        assert.strictEqual(plan.limits.maxTeamMembers, 100);

        // Verify resolved through resolvePlanDefinition
        const resolved = await subscriptionLifecycleService.resolvePlanDefinition(customCode);
        assert.ok(resolved !== null);
        assert.strictEqual(resolved?.priceBdt, 45000);
      } finally {
        CustomPlan.create = originalCreate;
        CustomPlan.findOne = originalFindOne;
      }
    });

    it("should reject duplicate plan code with 409 Conflict", async () => {
      await assert.rejects(
        async () => {
          await subscriptionLifecycleService.registerCustomPlan({
            input: {
              planCode: "STARTER", // already in BILLING_PLANS
              name: "Duplicate Starter",
              priceBdt: 3000,
              limits: { maxWhatsAppNumbers: 1, maxTeamMembers: 3 },
            },
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 409);
          assert.strictEqual(err.code, "PLAN_CODE_ALREADY_EXISTS");
          return true;
        },
      );
    });
    it("should list dynamic plan catalog including memory and custom plans", async () => {
      const catalog = await subscriptionLifecycleService.listPlansCatalog();
      assert.ok(Array.isArray(catalog));
      assert.ok(catalog.length >= 3);
      const starter = catalog.find((p) => p.code === "STARTER");
      assert.ok(starter);
      assert.strictEqual(starter.isCustom, false);
    });

    it("should update an existing plan configuration", async () => {
      const updated = await subscriptionLifecycleService.updatePlan({
        planCode: "STARTER",
        input: {
          priceBdt: 3200,
          description: "Updated starter tier description",
        },
        adminUser: adminActor,
      });

      assert.strictEqual(updated.code, "STARTER");
      assert.strictEqual(updated.priceBdt, 3200);
      assert.strictEqual(updated.description, "Updated starter tier description");
    });

    it("should reject deletion of built-in system plans", async () => {
      await assert.rejects(
        async () => {
          await subscriptionLifecycleService.deletePlan({
            planCode: "STARTER",
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "BUILT_IN_PLAN_CANNOT_BE_DELETED");
          return true;
        },
      );
    });

    it("should reject deletion of a custom plan with active subscriptions", async () => {
      // Mock Subscription.countDocuments
      const originalCount = Subscription.countDocuments;
      (Subscription as any).countDocuments = async () => 2;

      try {
        await assert.rejects(
          async () => {
            await subscriptionLifecycleService.deletePlan({
              planCode: "CUSTOM_CORP_TEST",
              adminUser: adminActor,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 409);
            assert.strictEqual(err.code, "PLAN_IN_USE_BY_ACTIVE_SUBSCRIPTIONS");
            return true;
          },
        );
      } finally {
        Subscription.countDocuments = originalCount;
      }
    });

    it("should successfully delete an unused custom plan", async () => {
      const originalCount = Subscription.countDocuments;
      (Subscription as any).countDocuments = async () => 0;

      const deleteCode = "CUSTOM_DELETE_TEST";
      BILLING_PLANS[deleteCode] = {
        code: deleteCode,
        name: "Temporary Plan",
        priceBdt: 12000,
        description: "To be deleted",
        limits: { maxWhatsAppNumbers: 5, maxTeamMembers: 10 },
        features: [],
      };

      try {
        const result = await subscriptionLifecycleService.deletePlan({
          planCode: deleteCode,
          adminUser: adminActor,
        });

        assert.strictEqual(result.success, true);
        assert.ok(result.message.includes("deleted successfully"));
        assert.strictEqual(BILLING_PLANS[deleteCode], undefined);
      } finally {
        Subscription.countDocuments = originalCount;
      }
    });
  });

  describe("Router Configuration & Endpoint Mounting", () => {
    it("should have all Step 4 administrative routes mounted and accessible", () => {
      const billingRoutes = platformAdminBillingRouter.stack
        .filter((l) => l.route)
        .map((l) => l.route.path);

      assert.ok(
        billingRoutes.includes("/plans"),
        "platformAdminBillingRouter must include /plans",
      );
      assert.ok(
        billingRoutes.includes("/plans/:planCode"),
        "platformAdminBillingRouter must include /plans/:planCode",
      );
      assert.ok(
        billingRoutes.includes("/subscriptions/:subscriptionId/plan"),
        "platformAdminBillingRouter must include /subscriptions/:subscriptionId/plan",
      );
      assert.ok(
        billingRoutes.includes("/subscriptions/:subscriptionId/cancel"),
        "platformAdminBillingRouter must include /subscriptions/:subscriptionId/cancel",
      );

      const governanceRoutes = platformAdminGovernanceRouter.stack
        .filter((l) => l.route)
        .map((l) => l.route.path);

      assert.ok(
        governanceRoutes.includes("/workspaces/:workspaceId/quotas"),
        "platformAdminGovernanceRouter must include /workspaces/:workspaceId/quotas",
      );
    });
  });
});

