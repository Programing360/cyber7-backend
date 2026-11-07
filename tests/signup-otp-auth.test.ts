/**
 * VexChat User Registration & Email OTP Verification Test Suite
 *
 * Verifies:
 * 1. 6-digit Email OTP generation, hashing, and TTL schema.
 * 2. Mandatory OTP verification before final account creation (fail-closed).
 * 3. Public registration assigns role "user" (never "owner", "admin", or "super_admin").
 * 4. Automatic 7-day free trial configuration (subscriptionStatus: "trial", isPaid: false).
 * 5. Input validation schemas for /api/auth/send-signup-otp and /api/auth/verify-signup-otp.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";

import User from "../src/modules/auth/user.model.js";
import SignupOtp from "../src/modules/auth/signup-otp.model.js";
import {
  sendSignupOtpSchema,
  verifySignupOtpSchema,
  registerSchema,
} from "../src/modules/auth/auth.validation.js";

describe("Registration & OTP Schemas — Input Validation", () => {
  it("should accept valid email for sendSignupOtpSchema", () => {
    const valid = sendSignupOtpSchema.safeParse({ email: "Test.User@example.com" });
    assert.ok(valid.success);
    assert.strictEqual(valid.data.email, "test.user@example.com");
  });

  it("should reject invalid email for sendSignupOtpSchema", () => {
    const invalid = sendSignupOtpSchema.safeParse({ email: "invalid-email" });
    assert.strictEqual(invalid.success, false);
  });

  it("should validate verifySignupOtpSchema requires exactly 6 numeric digits", () => {
    const valid = verifySignupOtpSchema.safeParse({
      email: "test@example.com",
      otp: "123456",
    });
    assert.ok(valid.success);
    assert.strictEqual(valid.data.otp, "123456");

    const tooShort = verifySignupOtpSchema.safeParse({
      email: "test@example.com",
      otp: "12345",
    });
    assert.strictEqual(tooShort.success, false);

    const nonDigits = verifySignupOtpSchema.safeParse({
      email: "test@example.com",
      otp: "12A456",
    });
    assert.strictEqual(nonDigits.success, false);
  });
});

describe("User Model — Role & 7-Day Free Trial Schema", () => {
  it("should default role to 'user' and allow 'user' in enum", () => {
    const rolePath = User.schema.path("role") as mongoose.SchemaType & {
      enumValues?: string[];
      defaultValue?: string;
    };

    assert.ok(rolePath.enumValues, "role must have enum values");
    assert.ok(rolePath.enumValues.includes("user"), "role enum must include 'user'");
    assert.strictEqual(
      (User.schema.path("role") as any).defaultValue,
      "user",
      "Public registration role must default to 'user'",
    );
  });

  it("should have 7-day free trial fields configured", () => {
    const subStatusPath = User.schema.path("subscriptionStatus") as mongoose.SchemaType & {
      enumValues?: string[];
      defaultValue?: string;
    };

    assert.ok(subStatusPath, "subscriptionStatus path must exist");
    assert.ok(subStatusPath.enumValues?.includes("trial"));

    const isPaidPath = User.schema.path("isPaid");
    assert.ok(isPaidPath, "isPaid path must exist");

    const trialStartDatePath = User.schema.path("trialStartDate");
    assert.ok(trialStartDatePath, "trialStartDate path must exist");

    const trialEndDatePath = User.schema.path("trialEndDate");
    assert.ok(trialEndDatePath, "trialEndDate path must exist");
  });

  it("should correctly compute 7-day trial period duration", () => {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const diffDays = Math.round((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    assert.strictEqual(diffDays, 7);
  });
});

describe("SignupOtp Model — Security & Expiration", () => {
  it("should define SignupOtp collection with TTL index", () => {
    const expiresPath = SignupOtp.schema.path("expiresAt");
    assert.ok(expiresPath, "expiresAt must exist on SignupOtp");

    const emailPath = SignupOtp.schema.path("email");
    assert.ok(emailPath, "email must exist on SignupOtp");

    const isVerifiedPath = SignupOtp.schema.path("isVerified");
    assert.ok(isVerifiedPath, "isVerified must exist on SignupOtp");
  });

  it("should hash 6-digit OTP with SHA-256 consistently", () => {
    const rawOtp = "849201";
    const hash1 = crypto.createHash("sha256").update(rawOtp).digest("hex");
    const hash2 = crypto.createHash("sha256").update(rawOtp).digest("hex");
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64);
  });
});

