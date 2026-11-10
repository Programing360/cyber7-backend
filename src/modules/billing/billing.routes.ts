import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireRole } from "../../middlewares/require-role.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";
import {
  approveBankTransferAdminController,
  getBillingOverviewController,
  getInvoiceController,
  getMyServicesController,
  initiatePaymentController,
  listInvoicesController,
  listPendingTransfersAdminController,
  listPlansController,
  refundPaymentAdminController,
  rejectBankTransferAdminController,
  submitBankTransferController,
} from "./billing.controller.js";
import { subscriptionLifecycleController } from "./subscription-lifecycle.controller.js";
import { documentController } from "./document.controller.js";
import { probePaymentGatewaysHealth } from "./gateway-probe.service.js";
import { initiateZinipayPaymentController } from "./gateways/zinipay.controller.js";

/**
 * Workspace Billing Router
 * Mounted at `/api/workspaces/:workspaceId/billing` or `/api/billing/:workspaceId`
 * Strict role protection: Only OWNER and ADMIN are allowed; AGENT is rejected with 403.
 */
export const workspaceBillingRouter = Router({ mergeParams: true });

workspaceBillingRouter.use(authenticate);
workspaceBillingRouter.use(requireWorkspaceMembership);

// My Services: Accessible to workspace members (OWNER, ADMIN, AGENT)
workspaceBillingRouter.get(
  "/my-services",
  requireRole("OWNER", "ADMIN", "AGENT"),
  getMyServicesController,
);

// All other billing and financial mutation routes strictly require OWNER or ADMIN
workspaceBillingRouter.use(requireRole("OWNER", "ADMIN"));

workspaceBillingRouter.get("/overview", getBillingOverviewController);
workspaceBillingRouter.get("/plans", listPlansController);
workspaceBillingRouter.post("/payments/initiate", initiatePaymentController);
workspaceBillingRouter.post("/pay/zinipay", initiateZinipayPaymentController);
workspaceBillingRouter.post(
  "/payments/:paymentId/bank-transfer",
  submitBankTransferController,
);
workspaceBillingRouter.get("/invoices", listInvoicesController);
workspaceBillingRouter.get("/invoices/:invoiceId", getInvoiceController);

/**
 * Platform Admin Billing Router
 * Mounted at `/api/platform-admin/billing` and `/api/admin/billing`
 *
 * Security Architecture (Step 2 Un-quarantine):
 * 1. Strictly isolates against customer Bearer JWT tokens.
 * 2. Enforces signed BFF assertion (`requireBffAssertion`).
 * 3. Enforces platform admin session authentication (`authenticateAdminSession`).
 * 4. Enforces role-based platform access control (`requireAdminPlatformRole`).
 */
export const platformAdminBillingRouter = Router();

platformAdminBillingRouter.use(requireBffAssertion);
platformAdminBillingRouter.use(authenticateAdminSession);

// Pending transfers list (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.get(
  "/bank-transfers/pending",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  listPendingTransfersAdminController,
);

// Approve City Bank transfer (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.post(
  "/bank-transfers/:paymentId/approve",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  approveBankTransferAdminController,
);

// Reject City Bank transfer (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.post(
  "/bank-transfers/:paymentId/reject",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  rejectBankTransferAdminController,
);

// Refund completed payment (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.post(
  "/payments/:paymentId/refund",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  refundPaymentAdminController,
);

// Plan Catalog Management (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.get(
  "/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.listPlansCatalog(req, res, next),
);

platformAdminBillingRouter.post(
  "/plans",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.registerCustomPlan(req, res, next),
);

platformAdminBillingRouter.patch(
  "/plans/:planCode",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.updatePlan(req, res, next),
);

platformAdminBillingRouter.delete(
  "/plans/:planCode",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.deletePlan(req, res, next),
);

// Subscription Plan Override (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.patch(
  "/subscriptions/:subscriptionId/plan",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.modifySubscriptionPlan(req, res, next),
);

// Subscription Cancellation Engine (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.post(
  "/subscriptions/:subscriptionId/cancel",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => subscriptionLifecycleController.cancelSubscription(req, res, next),
);

// Stream Invoice PDF (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.get(
  "/invoices/:invoiceId/pdf",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.streamInvoicePdf(req, res, next),
);

// Stream Payment Receipt PDF (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.get(
  "/payments/:paymentId/receipt",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.streamPaymentReceiptPdf(req, res, next),
);

// Resend Invoice Email (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.post(
  "/invoices/:invoiceId/resend",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => documentController.resendInvoiceEmail(req, res, next),
);

// Payment Gateway Automated Health Probe (SUPER_ADMIN and FINANCE_ADMIN)
platformAdminBillingRouter.get(
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

export default workspaceBillingRouter;

