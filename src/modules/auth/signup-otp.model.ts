import mongoose, { Schema, type InferSchemaType } from "mongoose";

const signupOtpSchema = new Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    codeHash: {
      type: String,
      required: true,
      trim: true,
    },
    // রেজিস্ট্রেশনের প্রাথমিক ডাটা ওটিপি ভেরিফিকেশনের জন্য ক্যাশ রাখা
    tempRegistrationData: {
      name: { type: String, required: true, trim: true },
      phoneNumber: { type: String, required: true, trim: true },
      passwordHash: { type: String, required: true },
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL: ১০ মিনিট পর অটো ডিলিট হবে
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export type SignupOtpDocument = InferSchemaType<typeof signupOtpSchema>;

export const SignupOtp =
  mongoose.models.SignupOtp || mongoose.model("SignupOtp", signupOtpSchema);

export default SignupOtp;
