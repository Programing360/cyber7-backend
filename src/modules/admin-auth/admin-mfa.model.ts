import crypto from "node:crypto";
import mongoose, { Schema, type Document, type Types } from "mongoose";

export type AdminMfaStatus = "PENDING" | "ACTIVE" | "DISABLED";

export interface IAdminMfaRecoveryCode {
  codeHash: string;
  usedAt?: Date | null;
}

export interface IAdminMfa extends Document {
  _id: Types.ObjectId;
  adminUserId: Types.ObjectId;
  status: AdminMfaStatus;
  enrollmentGeneration: string;
  encryptedSecret: string;
  lastUsedTimeStep: number;
  recoveryCodes: IAdminMfaRecoveryCode[];
  enrolledAt: Date;
  confirmedAt?: Date;
  lastVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const recoveryCodeSchema = new Schema<IAdminMfaRecoveryCode>(
  {
    codeHash: {
      type: String,
      required: true,
      trim: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
    versionKey: false,
  },
);

const adminMfaSchema = new Schema<IAdminMfa>(
  {
    adminUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // স্বয়ংক্রিয়ভাবে একটি ইউনিক ইনডেক্স তৈরি করে
    },
    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "DISABLED"],
      default: "PENDING",
      required: true,
    },
    enrollmentGeneration: {
      type: String,
      default: () => crypto.randomUUID(),
      required: true,
    },
    encryptedSecret: {
      type: String,
      required: true,
      trim: true,
    },
    lastUsedTimeStep: {
      type: Number,
      default: 0,
      required: true,
    },
    recoveryCodes: {
      type: [recoveryCodeSchema],
      default: [],
    },
    enrolledAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    confirmedAt: {
      type: Date,
    },
    lastVerifiedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ==========================================
// HIGH-PERFORMANCE COMPOUND INDEXES
// ==========================================

// ১. ইউজারের স্ট্যাটাস ভিত্তিক লুকআপ
adminMfaSchema.index({ adminUserId: 1, status: 1 });

// ২. ইউজারের নির্দিষ্ট অব্যবহৃত রিকভারি কোড মেলাতে অপ্টিমাইজড ইনডেক্স
adminMfaSchema.index({
  adminUserId: 1,
  status: 1,
  "recoveryCodes.codeHash": 1,
});

const AdminMfa = mongoose.model<IAdminMfa>("AdminMfa", adminMfaSchema);

export default AdminMfa;