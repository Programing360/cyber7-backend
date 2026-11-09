import { z } from "zod";
import { PAYMENT_METHODS, type PlanCode } from "./billing.config.js";

export const PLAN_CODES: [PlanCode, ...PlanCode[]] = [
  "STARTER",
  "BUSINESS_PRO",
  "ENTERPRISE",
];

export const initiatePaymentSchema = z
  .object({
    planCode: z.enum(PLAN_CODES),
    paymentMethod: z.enum(PAYMENT_METHODS),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "Idempotency key must be at least 8 characters")
      .max(128, "Idempotency key cannot exceed 128 characters")
      .optional(),
  })
  .strict();

export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;

export const submitBankTransferSchema = z
  .object({
    bankName: z.string().trim().max(100).optional(),
    accountName: z.string().trim().max(100).optional(),
    accountNumber: z.string().trim().max(50).optional(),
    branchName: z.string().trim().max(100).optional(),
    depositDate: z
      .string()
      .datetime({ offset: true })
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
    referenceNumber: z
      .string()
      .trim()
      .min(3, "Transaction reference number is required")
      .max(100, "Reference number cannot exceed 100 characters"),
    receiptUrl: z.string().url("Valid receipt URL required").max(1000).optional(),
    depositAmount: z.number().positive("Deposit amount must be a positive number"),
  })
  .strict();

export type SubmitBankTransferInput = z.infer<typeof submitBankTransferSchema>;

export const adminApproveTransferSchema = z
  .object({
    notes: z.string().trim().max(500).optional(),
    adminNotes: z.string().trim().max(500).optional(),
    stepUpToken: z.string().trim().optional(),
  })
  .strict();

export const adminRejectTransferSchema = z
  .object({
    reason: z.string().trim().min(3).max(500).optional(),
    rejectionReason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((data) => Boolean(data.reason || data.rejectionReason), {
    message: "Rejection reason is required",
    path: ["rejectionReason"],
  });

export const adminRefundPaymentSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, "Refund reason is required (at least 3 characters)")
      .max(500, "Refund reason cannot exceed 500 characters"),
    refundAmount: z
      .number()
      .positive("Refund amount must be positive")
      .optional(),
  })
  .strict();

export const listInvoicesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
