import mongoose, { Schema, type InferSchemaType } from "mongoose";

const adminEmailOtpSchema = new Schema(
  {
    codeHash: {
      type: String,
      required: true,
      trim: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL ইনডেক্স: মেয়াদ শেষ হলে স্বয়ংক্রিয়ভাবে ফিল্ড ক্লিন করবে
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
  },
  {
    _id: false,
    versionKey: false,
  },
);

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [100, "Name cannot exceed 100 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      select: false,
    },

    role: {
      type: String,
      enum: ["OWNER", "ADMIN", "AGENT"],
      default: "OWNER",
    },

    platformRole: {
      type: String,
      enum: ["USER", "FINANCE_ADMIN", "SUPER_ADMIN"],
      default: "USER",
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    displayName: {
      type: String,
      trim: true,
      maxlength: [100, "Display name cannot exceed 100 characters"],
      default: "",
    },

    phoneNumber: {
      type: String,
      trim: true,
      maxlength: [35, "Phone number cannot exceed 35 characters"],
      default: "",
    },

    jobTitle: {
      type: String,
      trim: true,
      maxlength: [100, "Job title cannot exceed 100 characters"],
      default: "Operations & Growth Lead",
    },

    bio: {
      type: String,
      trim: true,
      maxlength: [500, "Bio cannot exceed 500 characters"],
      default: "",
    },

    timezone: {
      type: String,
      trim: true,
      default: "Asia/Dhaka",
    },

    avatarUrl: {
      type: String,
      trim: true,
      default: "",
    },

    bannerTheme: {
      type: String,
      trim: true,
      default: "aurora",
    },

    customStatus: {
      type: String,
      trim: true,
      default: "Focusing on automations",
    },

    customStatusEmoji: {
      type: String,
      trim: true,
      default: "🚀",
    },

    isAvailable: {
      type: Boolean,
      default: true,
    },

    notifications: {
      type: new Schema(
        {
          whatsappInbound: { type: Boolean, default: true },
          campaignDeliveries: { type: Boolean, default: true },
          templateApprovals: { type: Boolean, default: true },
          weeklyDigest: { type: Boolean, default: false },
          securityAlerts: { type: Boolean, default: true },
          soundEffects: { type: Boolean, default: true },
        },
        { _id: false },
      ),
      default: () => ({
        whatsappInbound: true,
        campaignDeliveries: true,
        templateApprovals: true,
        weeklyDigest: false,
        securityAlerts: true,
        soundEffects: true,
      }),
    },

    // প্ল্যাটফর্ম অ্যাডমিনের ইমেইল টু-ফ্যাক্টর অথেনটিকেশন ওটিপি স্টেট
    adminEmailOtp: {
      type: adminEmailOtpSchema,
      default: undefined,
      select: false, // ডিফল্ট কুয়েরিতে ওটিপি ডাটা গোপন রাখা নিরাপদ
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

/**
 * SEC-04 Database-Level Guard: Enforce at most one SUPER_ADMIN account
 * across the entire User collection via MongoDB partial unique index.
 */
userSchema.index(
  { platformRole: 1 },
  {
    unique: true,
    partialFilterExpression: { platformRole: "SUPER_ADMIN" },
  },
);

export type UserDocument = InferSchemaType<typeof userSchema> & {
  _id: mongoose.Types.ObjectId;
};

const User = mongoose.model("User", userSchema);

export default User;
