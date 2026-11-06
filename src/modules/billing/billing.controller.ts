import type { Response, NextFunction } from "express";
import mongoose from "mongoose";
import type { AuthenticatedRequest } from "../../middlewares/authenticate.js";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import { AppError } from "../../utils/app-error.js";
import { getRouteParam } from "../../utils/get-route-param.js";
import { BILLING_PLANS } from "./billing.config.js";
import { billingService } from "./billing.service.js";
import {
  adminApproveTransferSchema,
  adminRejectTransferSchema,
  initiatePaymentSchema,
  listInvoicesQuerySchema,
  submitBankTransferSchema,
} from "./billing.validation.js";
import { invoiceService } from "./invoice.service.js";

/**
 * GET /api/workspaces/:workspaceId/billing/overview
 */
export const getBillingOverviewController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace!.id;
    const overview = await billingService.getBillingOverview(workspaceId);

    res.status(200).json({
      success: true,
      message: "Billing overview retrieved successfully",
      data: overview,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/workspaces/:workspaceId/billing/plans
 */
export const listPlansController = async (
  _req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.status(200).json({
      success: true,
      data: {
        plans: Object.values(BILLING_PLANS),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/workspaces/:workspaceId/billing/payments/initiate
 */
export const initiatePaymentController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;

    const validation = initiatePaymentSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const { planCode, paymentMethod, idempotencyKey } = validation.data;

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const result = await billingService.initiatePayment({
      workspaceId,
      initiatedBy: userId,
      planCode,
      paymentMethod,
      idempotencyKey,
      ipAddress,
      userAgent,
    });

    res.status(201).json({
      success: true,
      message: "Payment initiated successfully",
      data: {
        payment: result.payment,
        plan: result.plan,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/workspaces/:workspaceId/billing/payments/:paymentId/bank-transfer
 */
export const submitBankTransferController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;
    const paymentId = getRouteParam(req, "paymentId");

    if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new AppError("A valid payment ID is required", 400);
    }

    const validation = submitBankTransferSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const payment = await billingService.submitBankTransferDetails({
      workspaceId,
      paymentId,
      userId,
      transferDetails: {
        ...validation.data,
        depositDate: validation.data.depositDate
          ? new Date(validation.data.depositDate)
          : undefined,
      },
      ipAddress,
      userAgent,
    });

    res.status(200).json({
      success: true,
      message: "Bank transfer reference submitted for administrative review",
      data: { payment },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/workspaces/:workspaceId/billing/invoices
 */
export const listInvoicesController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace!.id;

    const validation = listInvoicesQuerySchema.safeParse(req.query);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Invalid query parameters",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const { page, limit } = validation.data;
    const result = await invoiceService.getWorkspaceInvoices(workspaceId, {
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      message: "Invoices retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/workspaces/:workspaceId/billing/invoices/:invoiceId
 */
export const getInvoiceController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace!.id;
    const invoiceId = getRouteParam(req, "invoiceId");

    if (!invoiceId || !mongoose.Types.ObjectId.isValid(invoiceId)) {
      throw new AppError("A valid invoice ID is required", 400);
    }

    const invoice = await invoiceService.getWorkspaceInvoiceById(
      workspaceId,
      invoiceId,
    );

    res.status(200).json({
      success: true,
      message: "Invoice retrieved successfully",
      data: { invoice },
    });
  } catch (error) {
    next(error);
  }
};

/* ==========================================================================
   PLATFORM ADMIN CONTROLLERS
   ========================================================================== */

/**
 * GET /api/admin/billing/bank-transfers/pending
 */
export const listPendingTransfersAdminController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const validation = listInvoicesQuerySchema.safeParse(req.query);
    const { page, limit } = validation.success
      ? validation.data
      : { page: 1, limit: 20 };

    const result = await billingService.listPendingBankTransfers({
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      message: "Pending bank transfers retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/billing/bank-transfers/:paymentId/approve
 */
export const approveBankTransferAdminController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const paymentId = getRouteParam(req, "paymentId");
    if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new AppError("A valid payment ID is required", 400);
    }

    const validation = adminApproveTransferSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const result = await billingService.approveBankTransfer({
      paymentId,
      adminUser: {
        id: req.user!.id,
        email: req.user!.email,
      },
      adminNotes: validation.data.notes,
      ipAddress,
      userAgent,
    });

    res.status(200).json({
      success: true,
      message: "Bank transfer approved and subscription activated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/billing/bank-transfers/:paymentId/reject
 */
export const rejectBankTransferAdminController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const paymentId = getRouteParam(req, "paymentId");
    if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new AppError("A valid payment ID is required", 400);
    }

    const validation = adminRejectTransferSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const payment = await billingService.rejectBankTransfer({
      paymentId,
      adminUser: {
        id: req.user!.id,
        email: req.user!.email,
      },
      rejectionReason: validation.data.reason,
      ipAddress,
      userAgent,
    });

    res.status(200).json({
      success: true,
      message: "Bank transfer rejected successfully",
      data: { payment },
    });
  } catch (error) {
    next(error);
  }
};
