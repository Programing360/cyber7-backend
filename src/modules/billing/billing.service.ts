import crypto from "node:crypto";
import mongoose, { type ClientSession, type Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import User from "../auth/user.model.js";
import Workspace from "../workspace/workspace.model.js";
import {
  BILLING_PLANS,
  CURRENCY,
  type PaymentMethod,
  type PlanCode,
} from "./billing.config.js";
import { invoiceService } from "./invoice.service.js";
import Invoice from "./invoice.model.js";
import Payment, {
  type IBankTransferDetails,
  type IPayment,
} from "./payment.model.js";
import PaymentAuditLog, {
  type AuditActorType,
} from "./payment-audit-log.model.js";
import Subscription, { type ISubscription } from "./subscription.model.js";
import { subscriptionService } from "./subscription.service.js";
import { verifyStepUpToken } from "../../utils/jwt.js";

import { runWithTransaction } from "./billing-transaction.util.js";
export { runWithTransaction };

export interface InitiatePaymentParams {
  workspaceId: string | Types.ObjectId;
  initiatedBy: string | Types.ObjectId;
  planCode: PlanCode;
  paymentMethod: PaymentMethod;
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface SubmitBankTransferParams {
  workspaceId: string | Types.ObjectId;
  paymentId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  transferDetails: {
    bankName?: string;
    accountName?: string;
    accountNumber?: string;
    branchName?: string;
    depositDate?: Date;
    referenceNumber: string;
    receiptUrl?: string;
    depositAmount: number;
  };
  ipAddress?: string;
  userAgent?: string;
}

export interface CompletePaymentParams {
  paymentId: string | Types.ObjectId;
  completionData?: {
    trxID?: string;
    paymentID?: string;
    cblOrderId?: string;
    cblTransactionId?: string;
    rawGatewayResponse?: Record<string, any>;
  };
  actor: {
    actorType: AuditActorType;
    actorId?: Types.ObjectId | string;
    actorEmail?: string;
  };
  notes?: string;
  ipAddress?: string;
  userAgent?: string;
}

export class BillingService {
  /**
   * Initiates a payment.
   * - Enforces workspace-scoped idempotency lookup.
   * - Never returns another workspace's payment.
   * - Pulls authoritative price from BILLING_PLANS.
   */
  async initiatePayment(params: InitiatePaymentParams): Promise<{
    payment: IPayment;
    plan: (typeof BILLING_PLANS)[PlanCode];
  }> {
    const {
      workspaceId,
      initiatedBy,
      planCode,
      paymentMethod,
      ipAddress,
      userAgent,
    } = params;

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      throw new AppError("Workspace not found", 404);
    }

    const planDef = BILLING_PLANS[planCode];
    if (!planDef) {
      throw new AppError(`Invalid plan code: ${planCode}`, 400);
    }

    const idempotencyKey =
      params.idempotencyKey?.trim() ||
      `IDEMP-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;

    // Fix 1: Strictly workspace-scoped idempotency check
    const existingPayment = await Payment.findOne({
      workspaceId,
      idempotencyKey,
    });

    if (existingPayment) {
      return { payment: existingPayment, plan: planDef };
    }

    const invoiceNumber = invoiceService.generateInvoiceNumber();

    try {
      const payment = await Payment.create({
        workspaceId,
        initiatedBy,
        paymentMethod,
        planCode,
        planName: planDef.name,
        amount: planDef.priceBdt,
        currency: CURRENCY,
        status: "INITIATED",
        idempotencyKey,
        invoiceNumber,
      });

      await PaymentAuditLog.create({
        paymentId: payment._id,
        workspaceId,
        action: "PAYMENT_INITIATED",
        actorType: "USER",
        actorId: initiatedBy,
        ipAddress,
        userAgent,
        metadata: {
          planCode,
          amount: planDef.priceBdt,
          paymentMethod,
          invoiceNumber,
          idempotencyKey,
        },
      });

      return { payment, plan: planDef };
    } catch (error: any) {
      // Safe handling of concurrent identical submissions for the same workspace
      if (
        error?.code === 11000 &&
        (error?.keyPattern?.idempotencyKey ||
          JSON.stringify(error).includes("idempotencyKey"))
      ) {
        const raceWinner = await Payment.findOne({
          workspaceId,
          idempotencyKey,
        });
        if (raceWinner) {
          return { payment: raceWinner, plan: planDef };
        }
      }
      throw error;
    }
  }

  /**
   * Submits user-provided bank transfer reference and deposit slip details.
   * Moves payment status to PENDING_VERIFICATION.
   */
  async submitBankTransferDetails(
    params: SubmitBankTransferParams,
  ): Promise<IPayment> {
    const {
      workspaceId,
      paymentId,
      userId,
      transferDetails,
      ipAddress,
      userAgent,
    } = params;

    const payment = await Payment.findOne({
      _id: paymentId,
      workspaceId,
      paymentMethod: "CITY_BANK_TRANSFER",
    });

    if (!payment) {
      throw new AppError("Bank transfer payment not found", 404);
    }

    if (payment.status !== "INITIATED") {
      throw new AppError(
        `Cannot submit details for payment with status ${payment.status}`,
        400,
      );
    }

    payment.status = "PENDING_VERIFICATION";
    payment.gatewayData = {
      ...(payment.gatewayData || {}),
      bankTransfer: {
        bankName: transferDetails.bankName,
        accountName: transferDetails.accountName,
        accountNumber: transferDetails.accountNumber,
        branchName: transferDetails.branchName,
        depositDate: transferDetails.depositDate || new Date(),
        referenceNumber: transferDetails.referenceNumber,
        receiptUrl: transferDetails.receiptUrl,
        depositAmount: transferDetails.depositAmount,
      },
    };

    await payment.save();

    await PaymentAuditLog.create({
      paymentId: payment._id,
      workspaceId,
      action: "TRANSFER_SUBMITTED",
      actorType: "USER",
      actorId: userId,
      ipAddress,
      userAgent,
      metadata: {
        referenceNumber: transferDetails.referenceNumber,
        depositAmount: transferDetails.depositAmount,
      },
    });

    return payment;
  }

  /**
   * Atomically completes a payment, extends the subscription, creates an invoice,
   * and writes audit logs. Safe against race conditions and duplicate executions.
   */
  async completePaymentAtomic(params: CompletePaymentParams): Promise<{
    payment: IPayment;
    subscription: ISubscription;
    invoice: any;
  }> {
    const { paymentId, completionData, actor, notes, ipAddress, userAgent } =
      params;

    return runWithTransaction(async (session) => {
      // Atomic conditional update: only transition from INITIATED or PENDING_VERIFICATION
      const payment = await Payment.findOneAndUpdate(
        {
          _id: paymentId,
          status: { $in: ["INITIATED", "PENDING_VERIFICATION"] },
        },
        {
          $set: {
            status: "COMPLETED",
            completedAt: new Date(),
            ...(completionData?.trxID
              ? { "gatewayData.trxID": completionData.trxID }
              : {}),
            ...(completionData?.paymentID
              ? { "gatewayData.paymentID": completionData.paymentID }
              : {}),
            ...(completionData?.cblOrderId
              ? { "gatewayData.cblOrderId": completionData.cblOrderId }
              : {}),
            ...(completionData?.cblTransactionId
              ? {
                  "gatewayData.cblTransactionId":
                    completionData.cblTransactionId,
                }
              : {}),
            ...(completionData?.rawGatewayResponse
              ? {
                  "gatewayData.rawGatewayResponse":
                    completionData.rawGatewayResponse,
                }
              : {}),
          },
        },
        session
          ? { returnDocument: "after", session }
          : { returnDocument: "after" },
      );

      if (!payment) {
        // If not found in eligible state, check if already completed (idempotency check)
        const paymentLookup = Payment.findById(paymentId);
        if (session) {
          paymentLookup.session(session);
        }
        const existing = await paymentLookup;

        if (!existing) {
          throw new AppError("Payment record not found", 404);
        }
        if (existing.status === "COMPLETED") {
          // Already completed: retrieve current subscription and invoice for idempotent response
          const subLookup = Subscription.findOne({
            workspaceId: existing.workspaceId,
          });
          if (session) {
            subLookup.session(session);
          }
          const subscription = await subLookup;

          // Fix 2: Search invoice by invoiceNumber and workspaceId, not by _id
          const invoice = await invoiceService.getWorkspaceInvoiceByNumber(
            existing.workspaceId,
            existing.invoiceNumber,
          );

          if (!invoice) {
            console.error(
              `[BILLING_INTEGRITY_ERROR] Completed payment ${existing._id} has no invoice record (invoiceNumber: ${existing.invoiceNumber})`,
            );
            throw new AppError(
              "Billing integrity error: payment marked completed but invoice record missing",
              500,
            );
          }

          return { payment: existing, subscription: subscription!, invoice };
        }
        throw new AppError(
          `Payment cannot be completed from current status: ${existing.status}`,
          400,
        );
      }

      // Resolve workspace and payer for invoice details
      const workspaceQuery = Workspace.findById(payment.workspaceId);
      if (session) {
        workspaceQuery.session(session);
      }
      const userQuery = User.findById(payment.initiatedBy);
      if (session) {
        userQuery.session(session);
      }
      const [workspace, user] = await Promise.all([workspaceQuery, userQuery]);

      if (!workspace) {
        throw new AppError("Workspace for payment not found", 404);
      }
      // inside completePaymentAtomic transaction:
      const workspaceUpdate = Workspace.updateOne(
        { _id: payment.workspaceId },
        { $set: { status: "ACTIVE" } },
      );
      if (session) workspaceUpdate.session(session);

      const userUpdate = User.updateOne(
        { _id: payment.initiatedBy },
        { $set: { isPaid: true, subscriptionStatus: "active" } },
      );
      if (session) userUpdate.session(session);
      await Promise.all([workspaceUpdate, userUpdate]);

      // Extend or activate subscription
      const subscription = await subscriptionService.extendSubscriptionPeriod(
        {
          workspaceId: payment.workspaceId,
          planCode: payment.planCode,
          paymentId: payment._id,
        },
        session,
      );

      // Create paid invoice (with bounded unique collision retry inside the session)
      const invoice = await invoiceService.createInvoice(
        {
          invoiceNumber: payment.invoiceNumber,
          workspaceId: payment.workspaceId,
          paymentId: payment._id,
          issuedTo: {
            userId: payment.initiatedBy,
            userName: user?.name || "Customer",
            userEmail: user?.email || "customer@vexchat.app",
            workspaceName: workspace.name,
          },
          planCode: payment.planCode,
          planName: payment.planName,
          amount: payment.amount,
          currency: payment.currency,
          status: "PAID",
          paymentMethod: payment.paymentMethod,
          periodCoveredStart: subscription.currentPeriodStart,
          periodCoveredEnd: subscription.currentPeriodEnd,
          paidAt: payment.completedAt,
        },
        session,
      );

      // Audit logs
      await PaymentAuditLog.create(
        [
          {
            paymentId: payment._id,
            workspaceId: payment.workspaceId,
            action: "PAYMENT_COMPLETED",
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorEmail: actor.actorEmail,
            ipAddress,
            userAgent,
            metadata: {
              trxID: completionData?.trxID,
              cblOrderId: completionData?.cblOrderId,
              notes,
            },
          },
          {
            paymentId: payment._id,
            workspaceId: payment.workspaceId,
            action: "SUBSCRIPTION_EXTENDED",
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorEmail: actor.actorEmail,
            ipAddress,
            userAgent,
            metadata: {
              planCode: subscription.planCode,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
            },
          },
          {
            paymentId: payment._id,
            workspaceId: payment.workspaceId,
            action: "INVOICE_GENERATED",
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorEmail: actor.actorEmail,
            ipAddress,
            userAgent,
            metadata: {
              invoiceNumber: invoice.invoiceNumber,
              amount: invoice.amount,
            },
          },
        ],
        session ? { session } : undefined,
      );

      return { payment, subscription, invoice };
    });
  }

  /**
   * Approves a verified City Bank manual transfer.
   * High-Value Guard: If payment amount >= 50,000 BDT, enforces stepUpToken validation.
   * Transactional Flow:
   * - Validates PENDING_VERIFICATION.
   * - Atomically marks Payment as COMPLETED, populating bank verification metadata.
   * - Activates/extends Subscription.
   * - Creates/updates Invoice as PAID.
   * - Updates Workspace to ACTIVE and User isPaid=true, subscriptionStatus="active".
   * - Logs TRANSFER_APPROVED and SUBSCRIPTION_EXTENDED in PaymentAuditLog.
   */
  async approveBankTransfer(params: {
    paymentId: string | Types.ObjectId;
    adminUser: { id: string; email: string };
    adminNotes?: string;
    stepUpToken?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{
    payment: IPayment;
    subscription: ISubscription;
    invoice: any;
  }> {
    const {
      paymentId,
      adminUser,
      adminNotes,
      stepUpToken,
      ipAddress,
      userAgent,
    } = params;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new AppError("Payment record not found", 404);
    }

    if (payment.paymentMethod !== "CITY_BANK_TRANSFER") {
      throw new AppError("Payment is not a City Bank transfer", 400);
    }

    if (payment.status !== "PENDING_VERIFICATION") {
      throw new AppError(
        `Cannot approve bank transfer with status ${payment.status}`,
        400,
      );
    }

    // High-Value Guard: >= 50,000 BDT requires a valid step-up authorization token
    if (payment.amount >= 50000) {
      if (
        !stepUpToken ||
        typeof stepUpToken !== "string" ||
        stepUpToken.trim().length === 0
      ) {
        throw new AppError(
          "High-value transfer (>= ৳50,000 BDT) requires a valid step-up authorization token",
          403,
          "STEP_UP_REQUIRED",
        );
      }

      const isStepUpValid = verifyStepUpToken(stepUpToken.trim(), adminUser.id);
      if (!isStepUpValid) {
        throw new AppError(
          "Invalid or expired step-up authorization token",
          403,
          "INVALID_STEP_UP_TOKEN",
        );
      }
    }

    return runWithTransaction(async (session) => {
      // 1. Atomically lock and transition payment inside transaction
      const lockedPayment = await Payment.findOneAndUpdate(
        {
          _id: paymentId,
          status: "PENDING_VERIFICATION",
        },
        {
          $set: {
            status: "COMPLETED",
            completedAt: new Date(),
            "gatewayData.bankTransfer.verifiedBy": new mongoose.Types.ObjectId(
              adminUser.id,
            ),
            "gatewayData.bankTransfer.verifiedAt": new Date(),
            ...(adminNotes
              ? { "gatewayData.bankTransfer.adminNotes": adminNotes.trim() }
              : {}),
          },
        },
        session
          ? { returnDocument: "after", session }
          : { returnDocument: "after" },
      );

      if (!lockedPayment) {
        throw new AppError(
          "Payment was concurrently modified or is no longer pending verification",
          409,
        );
      }

      // 2. Resolve Workspace and Payer inside session
      const workspaceQuery = Workspace.findById(lockedPayment.workspaceId);
      if (session) workspaceQuery.session(session);
      const userQuery = User.findById(lockedPayment.initiatedBy);
      if (session) userQuery.session(session);
      const [workspace, user] = await Promise.all([workspaceQuery, userQuery]);

      if (!workspace) {
        throw new AppError("Workspace for payment not found", 404);
      }

      // 3. Activate or extend subscription
      const subscription = await subscriptionService.extendSubscriptionPeriod(
        {
          workspaceId: lockedPayment.workspaceId,
          planCode: lockedPayment.planCode,
          paymentId: lockedPayment._id,
        },
        session,
      );

      // 4. Create or update paid invoice
      const invoice = await invoiceService.createInvoice(
        {
          invoiceNumber: lockedPayment.invoiceNumber,
          workspaceId: lockedPayment.workspaceId,
          paymentId: lockedPayment._id,
          issuedTo: {
            userId: lockedPayment.initiatedBy,
            userName: user?.name || "Customer",
            userEmail: user?.email || "customer@vexchat.app",
            workspaceName: workspace.name,
          },
          planCode: lockedPayment.planCode,
          planName: lockedPayment.planName,
          amount: lockedPayment.amount,
          currency: lockedPayment.currency,
          status: "PAID",
          paymentMethod: lockedPayment.paymentMethod,
          periodCoveredStart: subscription.currentPeriodStart,
          periodCoveredEnd: subscription.currentPeriodEnd,
          paidAt: lockedPayment.completedAt,
        },
        session,
      );

      // 5. Update Workspace & User models
      const workspaceUpdate = Workspace.updateOne(
        { _id: lockedPayment.workspaceId },
        { $set: { status: "ACTIVE" } },
      );
      if (session) workspaceUpdate.session(session);

      const userUpdate = User.updateOne(
        { _id: lockedPayment.initiatedBy },
        { $set: { isPaid: true, subscriptionStatus: "active" } },
      );
      if (session) userUpdate.session(session);

      await Promise.all([workspaceUpdate, userUpdate]);

      // 6. Write audit logs
      await PaymentAuditLog.create(
        [
          {
            paymentId: lockedPayment._id,
            workspaceId: lockedPayment.workspaceId,
            action: "TRANSFER_APPROVED",
            actorType: "PLATFORM_ADMIN",
            actorId: new mongoose.Types.ObjectId(adminUser.id),
            actorEmail: adminUser.email,
            ipAddress,
            userAgent,
            metadata: {
              adminNotes,
              amount: lockedPayment.amount,
              planCode: lockedPayment.planCode,
            },
          },
          {
            paymentId: lockedPayment._id,
            workspaceId: lockedPayment.workspaceId,
            action: "SUBSCRIPTION_EXTENDED",
            actorType: "PLATFORM_ADMIN",
            actorId: new mongoose.Types.ObjectId(adminUser.id),
            actorEmail: adminUser.email,
            ipAddress,
            userAgent,
            metadata: {
              planCode: subscription.planCode,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
            },
          },
          {
            paymentId: lockedPayment._id,
            workspaceId: lockedPayment.workspaceId,
            action: "INVOICE_GENERATED",
            actorType: "PLATFORM_ADMIN",
            actorId: new mongoose.Types.ObjectId(adminUser.id),
            actorEmail: adminUser.email,
            ipAddress,
            userAgent,
            metadata: {
              invoiceNumber: invoice.invoiceNumber,
              amount: invoice.amount,
            },
          },
        ],
        session ? { session } : undefined,
      );

      return { payment: lockedPayment, subscription, invoice };
    });
  }

  /**
   * Rejects an invalid or fraudulent City Bank manual transfer inside a transaction.
   * Restricted strictly to platform administrators.
   */
  async rejectBankTransfer(params: {
    paymentId: string | Types.ObjectId;
    adminUser: { id: string; email: string };
    rejectionReason: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<IPayment> {
    const { paymentId, adminUser, rejectionReason, ipAddress, userAgent } =
      params;

    if (!rejectionReason || rejectionReason.trim().length === 0) {
      throw new AppError("Rejection reason is required", 400);
    }

    return runWithTransaction(async (session) => {
      const payment = await Payment.findOneAndUpdate(
        {
          _id: paymentId,
          paymentMethod: "CITY_BANK_TRANSFER",
          status: "PENDING_VERIFICATION",
        },
        {
          $set: {
            status: "REJECTED",
            "gatewayData.bankTransfer.rejectionReason": rejectionReason.trim(),
            "gatewayData.bankTransfer.verifiedBy": new mongoose.Types.ObjectId(
              adminUser.id,
            ),
            "gatewayData.bankTransfer.verifiedAt": new Date(),
          },
        },
        session
          ? { returnDocument: "after", session }
          : { returnDocument: "after" },
      );

      if (!payment) {
        const existing = await Payment.findById(paymentId);
        if (!existing) {
          throw new AppError("Payment not found", 404);
        }
        if (existing.paymentMethod !== "CITY_BANK_TRANSFER") {
          throw new AppError("Payment is not a City Bank transfer", 400);
        }
        throw new AppError(
          `Cannot reject bank transfer with status ${existing.status}`,
          400,
        );
      }

      await PaymentAuditLog.create(
        [
          {
            paymentId: payment._id,
            workspaceId: payment.workspaceId,
            action: "TRANSFER_REJECTED",
            actorType: "PLATFORM_ADMIN",
            actorId: new mongoose.Types.ObjectId(adminUser.id),
            actorEmail: adminUser.email,
            ipAddress,
            userAgent,
            metadata: { rejectionReason: rejectionReason.trim() },
          },
        ],
        session ? { session } : undefined,
      );

      return payment;
    });
  }

  /**
   * Refunds a completed payment inside a MongoDB transaction.
   * Reverts subscription and workspace status if no other completed payments exist.
   */
  async refundPayment(params: {
    paymentId: string | Types.ObjectId;
    adminUser: { id: string; email: string };
    reason: string;
    refundAmount?: number;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ payment: IPayment; subscription?: ISubscription | null }> {
    const { paymentId, adminUser, reason, refundAmount, ipAddress, userAgent } =
      params;

    if (!reason || reason.trim().length === 0) {
      throw new AppError("Refund reason is required", 400);
    }

    return runWithTransaction(async (session) => {
      const paymentQuery = Payment.findById(paymentId);
      if (session) paymentQuery.session(session);
      const payment = await paymentQuery;

      if (!payment) {
        throw new AppError("Payment record not found", 404);
      }

      if (payment.status !== "COMPLETED") {
        throw new AppError(
          `Cannot refund payment with status: ${payment.status}`,
          400,
        );
      }

      const finalRefundAmount =
        refundAmount && refundAmount > 0 ? refundAmount : payment.amount;

      payment.status = "REFUNDED";
      payment.refundMetadata = {
        refundedAt: new Date(),
        refundedBy: new mongoose.Types.ObjectId(adminUser.id),
        refundReason: reason.trim(),
        refundAmount: finalRefundAmount,
      };

      if (session) {
        await payment.save({ session });
      } else {
        await payment.save();
      }

      // Check if there are other completed payments for this workspace
      const otherPaymentsQuery = Payment.countDocuments({
        workspaceId: payment.workspaceId,
        status: "COMPLETED",
        _id: { $ne: payment._id },
      });
      if (session) otherPaymentsQuery.session(session);
      const otherCompletedCount = await otherPaymentsQuery;

      let subscription: ISubscription | null = null;
      if (otherCompletedCount === 0) {
        // Revert subscription status
        const subQuery = Subscription.findOne({
          workspaceId: payment.workspaceId,
        });
        if (session) subQuery.session(session);
        subscription = await subQuery;

        if (subscription) {
          subscription.status = "CANCELLED";
          if (session) {
            await subscription.save({ session });
          } else {
            await subscription.save();
          }
        }

        // Revert user paid status
        const userUpdateQuery = User.updateOne(
          { _id: payment.initiatedBy },
          { $set: { isPaid: false, subscriptionStatus: "expired" } },
        );
        if (session) userUpdateQuery.session(session);
        await userUpdateQuery;
      }

      // Void associated invoice
      const invoiceUpdateQuery = Invoice.updateOne(
        { paymentId: payment._id },
        { $set: { status: "VOID" } },
      );
      if (session) invoiceUpdateQuery.session(session);
      await invoiceUpdateQuery;

      // Write Audit Log
      await PaymentAuditLog.create(
        [
          {
            paymentId: payment._id,
            workspaceId: payment.workspaceId,
            action: "PAYMENT_REFUNDED",
            actorType: "PLATFORM_ADMIN",
            actorId: new mongoose.Types.ObjectId(adminUser.id),
            actorEmail: adminUser.email,
            ipAddress,
            userAgent,
            metadata: {
              reason: reason.trim(),
              refundAmount: finalRefundAmount,
              originalAmount: payment.amount,
            },
          },
        ],
        session ? { session } : undefined,
      );

      return { payment, subscription };
    });
  }

  /**
   * Marks a payment as failed.
   */
  async failPayment(params: {
    paymentId: string | Types.ObjectId;
    failureReason: string;
    actorType?: AuditActorType;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<IPayment> {
    const {
      paymentId,
      failureReason,
      actorType = "SYSTEM",
      ipAddress,
      userAgent,
    } = params;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new AppError("Payment not found", 404);
    }

    if (payment.status === "COMPLETED") {
      throw new AppError("Cannot fail an already completed payment", 400);
    }

    payment.status = "FAILED";
    payment.failureReason = failureReason;
    await payment.save();

    await PaymentAuditLog.create({
      paymentId: payment._id,
      workspaceId: payment.workspaceId,
      action: "PAYMENT_FAILED",
      actorType,
      ipAddress,
      userAgent,
      metadata: { failureReason },
    });

    return payment;
  }

  /**
   * Retrieves complete billing overview for a workspace.
   */
  async getBillingOverview(workspaceId: string | Types.ObjectId): Promise<{
    subscription: ISubscription | null;
    plans: (typeof BILLING_PLANS)[PlanCode][];
    recentPayments: IPayment[];
    recentInvoices: any[];
    isSubscriptionActive: boolean;
    daysRemaining: number;
  }> {
    const [subscription, recentPayments, recentInvoices] = await Promise.all([
      subscriptionService.getWorkspaceSubscription(workspaceId),
      Payment.find({ workspaceId }).sort({ createdAt: -1 }).limit(5).lean(),
      invoiceService.getWorkspaceInvoices(workspaceId, { limit: 5 }),
    ]);

    const now = new Date();
    let isSubscriptionActive = false;
    let daysRemaining = 0;

    if (subscription && subscription.status === "ACTIVE") {
      const diffMs = subscription.currentPeriodEnd.getTime() - now.getTime();
      if (diffMs > 0) {
        isSubscriptionActive = true;
        daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }
    }

    return {
      subscription,
      plans: Object.values(BILLING_PLANS),
      recentPayments: recentPayments as unknown as IPayment[],
      recentInvoices: recentInvoices.invoices,
      isSubscriptionActive,
      daysRemaining,
    };
  }

  /**
   * Lists pending bank transfers for platform administrators.
   */
  async listPendingBankTransfers(options: {
    page?: number;
    limit?: number;
  }): Promise<{ transfers: IPayment[]; total: number; page: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const query: Record<string, any> = {
      paymentMethod: "CITY_BANK_TRANSFER",
      status: "PENDING_VERIFICATION",
    };

    const [transfers, total] = await Promise.all([
      Payment.find(query)
        .populate("workspaceId", "name slug")
        .populate("initiatedBy", "name email")
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(query),
    ]);

    return {
      transfers: transfers as unknown as IPayment[],
      total,
      page,
    };
  }
}

export const billingService = new BillingService();
