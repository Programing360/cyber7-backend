import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePlatformAdmin } from "../../middlewares/require-platform-admin.js";
import { requireRole } from "../../middlewares/require-role.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import {
  approveBankTransferAdminController,
  getBillingOverviewController,
  getInvoiceController,
  initiatePaymentController,
  listInvoicesController,
  listPendingTransfersAdminController,
  listPlansController,
  rejectBankTransferAdminController,
  submitBankTransferController,
} from "./billing.controller.js";

/**
 * Workspace Billing Router
 * Mounted at `/api/workspaces/:workspaceId/billing` or `/api/billing/:workspaceId`
 * Strict role protection: Only OWNER and ADMIN are allowed; AGENT is rejected with 403.
 */
export const workspaceBillingRouter = Router({ mergeParams: true });

workspaceBillingRouter.use(authenticate);
workspaceBillingRouter.use(requireWorkspaceMembership);
workspaceBillingRouter.use(requireRole("OWNER", "ADMIN"));

workspaceBillingRouter.get("/overview", getBillingOverviewController);
workspaceBillingRouter.get("/plans", listPlansController);
workspaceBillingRouter.post("/payments/initiate", initiatePaymentController);
workspaceBillingRouter.post(
  "/payments/:paymentId/bank-transfer",
  submitBankTransferController,
);
workspaceBillingRouter.get("/invoices", listInvoicesController);
workspaceBillingRouter.get("/invoices/:invoiceId", getInvoiceController);

/**
 * Quarantine Handler for Legacy Financial Mutations.
 * R-09: No administrative financial mutation endpoint is authorized for production use
 * until dedicated Platform Admin mutation security architecture (BFF HMAC + AdminSession + TOTP Step-up)
 * is separately designed and approved.
 */
export const quarantineFinancialMutation = (
  req: any,
  res: any,
): void => {
  res.status(403).json({
    success: false,
    error: "FINANCIAL_MUTATION_QUARANTINED",
    message:
      "Legacy administrative financial mutations are quarantined pending approved Platform Admin mutation security architecture.",
  });
};

/**
 * Platform Admin Billing Router
 * Mounted at `/api/admin/billing`
 * R-09 Containment:
 * 1. Strictly rejects customer Bearer JWT tokens.
 * 2. Quarantines all administrative financial mutation endpoints with fail-closed HTTP 403.
 */
export const platformAdminBillingRouter = Router();

// R-09: Do not accept customer JWT as authorization for platform-level financial administration
platformAdminBillingRouter.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: "CUSTOMER_TOKEN_FORBIDDEN",
      message:
        "Platform admin endpoints reject customer Bearer tokens. AdminSession cookie required.",
    });
    return;
  }
  next();
});

// Quarantine all mutation HTTP methods (POST, PUT, PATCH, DELETE)
platformAdminBillingRouter.post(
  "/bank-transfers/:paymentId/approve",
  quarantineFinancialMutation,
);
platformAdminBillingRouter.post(
  "/bank-transfers/:paymentId/reject",
  quarantineFinancialMutation,
);

// Fallback quarantine for any unexpected administrative financial mutation attempt
platformAdminBillingRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    return quarantineFinancialMutation(req, res);
  }
  next();
});

platformAdminBillingRouter.get(
  "/bank-transfers/pending",
  listPendingTransfersAdminController,
);

export default workspaceBillingRouter;

