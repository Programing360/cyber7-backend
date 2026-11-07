import mongoose, { Schema, type Document, type Types } from "mongoose";

export type AdminSecurityEventType =
  | "SESSION_CREATED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "AUTHENTICATION_REJECTED"
  | "ADMIN_DEACTIVATED"
  | "ADMIN_DEMOTED"
  | "MFA_ENROLLMENT_STARTED"
  | "MFA_ENROLLMENT_CONFIRMED"
  | "MFA_ENROLLMENT_REJECTED"
  | "MFA_VERIFICATION_SUCCEEDED"
  | "MFA_VERIFICATION_FAILED"
  | "MFA_RECOVERY_CODE_USED"
  | "MFA_RECOVERY_CODES_REGENERATED";

export interface IAdminSecurityAuditLog extends Document {
  eventType: AdminSecurityEventType;
  adminUserId?: Types.ObjectId;
  adminEmail?: string;
  sessionId?: Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

const adminSecurityAuditLogSchema = new Schema<IAdminSecurityAuditLog>(
  {
    eventType: {
      type: String,
      enum: [
        "SESSION_CREATED",
        "SESSION_REVOKED",
        "SESSION_EXPIRED",
        "AUTHENTICATION_REJECTED",
        "ADMIN_DEACTIVATED",
        "ADMIN_DEMOTED",
        "MFA_ENROLLMENT_STARTED",
        "MFA_ENROLLMENT_CONFIRMED",
        "MFA_ENROLLMENT_REJECTED",
        "MFA_VERIFICATION_SUCCEEDED",
        "MFA_VERIFICATION_FAILED",
        "MFA_RECOVERY_CODE_USED",
        "MFA_RECOVERY_CODES_REGENERATED",
      ],
      required: true,
      index: true,
    },
    adminUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    adminEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "AdminSession",
      index: true,
    },
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
    reason: {
      type: String,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
);

adminSecurityAuditLogSchema.index({ adminUserId: 1, timestamp: -1 });
adminSecurityAuditLogSchema.index({ eventType: 1, timestamp: -1 });

// Strictly enforce append-only immutability at the Mongoose layer
function denyMutation() {
  throw new Error(
    "AdminSecurityAuditLog is strictly append-only. Updates and deletions are forbidden.",
  );
}

adminSecurityAuditLogSchema.pre("updateOne", denyMutation);
adminSecurityAuditLogSchema.pre("updateMany", denyMutation);
adminSecurityAuditLogSchema.pre("findOneAndUpdate", denyMutation);
adminSecurityAuditLogSchema.pre("replaceOne", denyMutation);
adminSecurityAuditLogSchema.pre("deleteOne", denyMutation);
adminSecurityAuditLogSchema.pre("deleteMany", denyMutation);
adminSecurityAuditLogSchema.pre("findOneAndDelete", denyMutation);

const AdminSecurityAuditLog = mongoose.model<IAdminSecurityAuditLog>(
  "AdminSecurityAuditLog",
  adminSecurityAuditLogSchema,
);

export default AdminSecurityAuditLog;

