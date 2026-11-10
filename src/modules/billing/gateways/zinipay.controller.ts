import type { Request, Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../../middlewares/require-workspace-membership.js";
import { AppError } from "../../../utils/app-error.js";
import { BILLING_PLANS, type PlanCode } from "../billing.config.js";
import { billingService } from "../billing.service.js";
import Payment from "../payment.model.js";
import { zinipayGatewayService } from "./zinipay.service.js";

/**
 * POST /api/workspaces/:workspaceId/billing/pay/zinipay
 * Initiates an automated subscription checkout session with ZiniPay.
 * Enforces authoritative pricing and generates a secure hosted checkout URL.
 */
export async function initiateZinipayPaymentController(
  req: WorkspaceRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workspaceId = req.workspace!.id;
    const userId = req.user!.id;
    const planCode = req.body?.planCode as PlanCode;

    if (!planCode || !BILLING_PLANS[planCode]) {
      throw new AppError(
        `Invalid or missing planCode: ${planCode}. Must be one of: ${Object.keys(BILLING_PLANS).join(", ")}`,
        400,
      );
    }

    // 1. Authoritative payment initiation via billing service (creates INITIATED Payment and audit log)
    const { payment } = await billingService.initiatePayment({
      workspaceId,
      initiatedBy: userId,
      planCode,
      paymentMethod: "ZINIPAY",
      ipAddress: req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
    });

    // 2. Resolve backend callback & webhook ingress URLs
    const backendBase = (
      process.env.PUBLIC_API_URL ||
      process.env.BACKEND_URL ||
      `${req.protocol}://${req.get("host")}`
    ).replace(/\/+$/, "");

    const frontendBase = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");

    const redirectUrl =
      process.env.ZINIPAY_SUCCESS_URL ||
      `${backendBase}/api/billing/gateways/zinipay/callback`;

    const cancelUrl =
      process.env.ZINIPAY_CANCEL_URL ||
      `${frontendBase}/billing?payment_status=cancelled`;

    const webhookUrl = `${backendBase}/api/billing/gateways/zinipay/webhook`;

    // 3. Create checkout session on ZiniPay API
    const session = await zinipayGatewayService.createPaymentSession({
      amount: payment.amount,
      invoiceNumber: payment.invoiceNumber,
      workspaceId,
      planCode,
      userId,
      userName: req.user?.name,
      userEmail: req.user?.email,
      redirectUrl,
      cancelUrl,
      webhookUrl,
    });

    // 4. Update Payment record with ZiniPay gateway identifiers
    payment.gatewayData = {
      ...(payment.gatewayData || {}),
      paymentID: session.invoiceId,
      zinipayInvoiceId: session.invoiceId,
      zinipayPaymentUrl: session.paymentUrl,
    };
    await payment.save();

    res.status(200).json({
      success: true,
      message: "ZiniPay checkout session created successfully",
      gatewayUrl: session.paymentUrl,
      data: {
        gatewayUrl: session.paymentUrl,
        paymentId: payment._id,
        invoiceNumber: payment.invoiceNumber,
        planCode: payment.planCode,
        amount: payment.amount,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET/POST /api/billing/gateways/zinipay/callback
 * Also handles /api/billing/gateways/zinipay/webhook
 *
 * Catches return redirects or server webhooks from ZiniPay, validates transaction
 * via server-to-server verification, and atomically activates the subscription.
 */
export async function zinipayCallbackController(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const frontendUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");
  const isWebhookOrJson =
    req.headers.accept?.includes("application/json") ||
    (req.method === "POST" && !req.headers["sec-fetch-dest"]);

  const invoiceId = (
    req.query.invoice_id ||
    req.body?.invoice_id ||
    req.query.invoiceId ||
    req.body?.invoiceId ||
    req.query.paymentID ||
    req.body?.paymentID
  ) as string;

  const rawStatus = (req.query.status || req.body?.status || "").toString().toLowerCase();

  try {
    // 1. Explicit cancellation or rejection from user redirect query
    if (rawStatus === "cancel" || rawStatus === "cancelled") {
      if (invoiceId) {
        await Payment.updateOne(
          {
            $or: [
              { "gatewayData.zinipayInvoiceId": invoiceId },
              { "gatewayData.paymentID": invoiceId },
            ],
            status: "INITIATED",
          },
          { $set: { status: "CANCELLED" } },
        );
      }

      if (isWebhookOrJson) {
        res.status(200).json({ success: true, message: "Payment was marked cancelled" });
        return;
      }
      res.redirect(`${frontendUrl}/billing?payment_status=cancelled`);
      return;
    }

    if (rawStatus === "failure" || rawStatus === "failed") {
      if (invoiceId) {
        await Payment.updateOne(
          {
            $or: [
              { "gatewayData.zinipayInvoiceId": invoiceId },
              { "gatewayData.paymentID": invoiceId },
            ],
            status: "INITIATED",
          },
          { $set: { status: "FAILED", failureReason: "Payment failed on gateway" } },
        );
      }

      if (isWebhookOrJson) {
        res.status(200).json({ success: true, message: "Payment was marked failed" });
        return;
      }
      res.redirect(`${frontendUrl}/billing?payment_status=failed`);
      return;
    }

    if (!invoiceId) {
      if (isWebhookOrJson) {
        res.status(400).json({ success: false, message: "Missing invoice_id parameter" });
        return;
      }
      res.redirect(`${frontendUrl}/billing?payment_status=failed&reason=missing_invoice_id`);
      return;
    }

    // 2. Cryptographic / Server-to-Server Verification with ZiniPay API
    const verified = await zinipayGatewayService.verifyPayment(invoiceId);

    // 3. Match Payment in database
    const payment = await Payment.findOne({
      $or: [
        { "gatewayData.zinipayInvoiceId": invoiceId },
        { "gatewayData.paymentID": invoiceId },
        { invoiceNumber: verified.invoice_id || invoiceId },
      ],
    });

    if (!payment) {
      if (isWebhookOrJson) {
        res.status(404).json({ success: false, message: "Payment record not found for invoice" });
        return;
      }
      res.redirect(`${frontendUrl}/billing?payment_status=not_found&invoice_id=${invoiceId}`);
      return;
    }

    // 4. Handle COMPLETED
    if (verified.status === "COMPLETED") {
      if (payment.status === "COMPLETED") {
        // Idempotent safeguard: already completed
        if (isWebhookOrJson) {
          res.status(200).json({ success: true, message: "Payment already completed" });
          return;
        }
        res.redirect(
          `${frontendUrl}/billing?payment_status=success&invoice=${payment.invoiceNumber}`,
        );
        return;
      }

      // Execute atomic completion (extends Subscription, activates Workspace, sets User.isPaid=true)
      await billingService.completePaymentAtomic({
        paymentId: payment._id,
        completionData: {
          trxID: verified.transaction_id,
          paymentID: verified.invoice_id || invoiceId,
          rawGatewayResponse: verified.rawResponse || verified,
        },
        actor: {
          actorType: "SYSTEM",
          actorEmail: "zinipay-webhook@vexchat.app",
        },
        notes: `ZiniPay automated payment verified. TrxID: ${verified.transaction_id || "N/A"}, MFS: ${verified.payment_method || "Online"}`,
      });

      if (isWebhookOrJson) {
        res.status(200).json({ success: true, message: "Payment verified and completed successfully" });
        return;
      }
      res.redirect(
        `${frontendUrl}/billing?payment_status=success&invoice=${payment.invoiceNumber}`,
      );
      return;
    }

    // 5. Handle PENDING
    if (verified.status === "PENDING") {
      if (isWebhookOrJson) {
        res.status(200).json({ success: true, message: "Payment is pending verification" });
        return;
      }
      res.redirect(
        `${frontendUrl}/billing?payment_status=pending&invoice=${payment.invoiceNumber}`,
      );
      return;
    }

    // 6. Handle FAILED
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: "FAILED",
          failureReason: verified.message || "Payment verification reported non-completed status",
        },
      },
    );

    if (isWebhookOrJson) {
      res.status(400).json({ success: false, message: "Payment verification failed" });
      return;
    }
    res.redirect(`${frontendUrl}/billing?payment_status=failed&reason=verification_failed`);
  } catch (err: any) {
    console.error("[ZiniPay Callback/Webhook Error]", err);
    if (isWebhookOrJson) {
      res.status(500).json({
        success: false,
        message: err?.message || "Internal server error during ZiniPay verification",
      });
      return;
    }
    res.redirect(`${frontendUrl}/billing?payment_status=error`);
  }
}

