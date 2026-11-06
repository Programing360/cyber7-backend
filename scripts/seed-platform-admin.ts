/**
 * Secure Platform Admin Provisioning Script
 *
 * Usage:
 *   PLATFORM_ADMIN_PROVISION_SECRET="<your-secure-secret>" \
 *   npx tsx scripts/seed-platform-admin.ts <target-user-email>
 *
 * Requirements:
 * 1. The target user must already exist in MongoDB (registered via standard flow).
 * 2. PLATFORM_ADMIN_PROVISION_SECRET must match the configured environment variable.
 * 3. Idempotent: safe to run multiple times.
 * 4. Never exposes credentials or secrets in output.
 */

import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import User from "../src/modules/auth/user.model.js";
import AdminBootstrapLock from "../src/modules/admin-auth/admin-bootstrap.model.js";

async function provisionPlatformAdmin() {
  const email = process.argv[2]?.trim().toLowerCase();
  const providedSecret = process.env.PLATFORM_ADMIN_PROVISION_SECRET;
  const configuredSecret = process.env.INTERNAL_PLATFORM_PROVISION_KEY || process.env.PLATFORM_ADMIN_SECRET;

  if (!email || !email.includes("@")) {
    console.error("Error: Please provide a valid email address as the first argument.");
    console.error("Usage: npx tsx scripts/seed-platform-admin.ts <user@example.com>");
    process.exit(1);
  }

  if (!providedSecret || !configuredSecret) {
    console.error("Error: Unauthorized. PLATFORM_ADMIN_PROVISION_SECRET is invalid or missing.");
    process.exit(1);
  }

  const expectedBuf = Buffer.from(configuredSecret, "utf8");
  const providedBuf = Buffer.from(providedSecret, "utf8");

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    console.error("Error: Unauthorized. PLATFORM_ADMIN_PROVISION_SECRET mismatch.");
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Error: MONGODB_URI is not set in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  try {
    const existingSuperAdmins = await User.countDocuments({
      platformRole: "SUPER_ADMIN",
    }).exec();

    if (existingSuperAdmins > 0) {
      console.error("Error: Platform super admin has already been provisioned. Repeated bootstrap is prohibited.");
      process.exit(1);
    }

    const user = await User.findOne({ email });
    if (!user) {
      console.error(`Error: User with email '${email}' was not found in the database.`);
      console.error("The account must be registered first before receiving administrative privileges.");
      process.exit(1);
    }

    if (!user.isActive) {
      console.error("Error: Target account is deactivated and cannot be promoted.");
      process.exit(1);
    }

    // Atomically claim the unique bootstrap lock
    try {
      await AdminBootstrapLock.create({
        _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
        adminUserId: user._id,
        adminEmail: user.email,
        status: "COMPLETED",
        completedAt: new Date(),
        createdAt: new Date(),
      });
    } catch (lockErr: any) {
      if (lockErr?.code === 11000) {
        console.error("Error: Bootstrap lock already acquired. Super admin bootstrap has already completed.");
        process.exit(1);
      }
      throw lockErr;
    }

    user.platformRole = "SUPER_ADMIN";
    await user.save();

    console.log(`Successfully provisioned '${email}' with platform role 'SUPER_ADMIN'.`);
  } finally {
    await mongoose.disconnect();
  }
}

provisionPlatformAdmin().catch((err) => {
  console.error("Fatal error during provisioning:", err instanceof Error ? err.message : err);
  process.exit(1);
});

