import mongoose, { Schema, type Document, type Types } from "mongoose";
import {
  BILLING_CYCLE,
  CURRENCY,
  type InvoiceStatus,
  type PaymentMethod,
  type PlanCode,
} from "./billing.config.js";

export interface IInvoiceIssuedTo {
  userId: Types.ObjectId;
  userName: string;
  userEmail: string;
  workspaceName: string;
}

export interface IInvoice extends Document {
  invoiceNumber: string;
  workspaceId: Types.ObjectId;
  paymentId: Types.ObjectId;
  issuedTo: IInvoiceIssuedTo;
  planCode: PlanCode;
  planName: string;
  billingCycle: typeof BILLING_CYCLE;
  periodCoveredStart: Date;
  periodCoveredEnd: Date;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  paymentMethod: PaymentMethod;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
      required: true,
      index: true,
    },
    issuedTo: {
      userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
      userName: { type: String, required: true, trim: true },
      userEmail: { type: String, required: true, trim: true },
      workspaceName: { type: String, required: true, trim: true },
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
    billingCycle: {
      type: String,
      enum: ["MONTHLY"],
      default: "MONTHLY",
    },
    periodCoveredStart: {
      type: Date,
      required: true,
    },
    periodCoveredEnd: {
      type: Date,
      required: true,
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
      enum: ["PAID", "PENDING", "VOID"],
      default: "PAID",
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["BKASH", "CITY_BANK_CARD", "CITY_BANK_TRANSFER"],
      required: true,
    },
    paidAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

invoiceSchema.index({ workspaceId: 1, createdAt: -1 });

const Invoice = mongoose.model<IInvoice>("Invoice", invoiceSchema);

export default Invoice;

