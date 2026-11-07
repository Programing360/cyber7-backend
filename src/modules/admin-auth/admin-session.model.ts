import mongoose, { Schema, type Document, type Types } from "mongoose";

export type AdminSessionStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface IAdminSession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  status: AdminSessionStatus;
  createdAt: Date;
  lastActivityAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  lastAuthenticatedAt: Date;
  createdFromIp: string | null;
  userAgent: string | null;
  archiveTtlAt: Date; // TTL ক্লিনআপের জন্য
}

const adminSessionSchema = new Schema<IAdminSession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required"],
    },
    tokenHash: {
      type: String,
      required: [true, "tokenHash is required"],
      unique: true, // এটি নিজেই ইউনিক B-tree ইনডেক্স তৈরি করে
      trim: true,
      match: [
        /^[0-9a-fA-F]{64}$/,
        "tokenHash must be a 64-character SHA-256 hex string",
      ],
    },
    status: {
      type: String,
      enum: ["ACTIVE", "REVOKED", "EXPIRED"],
      default: "ACTIVE",
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    idleExpiresAt: {
      type: Date,
      required: [true, "idleExpiresAt is required"],
    },
    absoluteExpiresAt: {
      type: Date,
      required: [true, "absoluteExpiresAt is required"],
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revocationReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 255,
    },
    lastAuthenticatedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    createdFromIp: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    userAgent: {
      type: String,
      default: null,
      trim: true,
      maxlength: 512,
    },
    archiveTtlAt: {
      type: Date,
      default: function (this: IAdminSession) {
        // Absolute expiry-র ৩০ দিন পর স্বয়ংক্রিয়ভাবে ডাটাবেজ থেকে মুছে যাবে
        return new Date(
          this.absoluteExpiresAt.getTime() + 30 * 24 * 60 * 60 * 1000,
        );
      },
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
);

// =====================================================
// PRODUCTION OPTIMIZED COMPOUND INDEXES
// =====================================================

// ১. কোনো ইউজারের সব সক্রিয় সেশন বাতিল বা খোঁজার জন্য (Logout All, Role Demotion)
adminSessionSchema.index({ userId: 1, status: 1 });

// ২. সেশন টাচ এবং কনকারেন্ট স্লাইডিং এক্সপায়ারি আপডেট করার জন্য
adminSessionSchema.index({
  _id: 1,
  status: 1,
  idleExpiresAt: 1,
  absoluteExpiresAt: 1,
});

// ৩. মেয়াদোত্তীর্ণ সেশন ব্যাকগ্রাউন্ডে খোঁজার জন্য
adminSessionSchema.index({ status: 1, idleExpiresAt: 1 });
adminSessionSchema.index({ status: 1, absoluteExpiresAt: 1 });

// ৪. স্বয়ংক্রিয় ডাটাবেজ ক্লিনআপ (MongoDB background TTL)
adminSessionSchema.index({ archiveTtlAt: 1 }, { expireAfterSeconds: 0 });

const AdminSession = mongoose.model<IAdminSession>(
  "AdminSession",
  adminSessionSchema,
);

export default AdminSession;
