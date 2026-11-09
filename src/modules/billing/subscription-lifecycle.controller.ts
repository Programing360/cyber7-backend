import type { Response, NextFunction } from "express";
import type { AdminAuthenticatedRequest } from "../../middlewares/authenticate-admin-session.js";
import { getRouteParam } from "../../utils/get-route-param.js";
import { AppError } from "../../utils/app-error.js";
import { subscriptionLifecycleService } from "./subscription-lifecycle.service.js";
import {
  updateWorkspaceQuotasSchema,
  modifySubscriptionPlanSchema,
  cancelSubscriptionSchema,
  createCustomPlanSchema,
  updateCustomPlanSchema,
} from "./subscription-lifecycle.validation.js";

export class SubscriptionLifecycleController {
  /**
   * PATCH /api/platform-admin/workspaces/:workspaceId/quotas
   * PATCH /api/admin/workspaces/:workspaceId/quotas
   */
  async updateWorkspaceQuotas(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = getRouteParam(req, "workspaceId");
      if (!workspaceId) {
        throw new AppError("A valid workspace ID is required", 400);
      }

      const validation = updateWorkspaceQuotasSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await subscriptionLifecycleService.updateWorkspaceQuotas({
        workspaceId,
        quotas: validation.data,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: "Workspace quota limits updated successfully",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/platform-admin/subscriptions/:subscriptionId/plan
   * PATCH /api/admin/subscriptions/:subscriptionId/plan
   */
  async modifySubscriptionPlan(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const subscriptionId = getRouteParam(req, "subscriptionId");
      if (!subscriptionId) {
        throw new AppError("A valid subscription ID is required", 400);
      }

      const validation = modifySubscriptionPlanSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const subscription = await subscriptionLifecycleService.modifySubscriptionPlan({
        subscriptionId,
        input: validation.data,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: `Subscription plan successfully ${validation.data.immediate ? "overridden" : "scheduled"}`,
        data: { subscription },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/platform-admin/subscriptions/:subscriptionId/cancel
   * POST /api/admin/subscriptions/:subscriptionId/cancel
   */
  async cancelSubscription(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const subscriptionId = getRouteParam(req, "subscriptionId");
      if (!subscriptionId) {
        throw new AppError("A valid subscription ID is required", 400);
      }

      const validation = cancelSubscriptionSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const subscription = await subscriptionLifecycleService.cancelSubscription({
        subscriptionId,
        input: validation.data,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: validation.data.cancelAtPeriodEnd
          ? "Subscription scheduled for cancellation at current period end"
          : "Subscription cancelled immediately",
        data: { subscription },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/platform-admin/billing/plans
   * POST /api/admin/billing/plans
   */
  async registerCustomPlan(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validation = createCustomPlanSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const plan = await subscriptionLifecycleService.registerCustomPlan({
        input: validation.data,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(201).json({
        success: true,
        message: `Custom plan '${plan.code}' created and registered in catalog`,
        data: { plan },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/platform-admin/billing/plans
   * GET /api/admin/billing/plans
   * GET /api/platform-admin/dashboard/billing/plans
   */
  async listPlansCatalog(
    _req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const plans = await subscriptionLifecycleService.listPlansCatalog();
      res.status(200).json({
        success: true,
        data: { plans },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/platform-admin/billing/plans/:planCode
   * PATCH /api/admin/billing/plans/:planCode
   * PATCH /api/platform-admin/dashboard/billing/plans/:planCode
   */
  async updatePlan(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const planCode = getRouteParam(req, "planCode");
      if (!planCode) {
        throw new AppError("A valid plan code is required", 400);
      }

      const validation = updateCustomPlanSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const updatedPlan = await subscriptionLifecycleService.updatePlan({
        planCode,
        input: validation.data,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: `Plan '${updatedPlan.code}' updated successfully`,
        data: { plan: updatedPlan },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/platform-admin/billing/plans/:planCode
   * DELETE /api/admin/billing/plans/:planCode
   * DELETE /api/platform-admin/dashboard/billing/plans/:planCode
   */
  async deletePlan(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const planCode = getRouteParam(req, "planCode");
      if (!planCode) {
        throw new AppError("A valid plan code is required", 400);
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await subscriptionLifecycleService.deletePlan({
        planCode,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

export const subscriptionLifecycleController = new SubscriptionLifecycleController();
