import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IAdminBootstrapLock extends Document<string> {
  _id: string;
  adminUserId?: Types.ObjectId;
  adminEmail?: string;
  status: "PENDING" | "COMPLETED";
  completedAt?: Date;
  createdAt: Date;
}

/**
 * Single-use atomic bootstrap lock document in MongoDB.
 * Enforces strictly at most one initial platform SUPER_ADMIN bootstrap operation
 * across all concurrent requests and instances via unique _id constraint.
 */
const adminBootstrapLockSchema = new Schema<IAdminBootstrapLock>(
  {
    _id: {
      type: String,
      default: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
    },
    adminUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false, // PENDING স্টেটে এটি null/undefined থাকতে পারে
    },
    adminEmail: {
      type: String,
      required: false, // PENDING স্টেটে এটি null/undefined থাকতে পারে
      lowercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
      required: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
);

const AdminBootstrapLock = mongoose.model<IAdminBootstrapLock>(
  "AdminBootstrapLock",
  adminBootstrapLockSchema,
);

export default AdminBootstrapLock;