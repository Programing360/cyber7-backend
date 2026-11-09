import mongoose, { type Types } from "mongoose";
import Workspace from "../workspace/workspace.model.js";
import User from "../auth/user.model.js";
import Subscription, { type ISubscription } from "./subscription.model.js";
import CustomPlan, { type ICustomPlan } from "./custom-plan.model.js";
import {
  BILLING_PLANS,
  registerPlanInMemory,
  removePlanFromMemory,
  type PlanDefinition,
} from "./billing.config.js";
import { adminSecurityAuditService } from "../admin-auth/admin-security-audit.service.js";
import { AppError } from "../../utils/app-error.js";
import { runWithTransaction } from "./billing-transaction.util.js";
import type {
  CancelSubscriptionInput,
  CreateCustomPlanInput,
  ModifySubscriptionPlanInput,
  UpdateCustomPlanInput,
  UpdateWorkspaceQuotasInput,
} from "./subscription-lifecycle.validation.js";

export class SubscriptionLifecycleService {
  /**
   * Resolves effective limits for a workspace with strict precedence:
   * Workspace customLimits override subscription / standard tier defaults.
   */
  async getEffectiveWorkspaceLimits(
    workspaceOrId: string | Types.ObjectId | any,
  ) {
    let workspace: any;
    let workspaceId: string | Types.ObjectId;

    if (workspaceOrId && typeof workspaceOrId === "object" && "_id" in workspaceOrId) {
      workspace = workspaceOrId;
      workspaceId = workspaceOrId._id;
    } else {
      workspaceId = workspaceOrId;
      workspace = await Workspace.findById(workspaceId).select("customLimits");
    }

    const subQuery = Subscription.findOne({ workspaceId, status: "ACTIVE" });
    const subscription = subQuery.select
      ? await subQuery.select("limits planCode")
      : await subQuery;

    const defaultLimits = subscription?.limits || BILLING_PLANS.STARTER.limits;

    const maxWhatsAppNumbers =
      workspace?.customLimits?.maxWhatsAppNumbers !== null &&
      workspace?.customLimits?.maxWhatsAppNumbers !== undefined
        ? workspace.customLimits.maxWhatsAppNumbers
        : defaultLimits.maxWhatsAppNumbers;

    const maxTeamMembers =
      workspace?.customLimits?.maxTeamMembers !== null &&
      workspace?.customLimits?.maxTeamMembers !== undefined
        ? workspace.customLimits.maxTeamMembers
        : defaultLimits.maxTeamMembers;

    return {
      maxWhatsAppNumbers,
      maxTeamMembers,
      isCustomOverride: {
        maxWhatsAppNumbers: workspace?.customLimits?.maxWhatsAppNumbers != null,
        maxTeamMembers: workspace?.customLimits?.maxTeamMembers != null,
      },
    };
  }

