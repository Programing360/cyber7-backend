import mongoose, { Schema, type Document, type Types } from "mongoose";
import {
  BILLING_CYCLE,
  CURRENCY,
  type PlanCode,
  type SubscriptionStatus,
} from "./billing.config.js";

export interface ISubscriptionHistoryItem {
  periodStart: Date;
  periodEnd: Date;
  planCode: PlanCode;
  paymentId?: Types.ObjectId;
  extendedAt: Date;
}

export interface ISubscription extends Document {
  workspaceId: Types.ObjectId;
  planCode: PlanCode;
  planName: string;
  status: SubscriptionStatus;
  currency: string;
  price: number;
  billingCycle: typeof BILLING_CYCLE;
  billingCycleAnchorDay: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  lastPaymentId?: Types.ObjectId;
  limits: {
    maxWhatsAppNumbers: number;
    maxTeamMembers: number;
  };
  features: string[];
  history: ISubscriptionHistoryItem[];
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
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
    status: {
      type: String,
      enum: ["ACTIVE", "EXPIRED", "CANCELLED"],
      default: "ACTIVE",
      index: true,
    },
    currency: {
      type: String,
      default: CURRENCY,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    billingCycle: {
      type: String,
      enum: ["MONTHLY"],
      default: "MONTHLY",
    },
    billingCycleAnchorDay: {
      type: Number,
      required: true,
      min: 1,
      max: 31,
      default: 1,
    },
    currentPeriodStart: {
      type: Date,
      required: true,
    },
    currentPeriodEnd: {
      type: Date,
      required: true,
      index: true,
    },
    lastPaymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
    },
    limits: {
      maxWhatsAppNumbers: {
        type: Number,
        default: 1,
      },
      maxTeamMembers: {
        type: Number,
        default: 3,
      },
    },
    features: {
      type: [String],
      default: [],
    },
    history: [
      {
        _id: false,
        periodStart: { type: Date, required: true },
        periodEnd: { type: Date, required: true },
        planCode: { type: String, required: true },
        paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
        extendedAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Helpful compound index for checking expired subscriptions
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

const Subscription = mongoose.model<ISubscription>(
  "Subscription",
  subscriptionSchema,
);

export default Subscription;
