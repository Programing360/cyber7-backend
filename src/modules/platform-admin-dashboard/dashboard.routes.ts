import { Router } from "express";
import { platformAdminDashboardController } from "./dashboard.controller.js";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";

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

// Invoices list (SUPER_ADMIN and FINANCE_ADMIN)
router.get(
  "/invoices",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformAdminDashboardController.listInvoices(req, res, next),
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

export default router;
