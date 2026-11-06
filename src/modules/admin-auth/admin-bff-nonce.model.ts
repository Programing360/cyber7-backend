import mongoose, { Schema, type Document } from "mongoose";

export interface IAdminBffNonce extends Document {
  jti: string;
  expiresAt: Date;
  createdAt: Date;
}

const adminBffNonceSchema = new Schema<IAdminBffNonce>(
  {
    jti: {
      type: String,
      required: true,
      unique: true, // এটি স্বয়ংক্রিয়ভাবে একটি ইউনিক ইনডেক্স তৈরি করে (ডুপ্লিকেট index: true দরকার নেই)
      trim: true,
    },
    expiresAt: {
      type: Date,
      required: true,
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

// TTL index: মেয়াদ শেষ হওয়ার পর MongoDB ব্যাকগ্রাউন্ডে স্বয়ংক্রিয়ভাবে ডিলিট করবে
adminBffNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AdminBffNonce = mongoose.model<IAdminBffNonce>(
  "AdminBffNonce",
  adminBffNonceSchema,
);

export class BffNonceStorageError extends Error {
  constructor(
    message = "Durable replay protection persistence store is unavailable",
  ) {
    super(message);
    this.name = "BffNonceStorageError";
  }
}

/**
 * Atomically records an assertion ID (jti) to guarantee strict single-use replay protection.
 * Returns false if the nonce has already been consumed (replay rejected).
 */
export async function consumeBffAssertionJti(
  jti: string,
  expiresAt: Date,
): Promise<boolean> {
  const cleanJti = jti.trim();

  // SEC-06: Strict durable persistence requirement (Fail-closed)
  if (mongoose.connection.readyState !== 1) {
    throw new BffNonceStorageError();
  }

  try {
    await AdminBffNonce.create({
      jti: cleanJti,
      expiresAt,
    });
    return true;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === 11000
    ) {
      return false; // ডুপ্লিকেট কি = রিপ্লে অ্যাটাক ডিটেক্টেড
    }
    throw new BffNonceStorageError();
  }
}

export default AdminBffNonce;