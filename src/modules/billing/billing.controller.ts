import type { Response, NextFunction } from "express";
import mongoose from "mongoose";
import type { AuthenticatedRequest } from "../../middlewares/authenticate.js";
import type { AdminAuthenticatedRequest } from "../../middlewares/authenticate-admin-session.js";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import { AppError } from "../../utils/app-error.js";
import { getRouteParam } from "../../utils/get-route-param.js";
import { BILLING_PLANS } from "./billing.config.js";
import { billingService } from "./billing.service.js";
import {
  adminApproveTransferSchema,
  adminRefundPaymentSchema,
  adminRejectTransferSchema,
  initiatePaymentSchema,
  listInvoicesQuerySchema,
  submitBankTransferSchema,
} from "./billing.validation.js";
import { invoiceService } from "./invoice.service.js";
import { subscriptionLifecycleService } from "./subscription-lifecycle.service.js";

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
 * GET /api/workspaces/:workspaceId/billing/my-services
 * Returns the active subscription, user profile info, and unlocked features.
 */
export const getMyServicesController = async (
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;
    const userRole = (req as any).membership?.role || req.user?.role || "USER";

    const myServices = await billingService.getMyServices(
      workspaceId,
      userId,
      userRole,
    );

    res.status(200).json({
      success: true,
      message: "My services retrieved successfully",
      data: myServices,
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
    const plans = await subscriptionLifecycleService.listPlansCatalog();
    res.status(200).json({
      success: true,
      data: {
        plans,
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
 * POST /api/platform-admin/billing/bank-transfers/:paymentId/approve
 * POST /api/admin/billing/bank-transfers/:paymentId/approve
 */
export const approveBankTransferAdminController = async (
  req: AdminAuthenticatedRequest,
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

    const adminUser = req.admin?.user || (req as any).user;
    if (!adminUser) {
      throw new AppError("Platform administrator authentication required", 401);
    }

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const adminNotes = validation.data.notes || validation.data.adminNotes;
    const stepUpToken = validation.data.stepUpToken;

    const result = await billingService.approveBankTransfer({
      paymentId,
      adminUser: {
        id: adminUser.id,
        email: adminUser.email,
      },
      adminNotes,
      stepUpToken,
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
 * POST /api/platform-admin/billing/bank-transfers/:paymentId/reject
 * POST /api/admin/billing/bank-transfers/:paymentId/reject
 */
export const rejectBankTransferAdminController = async (
  req: AdminAuthenticatedRequest,
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

    const adminUser = req.admin?.user || (req as any).user;
    if (!adminUser) {
      throw new AppError("Platform administrator authentication required", 401);
    }

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const reason = validation.data.reason || validation.data.rejectionReason!;

    const payment = await billingService.rejectBankTransfer({
      paymentId,
      adminUser: {
        id: adminUser.id,
        email: adminUser.email,
      },
      rejectionReason: reason,
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

/**
 * POST /api/platform-admin/billing/payments/:paymentId/refund
 * POST /api/admin/billing/payments/:paymentId/refund
 */
export const refundPaymentAdminController = async (
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const paymentId = getRouteParam(req, "paymentId");
    if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new AppError("A valid payment ID is required", 400);
    }

    const validation = adminRefundPaymentSchema.safeParse(req.body);
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

    const adminUser = req.admin?.user || (req as any).user;
    if (!adminUser) {
      throw new AppError("Platform administrator authentication required", 401);
    }

    const ipAddress =
      req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    const result = await billingService.refundPayment({
      paymentId,
      adminUser: {
        id: adminUser.id,
        email: adminUser.email,
      },
      reason: validation.data.reason,
      refundAmount: validation.data.refundAmount,
      ipAddress,
      userAgent,
    });

    res.status(200).json({
      success: true,
      message: "Payment refunded successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
