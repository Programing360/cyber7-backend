import { Router } from "express";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";
import { platformAdminGovernanceController } from "./governance.controller.js";
import { subscriptionLifecycleController } from "../billing/subscription-lifecycle.controller.js";

export const platformAdminGovernanceRouter = Router();

// Base security pipeline for all administrative governance mutations
platformAdminGovernanceRouter.use(requireBffAssertion);
platformAdminGovernanceRouter.use(authenticateAdminSession);

// 1. Workspace Status Mutation (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminGovernanceRouter.patch(
  "/workspaces/:workspaceId/status",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.updateWorkspaceStatus(req, res, next),
);

// Workspace Custom Quotas Override (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminGovernanceRouter.patch(
  "/workspaces/:workspaceId/quotas",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.updateWorkspaceQuotas(req, res, next),
);

// Subscription Plan Override (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminGovernanceRouter.patch(
  "/subscriptions/:subscriptionId/plan",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.modifySubscriptionPlan(req, res, next),
);

// Subscription Cancellation Engine (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminGovernanceRouter.post(
  "/subscriptions/:subscriptionId/cancel",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.cancelSubscription(req, res, next),
);

// Custom Enterprise Plan Catalog Registration (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminGovernanceRouter.post(
  "/billing/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.registerCustomPlan(req, res, next),
);

// 2. User Platform Role Management (SUPER_ADMIN ONLY)
platformAdminGovernanceRouter.patch(
  "/users/:userId/role",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.updateUserRole(req, res, next),
);

// 3. Instant Session Revocation (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminGovernanceRouter.post(
  "/users/:userId/revoke-sessions",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.revokeUserSessions(req, res, next),
);

// 4. Account Status Toggle (SUPER_ADMIN ONLY)
platformAdminGovernanceRouter.patch(
  "/users/:userId/status",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.updateUserStatus(req, res, next),
);

// 5. Safe Abandoned User Cleanup Guard (SUPER_ADMIN ONLY)
platformAdminGovernanceRouter.delete(
  "/users/:userId",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.deleteAbandonedUser(req, res, next),
);

export default platformAdminGovernanceRouter;
