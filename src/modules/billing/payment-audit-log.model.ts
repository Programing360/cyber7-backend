import mongoose, { Schema, type Document, type Types } from "mongoose";

export type AuditActorType = "USER" | "PLATFORM_ADMIN" | "SYSTEM";

export interface IPaymentAuditLog extends Document {
  paymentId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  action: string;
  actorType: AuditActorType;
  actorId?: Types.ObjectId;
  actorEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

const paymentAuditLogSchema = new Schema<IPaymentAuditLog>(
  {
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
      required: true,
      index: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    actorType: {
      type: String,
      enum: ["USER", "PLATFORM_ADMIN", "SYSTEM"],
      required: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    actorEmail: {
      type: String,
      trim: true,
    },
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
);

paymentAuditLogSchema.index({ workspaceId: 1, timestamp: -1 });
paymentAuditLogSchema.index({ paymentId: 1, timestamp: -1 });

const PaymentAuditLog = mongoose.model<IPaymentAuditLog>(
  "PaymentAuditLog",
  paymentAuditLogSchema,
);

export default PaymentAuditLog;

