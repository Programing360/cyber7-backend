import { Router } from "express";
import { platformAdminDashboardController } from "./dashboard.controller.js";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";
import {
  approveBankTransferAdminController,
  refundPaymentAdminController,
  rejectBankTransferAdminController,
} from "../billing/billing.controller.js";
import { platformAdminGovernanceController } from "./governance.controller.js";
import { subscriptionLifecycleController } from "../billing/subscription-lifecycle.controller.js";
import { documentController } from "../billing/document.controller.js";
import { supportTicketRouter } from "../support/support-ticket.routes.js";
import { platformSettingsRouter } from "../settings/platform-settings.routes.js";
import { probePaymentGatewaysHealth } from "../billing/gateway-probe.service.js";
import { adminAuthController } from "../admin-auth/admin-auth.controller.js";

const router = Router();

// Base security gate: Signed BFF assertion + Active dedicated AdminSession
router.use(requireBffAssertion);
router.use(authenticateAdminSession);

// Overview Metrics (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/overview",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.getOverview(req, res, next),
);

// Revenue & Billing Metrics (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/revenue",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.getRevenue(req, res, next),
);

// Platform Analytics & Aggregations (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/analytics",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.getAnalytics(req, res, next),
);

// Platform Analytics CSV Export (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/analytics/export",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) =>
    platformAdminDashboardController.exportAnalyticsCsv(req, res, next),
);

// Workspaces list (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/workspaces",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listWorkspaces(req, res, next),
);

// Subscriptions list (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/subscriptions",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listSubscriptions(req, res, next),
);

// Payments list (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/payments",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listPayments(req, res, next),
);
router.get(
  "/billing/payments",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listPayments(req, res, next),
);

// Invoices list (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/invoices",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listInvoices(req, res, next),
);

// Financial Mutations (SUPER_ADMIN and FINANCE_ADMIN)
router.post(
  "/billing/bank-transfers/:paymentId/approve",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  approveBankTransferAdminController,
);
router.post(
  "/bank-transfers/:paymentId/approve",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  approveBankTransferAdminController,
);
router.post(
  "/billing/bank-transfers/:paymentId/reject",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  rejectBankTransferAdminController,
);
router.post(
  "/bank-transfers/:paymentId/reject",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  rejectBankTransferAdminController,
);
router.post(
  "/billing/payments/:paymentId/refund",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  refundPaymentAdminController,
);
router.post(
  "/payments/:paymentId/refund",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  refundPaymentAdminController,
);

// Platform Users (SUPER_ADMIN ONLY)
router.get(
  "/users",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listUsers(req, res, next),
);

// Security Audit Logs (SUPER_ADMIN ONLY)
router.get(
  "/audit-logs",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listAuditLogs(req, res, next),
);

// Tenant & User Governance Mutations
router.patch(
  "/workspaces/:workspaceId/status",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.updateWorkspaceStatus(req, res, next),
);

router.patch(
  "/users/:userId/role",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.updateUserRole(req, res, next),
);

router.post(
  "/users/:userId/revoke-sessions",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.revokeUserSessions(req, res, next),
);

router.patch(
  "/users/:userId/status",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.updateUserStatus(req, res, next),
);

router.delete(
  "/users/:userId",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformAdminGovernanceController.deleteAbandonedUser(req, res, next),
);

// Quota Overrides & Subscription Lifecycle
router.patch(
  "/workspaces/:workspaceId/quotas",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.updateWorkspaceQuotas(req, res, next),
);

router.patch(
  "/subscriptions/:subscriptionId/plan",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.modifySubscriptionPlan(req, res, next),
);

router.post(
  "/subscriptions/:subscriptionId/cancel",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.cancelSubscription(req, res, next),
);

router.get(
  "/billing/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.listPlansCatalog(req, res, next),
);
router.get(
  "/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.listPlansCatalog(req, res, next),
);

router.post(
  "/billing/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.registerCustomPlan(req, res, next),
);
router.post(
  "/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.registerCustomPlan(req, res, next),
);

router.patch(
  "/billing/plans/:planCode",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.updatePlan(req, res, next),
);
router.patch(
  "/plans/:planCode",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.updatePlan(req, res, next),
);

router.delete(
  "/billing/plans/:planCode",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.deletePlan(req, res, next),
);
router.delete(
  "/plans/:planCode",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.deletePlan(req, res, next),
);

// Stream Invoice PDF (and billing alias)
router.get(
  "/invoices/:invoiceId/pdf",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.streamInvoicePdf(req, res, next),
);
router.get(
  "/billing/invoices/:invoiceId/pdf",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.streamInvoicePdf(req, res, next),
);

// Stream Payment Receipt PDF (and billing alias)
router.get(
  "/payments/:paymentId/receipt",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.streamPaymentReceiptPdf(req, res, next),
);
router.get(
  "/billing/payments/:paymentId/receipt",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.streamPaymentReceiptPdf(req, res, next),
);

// Resend Invoice Email (and billing alias)
router.post(
  "/invoices/:invoiceId/resend",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.resendInvoiceEmail(req, res, next),
);
router.post(
  "/billing/invoices/:invoiceId/resend",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.resendInvoiceEmail(req, res, next),
);

// Payment Gateway Automated Health Probe
router.get(
  "/billing/gateways/health",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  async (_req, res, next) => {
    try {
      const report = await probePaymentGatewaysHealth();
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  },
);
router.get(
  "/gateways/health",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  async (_req, res, next) => {
    try {
      const report = await probePaymentGatewaysHealth();
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  },
);

// Session Purge Aliases
router.post(
  "/auth/sessions/purge",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => (adminAuthController.purgeSessions as any)(req, res, next),
);
router.post(
  "/sessions/purge",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => (adminAuthController.purgeSessions as any)(req, res, next),
);

// Sub-module Routers
router.use("/support", supportTicketRouter);
router.use("/settings", platformSettingsRouter);

export default router;