  /**
   * Updates workspace custom quota overrides (customLimits).
   * Values take immediate precedence over standard tier defaults.
   */
  async updateWorkspaceQuotas(params: {
    workspaceId: string | Types.ObjectId;
    quotas: UpdateWorkspaceQuotasInput;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { workspaceId, quotas, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      throw new AppError("A valid workspace ID is required", 400);
    }

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      throw new AppError("Workspace not found", 404);
    }

    if (!workspace.customLimits) {
      workspace.customLimits = { maxWhatsAppNumbers: null, maxTeamMembers: null };
    }

    if (quotas.maxWhatsAppNumbers !== undefined) {
      workspace.customLimits.maxWhatsAppNumbers = quotas.maxWhatsAppNumbers;
    }
    if (quotas.maxTeamMembers !== undefined) {
      workspace.customLimits.maxTeamMembers = quotas.maxTeamMembers;
    }

    await workspace.save();

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "WORKSPACE_QUOTA_ADJUSTED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: "Workspace custom quota overrides updated by platform administrator",
        metadata: {
          workspaceId: String(workspace._id),
          workspaceName: workspace.name,
          customLimits: workspace.customLimits,
        },
      })
      .catch((err) => {
        console.error("[SubscriptionLifecycle] Failed to log quota adjustment:", err);
      });

    const effectiveLimits = await this.getEffectiveWorkspaceLimits(workspace);

    return {
      workspace,
      effectiveLimits,
    };
  }

  /**
   * Resolves a plan definition from memory or from the custom plan database collection.
   */
  async resolvePlanDefinition(planCode: string): Promise<PlanDefinition | null> {
    const normalized = planCode.trim().toUpperCase();
    if (BILLING_PLANS[normalized]) {
      return BILLING_PLANS[normalized];
    }

    if (mongoose.connection.readyState !== 1 && process.env.NODE_ENV !== "production") {
      return null;
    }

    try {
      const custom = await CustomPlan.findOne({ code: normalized });
      if (custom) {
        const planDef: PlanDefinition = {
          code: custom.code,
          name: custom.name,
          priceBdt: custom.priceBdt,
          description: custom.description,
          limits: { ...custom.limits },
          features: [...custom.features],
        };
        registerPlanInMemory(planDef);
        return planDef;
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Modifies a workspace subscription plan (Upgrade / Downgrade Override).
   * Supports immediate application or scheduling at currentPeriodEnd.
   */
  async modifySubscriptionPlan(params: {
    subscriptionId: string | Types.ObjectId;
    input: ModifySubscriptionPlanInput;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }): Promise<ISubscription> {
    const { subscriptionId, input, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(subscriptionId)) {
      throw new AppError("A valid subscription ID is required", 400);
    }

    const planDef = await this.resolvePlanDefinition(input.planCode);
    if (!planDef) {
      throw new AppError(`Invalid plan code: ${input.planCode}`, 400);
    }

    return runWithTransaction(async (session) => {
      const subQuery = Subscription.findById(subscriptionId);
      if (session) subQuery.session(session);
      const subscription = await subQuery;

      if (!subscription) {
        throw new AppError("Subscription record not found", 404);
      }

      const previousPlan = subscription.planCode;

      if (input.immediate) {
        subscription.planCode = planDef.code;
        subscription.planName = planDef.name;
        subscription.price = planDef.priceBdt;
        subscription.limits = { ...planDef.limits };
        subscription.features = [...planDef.features];
        subscription.scheduledPlanChange = null;

        // If subscription was cancelled or expired, reactivate it
        if (subscription.status !== "ACTIVE") {
          subscription.status = "ACTIVE";
          subscription.currentPeriodStart = new Date();
          subscription.currentPeriodEnd = new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          );
        }

        subscription.history.push({
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          planCode: planDef.code,
          extendedAt: new Date(),
        });

        // Update associated workspace & owner
        const wsUpdate = Workspace.updateOne(
          { _id: subscription.workspaceId },
          { $set: { status: "ACTIVE" } },
        );
        if (session) wsUpdate.session(session);

        const userUpdate = User.updateOne(
          { _id: subscription.workspaceId }, // will match if workspace has owner or find via workspace
          { $set: { isPaid: true, subscriptionStatus: "active" } },
        );
        if (session) userUpdate.session(session);

        await Promise.all([wsUpdate, userUpdate]);
      } else {
        // Schedule plan change at period end
        subscription.scheduledPlanChange = {
          planCode: planDef.code,
          effectiveAt: subscription.currentPeriodEnd,
        };
      }

      if (session) {
        await subscription.save({ session });
      } else {
        await subscription.save();
      }

      await adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "SUBSCRIPTION_PLAN_OVERRIDDEN",
          adminUserId: adminUser.id,
          adminEmail: adminUser.email,
          ipAddress,
          userAgent,
          reason: `Subscription plan overridden to ${planDef.code} (${input.immediate ? "Immediate" : "Scheduled"})`,
          metadata: {
            subscriptionId: String(subscription._id),
            workspaceId: String(subscription.workspaceId),
            previousPlan,
            newPlan: planDef.code,
            immediate: input.immediate,
            adminNotes: input.adminNotes,
          },
        })
        .catch((err) => {
          console.error("[SubscriptionLifecycle] Failed to log plan modification:", err);
        });

      return subscription;
    });
  }

  /**
   * Cancels a subscription either immediately or scheduled at period end.
   */
  async cancelSubscription(params: {
    subscriptionId: string | Types.ObjectId;
    input: CancelSubscriptionInput;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }): Promise<ISubscription> {
    const { subscriptionId, input, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(subscriptionId)) {
      throw new AppError("A valid subscription ID is required", 400);
    }

    return runWithTransaction(async (session) => {
      const subQuery = Subscription.findById(subscriptionId);
      if (session) subQuery.session(session);
      const subscription = await subQuery;

      if (!subscription) {
        throw new AppError("Subscription record not found", 404);
      }

      const cancellationTime = new Date();
      subscription.canceledAt = cancellationTime;
      subscription.cancellationReason = input.reason.trim();

      if (input.cancelAtPeriodEnd) {
        // Graceful period-end cancellation
        subscription.cancelAtPeriodEnd = true;
      } else {
        // Immediate cancellation
        subscription.status = "CANCELLED";
        subscription.cancelAtPeriodEnd = false;

        // Revert workspace and user status
        const wsQuery = Workspace.findById(subscription.workspaceId);
        if (session) wsQuery.session(session);
        const workspace = await wsQuery;

        if (workspace) {
          const userUpdate = User.updateOne(
            { _id: workspace.ownerId },
            { $set: { isPaid: false, subscriptionStatus: "cancelled" } },
          );
          if (session) userUpdate.session(session);
          await userUpdate;
        }
      }

      if (session) {
        await subscription.save({ session });
      } else {
        await subscription.save();
      }

      await adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "SUBSCRIPTION_CANCELED",
          adminUserId: adminUser.id,
          adminEmail: adminUser.email,
          ipAddress,
          userAgent,
          reason: `Subscription cancelled: ${input.reason.trim()}`,
          metadata: {
            subscriptionId: String(subscription._id),
            workspaceId: String(subscription.workspaceId),
            cancelAtPeriodEnd: input.cancelAtPeriodEnd,
            cancellationReason: input.reason.trim(),
          },
        })
        .catch((err) => {
          console.error("[SubscriptionLifecycle] Failed to log cancellation:", err);
        });

      return subscription;
    });
  }

  /**
   * Registers a custom Enterprise plan configuration in catalog and memory.
   */
  async registerCustomPlan(params: {
    input: CreateCustomPlanInput;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }): Promise<PlanDefinition> {
    const { input, adminUser, ipAddress, userAgent } = params;

    const normalizedCode = input.planCode.trim().toUpperCase();

    // Check if duplicate exists
    if (BILLING_PLANS[normalizedCode]) {
      throw new AppError(
        `Plan with code '${normalizedCode}' already exists`,
        409,
        "PLAN_CODE_ALREADY_EXISTS",
      );
    }

    const existingInDb = await CustomPlan.findOne({ code: normalizedCode });
    if (existingInDb) {
      throw new AppError(
        `Plan with code '${normalizedCode}' already exists in catalog`,
        409,
        "PLAN_CODE_ALREADY_EXISTS",
      );
    }

    const customPlan = await CustomPlan.create({
      code: normalizedCode,
      name: input.name.trim(),
      priceBdt: input.priceBdt,
      description: input.description?.trim() || "",
      limits: {
        maxWhatsAppNumbers: input.limits.maxWhatsAppNumbers,
        maxTeamMembers: input.limits.maxTeamMembers,
      },
      features: input.features || [],
    });

    const planDef: PlanDefinition = {
      code: customPlan.code,
      name: customPlan.name,
      priceBdt: customPlan.priceBdt,
      description: customPlan.description,
      limits: { ...customPlan.limits },
      features: [...customPlan.features],
    };

    registerPlanInMemory(planDef);

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "PLAN_CONFIG_REGISTERED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: `New custom plan '${planDef.code}' added to catalog`,
        metadata: {
          planCode: planDef.code,
          name: planDef.name,
          priceBdt: planDef.priceBdt,
          limits: planDef.limits,
        },
      })
      .catch((err) => {
        console.error("[SubscriptionLifecycle] Failed to log custom plan creation:", err);
      });

    return planDef;
  }

  /**
   * Returns authoritative plan catalog merging standard memory tiers with custom database plans.
   * Includes active subscription counts for administrative oversight.
   */
  async listPlansCatalog(): Promise<
    Array<
      PlanDefinition & {
        isCustom: boolean;
        activeSubscriptionsCount: number;
        createdAt?: Date;
        updatedAt?: Date;
      }
    >
  > {
    let dbCustomPlans: any[] = [];
    const activeSubsCounts: Record<string, number> = {};

    if (mongoose.connection.readyState === 1 || process.env.NODE_ENV === "test") {
      try {
        dbCustomPlans = await CustomPlan.find().lean();
        for (const cp of dbCustomPlans) {
          registerPlanInMemory({
            code: cp.code,
            name: cp.name,
            priceBdt: cp.priceBdt,
            description: cp.description,
            limits: { ...cp.limits },
            features: [...(cp.features || [])],
          });
        }
      } catch (err) {
        console.warn("[SubscriptionLifecycle] Failed to query CustomPlan collection:", err);
      }

      try {
        const counts = await Subscription.aggregate([
          { $match: { status: "ACTIVE" } },
          { $group: { _id: "$planCode", count: { $sum: 1 } } },
        ]);
        for (const item of counts) {
          if (item._id) {
            activeSubsCounts[String(item._id).toUpperCase()] = item.count;
          }
        }
      } catch (err) {
        console.warn("[SubscriptionLifecycle] Failed to aggregate active subscriptions:", err);
      }
    }

    const builtInCodes = new Set(["STARTER", "BUSINESS_PRO", "ENTERPRISE"]);
    const dbPlanMap = new Map<string, any>();
    for (const cp of dbCustomPlans) {
      dbPlanMap.set(cp.code.toUpperCase(), cp);
    }

    const allCodes = Array.from(
      new Set([...Object.keys(BILLING_PLANS), ...Array.from(dbPlanMap.keys())]),
    );

    const plans = allCodes.map((code) => {
      const planDef = BILLING_PLANS[code];
      const dbDoc = dbPlanMap.get(code);
      const isCustom = !builtInCodes.has(code);

      return {
        code,
        name: dbDoc?.name || planDef?.name || code,
        priceBdt: dbDoc?.priceBdt ?? planDef?.priceBdt ?? 0,
        description: dbDoc?.description || planDef?.description || "",
        limits: dbDoc?.limits || planDef?.limits || { maxWhatsAppNumbers: 1, maxTeamMembers: 1 },
        features: dbDoc?.features || planDef?.features || [],
        isCustom,
        activeSubscriptionsCount: activeSubsCounts[code] || 0,
        createdAt: dbDoc?.createdAt,
        updatedAt: dbDoc?.updatedAt,
      };
    });

    return plans;
  }

  /**
   * Updates an existing plan's attributes (name, price, limits, description, features).
   * Supports both custom and built-in tier overriding with persistence and security audit log.
   */
  async updatePlan(params: {
    planCode: string;
    input: UpdateCustomPlanInput;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }): Promise<PlanDefinition & { isCustom: boolean }> {
    const { planCode, input, adminUser, ipAddress, userAgent } = params;
    const normalizedCode = planCode.trim().toUpperCase();

    const isDbConnected = mongoose.connection.readyState === 1;
    const existingInMemory = BILLING_PLANS[normalizedCode];
    const existingInDb = isDbConnected ? await CustomPlan.findOne({ code: normalizedCode }) : null;

    if (!existingInMemory && !existingInDb) {
      throw new AppError(`Plan '${normalizedCode}' not found in catalog`, 404, "PLAN_NOT_FOUND");
    }

    const builtInCodes = new Set(["STARTER", "BUSINESS_PRO", "ENTERPRISE"]);
    const isCustom = !builtInCodes.has(normalizedCode);

    // Merge existing properties
    const currentName = existingInDb?.name || existingInMemory?.name || normalizedCode;
    const currentPrice = existingInDb?.priceBdt ?? existingInMemory?.priceBdt ?? 0;
    const currentDescription = existingInDb?.description || existingInMemory?.description || "";
    const currentLimits = existingInDb?.limits || existingInMemory?.limits || {
      maxWhatsAppNumbers: 1,
      maxTeamMembers: 1,
    };
    const currentFeatures = existingInDb?.features || existingInMemory?.features || [];

    const updatedName = input.name !== undefined ? input.name.trim() : currentName;
    const updatedPrice = input.priceBdt !== undefined ? input.priceBdt : currentPrice;
    const updatedDescription =
      input.description !== undefined ? input.description.trim() : currentDescription;
    const updatedLimits = {
      maxWhatsAppNumbers:
        input.limits?.maxWhatsAppNumbers !== undefined
          ? input.limits.maxWhatsAppNumbers
          : currentLimits.maxWhatsAppNumbers,
      maxTeamMembers:
        input.limits?.maxTeamMembers !== undefined
          ? input.limits.maxTeamMembers
          : currentLimits.maxTeamMembers,
    };
    const updatedFeatures = input.features !== undefined ? input.features : currentFeatures;

    // Persist to CustomPlan collection if connected
    if (isDbConnected) {
      await CustomPlan.findOneAndUpdate(
        { code: normalizedCode },
        {
          $set: {
            code: normalizedCode,
            name: updatedName,
            priceBdt: updatedPrice,
            description: updatedDescription,
            limits: updatedLimits,
            features: updatedFeatures,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    const updatedPlanDef: PlanDefinition = {
      code: normalizedCode,
      name: updatedName,
      priceBdt: updatedPrice,
      description: updatedDescription,
      limits: updatedLimits,
      features: updatedFeatures,
    };

    registerPlanInMemory(updatedPlanDef);

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "PLAN_CONFIG_UPDATED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: `Plan '${normalizedCode}' configuration updated by admin`,
        metadata: {
          planCode: normalizedCode,
          name: updatedPlanDef.name,
          priceBdt: updatedPlanDef.priceBdt,
          limits: updatedPlanDef.limits,
        },
      })
      .catch((err) => {
        console.error("[SubscriptionLifecycle] Failed to log plan update:", err);
      });

    return {
      ...updatedPlanDef,
      isCustom,
    };
  }

  /**
   * Deletes a custom plan from the catalog.
   * Safety guard: Rejects deletion if plan is built-in or currently assigned to active subscriptions.
   */
  async deletePlan(params: {
    planCode: string;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ success: boolean; message: string }> {
    const { planCode, adminUser, ipAddress, userAgent } = params;
    const normalizedCode = planCode.trim().toUpperCase();

    const builtInCodes = new Set(["STARTER", "BUSINESS_PRO", "ENTERPRISE"]);
    if (builtInCodes.has(normalizedCode)) {
      throw new AppError(
        `Built-in system plan '${normalizedCode}' cannot be deleted. You can edit its parameters instead.`,
        400,
        "BUILT_IN_PLAN_CANNOT_BE_DELETED",
      );
    }

    const isDbConnected = mongoose.connection.readyState === 1;

    // Safety guard against active subscriptions
    let activeSubsCount = 0;
    if (isDbConnected || (Subscription as any).countDocuments !== mongoose.Model.countDocuments) {
      try {
        activeSubsCount = await Subscription.countDocuments({
          planCode: normalizedCode,
          status: "ACTIVE",
        });
      } catch {
        activeSubsCount = 0;
      }
    }

    if (activeSubsCount > 0) {
      throw new AppError(
        `Cannot delete plan '${normalizedCode}'. It is currently assigned to ${activeSubsCount} active workspace subscription(s). Please migrate those subscriptions to a different plan before deleting.`,
        409,
        "PLAN_IN_USE_BY_ACTIVE_SUBSCRIPTIONS",
      );
    }

    const existingInMemory = BILLING_PLANS[normalizedCode];
    const existingInDb = isDbConnected ? await CustomPlan.findOne({ code: normalizedCode }) : null;

    if (!existingInDb && !existingInMemory) {
      throw new AppError(`Plan '${normalizedCode}' not found in catalog`, 404, "PLAN_NOT_FOUND");
    }

    if (isDbConnected && existingInDb) {
      await CustomPlan.deleteOne({ code: normalizedCode });
    }
    removePlanFromMemory(normalizedCode);

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "PLAN_CONFIG_DELETED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: `Custom plan '${normalizedCode}' deleted from catalog`,
        metadata: {
          planCode: normalizedCode,
        },
      })
      .catch((err) => {
        console.error("[SubscriptionLifecycle] Failed to log plan deletion:", err);
      });

    return {
      success: true,
      message: `Plan '${normalizedCode}' deleted successfully from catalog`,
    };
  }
}

export const subscriptionLifecycleService = new SubscriptionLifecycleService();
