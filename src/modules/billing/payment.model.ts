import mongoose, { Schema, type Document, type Types } from "mongoose";
import {
  CURRENCY,
  type PaymentMethod,
  type PaymentStatus,
  type PlanCode,
} from "./billing.config.js";

export interface IBankTransferDetails {
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  branchName?: string;
  depositDate?: Date;
  referenceNumber?: string;
  receiptUrl?: string;
  receiptFileId?: string;
  depositAmount?: number;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  adminNotes?: string;
  rejectionReason?: string;
}

export interface IRefundMetadata {
  refundedAt?: Date;
  refundedBy?: Types.ObjectId;
  refundReason?: string;
  refundAmount?: number;
}

export interface IGatewayData {
  trxID?: string;
  paymentID?: string;
  cblOrderId?: string;
  cblTransactionId?: string;
  zinipayInvoiceId?: string;
  zinipayPaymentUrl?: string;
  bankTransfer?: IBankTransferDetails;
  rawGatewayResponse?: Record<string, any>;
}

export interface IPayment extends Document {
  workspaceId: Types.ObjectId;
  initiatedBy: Types.ObjectId;
  paymentMethod: PaymentMethod;
  planCode: PlanCode;
  planName: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  invoiceNumber: string;
  gatewayData?: IGatewayData;
  refundMetadata?: IRefundMetadata;
  failureReason?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    initiatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["BKASH", "CITY_BANK_CARD", "CITY_BANK_TRANSFER", "ZINIPAY"],
      required: true,
    },
    planCode: {
      type: String,
      enum: ["STARTER", "BUSINESS_PRO", "ENTERPRISE"],
      required: true,
    },
    planName: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: CURRENCY,
    },
    status: {
      type: String,
      enum: [
        "INITIATED",
        "PENDING_VERIFICATION",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "REJECTED",
        "REFUNDED",
      ],
      default: "INITIATED",
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    gatewayData: {
      trxID: { type: String, trim: true },
      paymentID: { type: String, trim: true },
      cblOrderId: { type: String, trim: true },
      cblTransactionId: { type: String, trim: true },
      zinipayInvoiceId: { type: String, trim: true },
      zinipayPaymentUrl: { type: String, trim: true },
      bankTransfer: {
        bankName: { type: String, trim: true },
        accountName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        branchName: { type: String, trim: true },
        depositDate: { type: Date },
        referenceNumber: { type: String, trim: true },
        receiptUrl: { type: String, trim: true },
        receiptFileId: { type: String, trim: true },
        depositAmount: { type: Number },
        verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
        verifiedAt: { type: Date },
        adminNotes: { type: String, trim: true },
        rejectionReason: { type: String, trim: true },
      },
      rawGatewayResponse: { type: Schema.Types.Mixed },
    },
    refundMetadata: {
      refundedAt: { type: Date },
      refundedBy: { type: Schema.Types.ObjectId, ref: "User" },
      refundReason: { type: String, trim: true },
      refundAmount: { type: Number, min: 0 },
    },
    failureReason: {
      type: String,
      trim: true,
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

paymentSchema.index({ workspaceId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });

// Workspace-scoped unique idempotency key
paymentSchema.index(
  { workspaceId: 1, idempotencyKey: 1 },
  { unique: true },
);

paymentSchema.index(
  { "gatewayData.trxID": 1 },
  { unique: true, sparse: true },
);
paymentSchema.index(
  { "gatewayData.cblOrderId": 1 },
  { unique: true, sparse: true },
);
paymentSchema.index(
  { "gatewayData.zinipayInvoiceId": 1 },
  { unique: true, sparse: true },
);
paymentSchema.index(
  { "gatewayData.paymentID": 1 },
  { sparse: true },
);

const Payment = mongoose.model<IPayment>("Payment", paymentSchema);

export const PaymentModel = Payment;
export default Payment;
