import type { Request, Response, NextFunction } from "express";
import { resendInvoiceEmailSchema } from "./invoice-email.validation.js";
import { streamInvoicePdf, resendInvoiceEmailService } from "./invoice-pdf.service.js";
import { streamPaymentReceiptPdf } from "./receipt-pdf.service.js";

export class DocumentController {
  /**
   * GET /api/platform-admin/billing/invoices/:invoiceId/pdf
   * Streams invoice PDF directly to client
   */
  async streamInvoicePdf(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const invoiceId = String(req.params.invoiceId || "").trim();
      if (!invoiceId) {
        res.status(400).json({
          success: false,
          error: "Invoice identifier is required.",
        });
        return;
      }

      await streamInvoicePdf(invoiceId, res);
    } catch (error: any) {
      if (res.headersSent) {
        return next(error);
      }

      const msg = error?.message || "Failed to generate invoice PDF";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({
          success: false,
          error: msg,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: msg,
      });
    }
  }

  /**
   * GET /api/platform-admin/billing/payments/:paymentId/receipt
   * Streams money receipt PDF directly to client
   */
  async streamPaymentReceiptPdf(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const paymentId = String(req.params.paymentId || "").trim();
      if (!paymentId) {
        res.status(400).json({
          success: false,
          error: "Payment identifier is required.",
        });
        return;
      }

      await streamPaymentReceiptPdf(paymentId, res);
    } catch (error: any) {
      if (res.headersSent) {
        return next(error);
      }

      const msg = error?.message || "Failed to generate payment receipt";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({
          success: false,
          error: msg,
        });
        return;
      }

      if (msg.toLowerCase().includes("completed")) {
        res.status(400).json({
          success: false,
          error: msg,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: msg,
      });
    }
  }

  /**
   * POST /api/platform-admin/billing/invoices/:invoiceId/resend
   * Resends invoice PDF via transactional email
   */
  async resendInvoiceEmail(
    req: Request,
    res: Response,
    _next: NextFunction,
  ): Promise<void> {
    try {
      const invoiceId = String(req.params.invoiceId || "").trim();
      if (!invoiceId) {
        res.status(400).json({
          success: false,
          error: "Invoice identifier is required.",
        });
        return;
      }

      const parsed = resendInvoiceEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const adminUser = (req as any).admin?.user;
      const adminSession = (req as any).admin?.session;

      const adminContext = {
        adminUserId: adminUser?._id,
        adminEmail: adminUser?.email,
        sessionId: adminSession?._id,
        ipAddress: req.ip || (req.headers["x-forwarded-for"] as string) || "127.0.0.1",
        userAgent: req.headers["user-agent"] || "unknown",
      };

      const result = await resendInvoiceEmailService(
        invoiceId,
        parsed.data,
        adminContext,
      );

      res.status(200).json({
        success: true,
        message: "Invoice email sent successfully.",
        data: result,
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to resend invoice email";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({
          success: false,
          error: msg,
        });
        return;
      }

      if (msg.toLowerCase().includes("no valid recipient") || msg.toLowerCase().includes("recipientemail")) {
        res.status(400).json({
          success: false,
          error: msg,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: msg,
      });
    }
  }
}

export const documentController = new DocumentController();
