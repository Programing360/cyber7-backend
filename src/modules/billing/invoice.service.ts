import crypto from "node:crypto";
import type { ClientSession, Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import {
  BILLING_CYCLE,
  CURRENCY,
  type InvoiceStatus,
  type PaymentMethod,
  type PlanCode,
} from "./billing.config.js";
import Invoice, { type IInvoice, type IInvoiceIssuedTo } from "./invoice.model.js";

export interface CreateInvoiceParams {
  invoiceNumber?: string;
  workspaceId: Types.ObjectId;
  paymentId: Types.ObjectId;
  issuedTo: IInvoiceIssuedTo;
  planCode: PlanCode;
  planName: string;
  amount: number;
  currency?: string;
  status?: InvoiceStatus;
  paymentMethod: PaymentMethod;
  periodCoveredStart: Date;
  periodCoveredEnd: Date;
  paidAt?: Date;
}

export class InvoiceService {
  /**
   * Generates a collision-resistant invoice identifier with random hex suffix.
   * Format: INV-YYYYMM-XXXXX (e.g., INV-202611-A8F3C)
   * Note: This format uses pseudo-random hex characters to prevent sequential enumeration.
   */
  generateInvoiceNumber(date: Date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const randomHex = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 5);
    return `INV-${year}${month}-${randomHex}`;
  }

  /**
   * Creates an invoice record atomically.
   * Includes bounded collision retry inside the session if random invoice number collision occurs.
   */
  async createInvoice(
    params: CreateInvoiceParams,
    session?: ClientSession,
  ): Promise<IInvoice> {
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      const invoiceNumber =
        attempt === 1 && params.invoiceNumber
          ? params.invoiceNumber
          : this.generateInvoiceNumber();

      try {
        const invoiceDocs = await Invoice.create(
          [
            {
              invoiceNumber,
              workspaceId: params.workspaceId,
              paymentId: params.paymentId,
              issuedTo: params.issuedTo,
              planCode: params.planCode,
              planName: params.planName,
              billingCycle: BILLING_CYCLE,
              periodCoveredStart: params.periodCoveredStart,
              periodCoveredEnd: params.periodCoveredEnd,
              amount: params.amount,
              currency: params.currency || CURRENCY,
              status: params.status || "PAID",
              paymentMethod: params.paymentMethod,
              paidAt:
                params.paidAt ||
                (params.status === "PAID" ? new Date() : undefined),
            },
          ],
          session ? { session } : undefined,
        );

        return invoiceDocs[0];
      } catch (err: any) {
        lastError = err;
        const isDuplicateKey =
          err?.code === 11000 &&
          (err?.keyPattern?.invoiceNumber ||
            JSON.stringify(err).includes("invoiceNumber"));

        if (isDuplicateKey && attempt < MAX_ATTEMPTS) {
          continue;
        }

        throw err;
      }
    }

    throw lastError || new AppError("Failed to generate unique invoice", 500);
  }

  /**
   * Retrieves paginated invoices for a workspace.
   */
  async getWorkspaceInvoices(
    workspaceId: string | Types.ObjectId,
    options: { page?: number; limit?: number } = {},
  ): Promise<{ invoices: IInvoice[]; total: number; page: number; totalPages: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const [invoices, total] = await Promise.all([
      Invoice.find({ workspaceId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments({ workspaceId }),
    ]);

    return {
      invoices: invoices as unknown as IInvoice[],
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves an invoice by MongoDB ObjectId with strict workspace tenancy check.
   */
  async getWorkspaceInvoiceById(
    workspaceId: string | Types.ObjectId,
    invoiceId: string | Types.ObjectId,
  ): Promise<IInvoice> {
    const invoice = await Invoice.findOne({
      _id: invoiceId,
      workspaceId,
    });

    if (!invoice) {
      throw new AppError("Invoice not found in this workspace", 404);
    }

    return invoice;
  }

  /**
   * Retrieves an invoice by its invoiceNumber with strict workspace tenancy check.
   */
  async getWorkspaceInvoiceByNumber(
    workspaceId: string | Types.ObjectId,
    invoiceNumber: string,
  ): Promise<IInvoice | null> {
    const invoice = await Invoice.findOne({
      invoiceNumber: invoiceNumber.trim(),
      workspaceId,
    });

    return invoice;
  }
}

export const invoiceService = new InvoiceService();
