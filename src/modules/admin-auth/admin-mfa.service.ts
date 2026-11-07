import crypto from "node:crypto";
import type { Types } from "mongoose";
import AdminMfa, {
  type AdminMfaStatus,
  type IAdminMfa,
} from "./admin-mfa.model.js";
import User, { type UserDocument } from "../auth/user.model.js";
import { adminSecurityAuditService } from "./admin-security-audit.service.js";
import {
  buildProvisioningUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpRawSecret,
  hashRecoveryCode,
  verifyTotpToken,
} from "./admin-totp.util.js";
import { loadAdminMfaEnv, loadAdminSessionEnv } from "../../config/env.js";

export const MFA_ENROLLMENT_CLOCK_SKEW_MS = 60 * 1000;

export interface MfaServiceResult<T = Record<string, unknown>> {
  success: boolean;
  code?: string;
  message?: string;
  data?: T;
}

export interface StartMfaEnrollmentParams {
  adminUserId: string | Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
}

export interface ConfirmMfaEnrollmentParams {
  adminUserId: string | Types.ObjectId;
  token: string;
  enrollmentGeneration?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface VerifyMfaTokenParams {
  adminUserId: string | Types.ObjectId;
  token: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface VerifyMfaRecoveryCodeParams {
  adminUserId: string | Types.ObjectId;
  recoveryCode: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RegenerateRecoveryCodesParams {
  adminUserId: string | Types.ObjectId;
  token: string;
  ipAddress?: string;
  userAgent?: string;
}

type ValidatedAdminUser = UserDocument & { _id: Types.ObjectId };

export class AdminMfaService {
  /**
   * Authoritative User validation helper.
   */
  private async validateAuthoritativeAdminUser(
    adminUserId: string | Types.ObjectId,
  ): Promise<
    | { valid: true; user: ValidatedAdminUser }
    | { valid: false; code: string; message: string; user?: unknown }
  > {
    const user = await User.findById(adminUserId).exec();

    if (!user) {
      return {
        valid: false,
        code: "USER_NOT_FOUND",
        message: "Platform administrator account was not found",
      };
    }

    if (user.isActive !== true) {
      return {
        valid: false,
        code: "USER_INACTIVE",
        message: "Platform administrator account has been deactivated",
        user,
      };
    }

    if (
      user.platformRole !== "SUPER_ADMIN" &&
      user.platformRole !== "FINANCE_ADMIN"
    ) {
      return {
        valid: false,
        code: "ROLE_UNAUTHORIZED",
        message:
          "User does not possess an authorized platform administrator role",
        user,
      };
    }

    const sessionEnv = loadAdminSessionEnv();
    if (sessionEnv.ADMIN_REQUIRE_EMAIL_VERIFIED && user.isEmailVerified !== true) {
      return {
        valid: false,
        code: "EMAIL_UNVERIFIED",
        message: "Platform administrator email address must be verified",
        user,
      };
    }

    return { valid: true, user: user as unknown as ValidatedAdminUser };
  }

  /**
   * Starts TOTP MFA enrollment for an administrator.
   */
  async startMfaEnrollment({
    adminUserId,
    ipAddress,
    userAgent,
  }: StartMfaEnrollmentParams): Promise<
    MfaServiceResult<{
      provisioningUri: string;
      rawSecret: string;
      enrollmentGeneration: string;
    }>
  > {
    const userValidation = await this.validateAuthoritativeAdminUser(adminUserId);
    if (!userValidation.valid) {
      return {
        success: false,
        code: userValidation.code,
        message: userValidation.message,
      };
    }

    const { user } = userValidation;

    // Check if MFA is already active
    const existing = await AdminMfa.findOne({ adminUserId: user._id }).exec();
    if (existing && existing.status === "ACTIVE") {
      return {
        success: false,
        code: "MFA_ALREADY_ACTIVE",
        message:
          "MFA is already active for this administrator. Reset requires administrative verification.",
      };
    }

    const mfaEnv = loadAdminMfaEnv();
    const rawSecret = generateTotpRawSecret(20);
    const encryptedSecret = encryptTotpSecret(
      rawSecret,
      mfaEnv.ADMIN_MFA_ENCRYPTION_KEY,
    );
    const enrollmentGeneration = crypto.randomUUID();
    const now = new Date();

    try {
      await AdminMfa.findOneAndUpdate(
        { adminUserId: user._id, status: { $ne: "ACTIVE" } },
        {
          $set: {
            status: "PENDING",
            enrollmentGeneration,
            encryptedSecret,
            lastUsedTimeStep: 0,
            recoveryCodes: [],
            enrolledAt: now,
            confirmedAt: undefined,
            lastVerifiedAt: undefined,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === 11000
      ) {
        return {
          success: false,
          code: "MFA_ALREADY_ACTIVE",
          message:
            "MFA is already active for this administrator. Reset requires administrative verification.",
        };
      }
      throw err;
    }

    const provisioningUri = buildProvisioningUri({
      secretBase32: rawSecret,
      accountEmail: user.email,
      issuer: mfaEnv.ADMIN_MFA_ISSUER,
      digits: 6,
      period: mfaEnv.ADMIN_MFA_STEP_SECONDS,
    });

    adminSecurityAuditService.recordSecurityEvent({
      eventType: "MFA_ENROLLMENT_STARTED",
      adminUserId: user._id,
      adminEmail: user.email,
      ipAddress,
      userAgent,
      reason: "MFA enrollment started",
      metadata: { enrollmentGeneration },
    }).catch(Boolean);

    return {
      success: true,
      data: {
        provisioningUri,
        rawSecret,
        enrollmentGeneration,
      },
    };
  }

  /**
   * Confirms a pending MFA enrollment with a valid 6-digit TOTP token.
   */
  async confirmMfaEnrollment({
    adminUserId,
    token,
    enrollmentGeneration,
    ipAddress,
    userAgent,
  }: ConfirmMfaEnrollmentParams): Promise<
    MfaServiceResult<{
      recoveryCodes: string[];
    }>
  > {
    const userValidation = await this.validateAuthoritativeAdminUser(adminUserId);
    if (!userValidation.valid) {
      return {
        success: false,
        code: userValidation.code,
        message: userValidation.message,
      };
    }

    const { user } = userValidation;

    const mfaDoc = await AdminMfa.findOne({
      adminUserId: user._id,
      status: "PENDING",
    }).exec();

    if (!mfaDoc) {
      return {
        success: false,
        code: "NO_PENDING_ENROLLMENT",
        message: "No pending MFA enrollment found for this administrator",
      };
    }

    if (
      enrollmentGeneration &&
      mfaDoc.enrollmentGeneration &&
      mfaDoc.enrollmentGeneration !== enrollmentGeneration
    ) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "MFA_ENROLLMENT_REJECTED",
        adminUserId: user._id,
        adminEmail: user.email,
        ipAddress,
        userAgent,
        reason: "MFA enrollment generation mismatch: attempt to confirm superseded enrollment",
      }).catch(Boolean);

      return {
        success: false,
        code: "STALE_ENROLLMENT_GENERATION",
        message:
          "This MFA enrollment has been superseded by a newer setup request. Please use the latest QR code.",
      };
    }

    const mfaEnv = loadAdminMfaEnv();
    const now = Date.now();
    const maxPendingMs = mfaEnv.ADMIN_MFA_ENROLLMENT_EXPIRY_SECONDS * 1000;

    if (
      !mfaDoc.enrolledAt ||
      !(mfaDoc.enrolledAt instanceof Date) ||
      isNaN(mfaDoc.enrolledAt.getTime())
    ) {
      return {
        success: false,
        code: "INVALID_ENROLLMENT_TIMESTAMP",
        message: "MFA enrollment record contains an invalid or missing timestamp",
      };
    }

    const enrolledAt = mfaDoc.enrolledAt.getTime();

    if (enrolledAt > now + MFA_ENROLLMENT_CLOCK_SKEW_MS) {
      return {
        success: false,
        code: "FUTURE_ENROLLMENT_TIMESTAMP",
        message: "MFA enrollment timestamp is invalid (in the future beyond clock skew)",
      };
    }

    if (now - enrolledAt > maxPendingMs) {
      return {
        success: false,
        code: "ENROLLMENT_EXPIRED",
        message:
          "MFA enrollment session has expired. Please initiate enrollment again.",
      };
    }

    const rawSecret = decryptTotpSecret(
      mfaDoc.encryptedSecret,
      mfaEnv.ADMIN_MFA_ENCRYPTION_KEY,
    );

    const verifyResult = verifyTotpToken({
      secretBase32: rawSecret,
      token,
      stepSeconds: mfaEnv.ADMIN_MFA_STEP_SECONDS,
      driftWindows: mfaEnv.ADMIN_MFA_DRIFT_WINDOWS,
      lastUsedTimeStep: mfaDoc.lastUsedTimeStep,
    });

    if (!verifyResult.valid) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "MFA_ENROLLMENT_REJECTED",
        adminUserId: user._id,
        adminEmail: user.email,
        ipAddress,
        userAgent,
        reason: verifyResult.message || "Invalid confirmation code",
      }).catch(Boolean);

      return {
        success: false,
        code: verifyResult.code || "MFA_VERIFICATION_FAILED",
        message: verifyResult.message || "Invalid verification code",
      };
    }

    const { rawCodes, hashedCodes } = generateRecoveryCodes(10);
    const expiryThreshold = new Date(now - maxPendingMs);
    const maxFutureThreshold = new Date(now + MFA_ENROLLMENT_CLOCK_SKEW_MS);

    const updateFilter: Record<string, unknown> = {
      _id: mfaDoc._id,
      adminUserId: user._id,
      status: "PENDING",
      enrolledAt: { $gte: expiryThreshold, $lte: maxFutureThreshold },
    };

    if (enrollmentGeneration) {
      updateFilter.enrollmentGeneration = enrollmentGeneration;
    } else if (mfaDoc.enrollmentGeneration) {
      updateFilter.enrollmentGeneration = mfaDoc.enrollmentGeneration;
    }

    const updated = await AdminMfa.findOneAndUpdate(
      updateFilter,
      {
        $set: {
          status: "ACTIVE",
          confirmedAt: new Date(now),
          lastVerifiedAt: new Date(now),
          lastUsedTimeStep: verifyResult.timeStep!,
          recoveryCodes: hashedCodes,
        },
      },
      { new: true },
    ).exec();

    if (!updated) {
      return {
        success: false,
        code: "CONCURRENT_STATE_CHANGE",
        message:
          "MFA enrollment state changed concurrently or generation mismatch. Please try again.",
      };
    }

    adminSecurityAuditService.recordSecurityEvent({
      eventType: "MFA_ENROLLMENT_CONFIRMED",
      adminUserId: user._id,
      adminEmail: user.email,
      ipAddress,
      userAgent,
      reason: "MFA enrollment confirmed and active",
    }).catch(Boolean);

    return {
      success: true,
      data: {
        recoveryCodes: rawCodes,
      },
    };
  }

  /**
   * Verifies an active administrator's TOTP token.
   */
  async verifyMfaToken({
    adminUserId,
    token,
    ipAddress,
    userAgent,
  }: VerifyMfaTokenParams): Promise<MfaServiceResult<{ timeStep: number }>> {
    const userValidation = await this.validateAuthoritativeAdminUser(adminUserId);
    if (!userValidation.valid) {
      return {
        success: false,
        code: userValidation.code,
        message: userValidation.message,
      };
    }

    const { user } = userValidation;

    const mfaDoc = await AdminMfa.findOne({
      adminUserId: user._id,
      status: "ACTIVE",
    }).exec();

    if (!mfaDoc) {
      return {
        success: false,
        code: "MFA_NOT_CONFIGURED",
        message: "Active MFA is not configured for this administrator",
      };
    }

    const mfaEnv = loadAdminMfaEnv();
    const rawSecret = decryptTotpSecret(
      mfaDoc.encryptedSecret,
      mfaEnv.ADMIN_MFA_ENCRYPTION_KEY,
    );

    const verifyResult = verifyTotpToken({
      secretBase32: rawSecret,
      token,
      stepSeconds: mfaEnv.ADMIN_MFA_STEP_SECONDS,
      driftWindows: mfaEnv.ADMIN_MFA_DRIFT_WINDOWS,
      lastUsedTimeStep: mfaDoc.lastUsedTimeStep,
    });

    if (!verifyResult.valid) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "MFA_VERIFICATION_FAILED",
        adminUserId: user._id,
        adminEmail: user.email,
        ipAddress,
        userAgent,
        reason: verifyResult.message || "TOTP verification failed",
      }).catch(Boolean);

      return {
        success: false,
        code: verifyResult.code || "MFA_VERIFICATION_FAILED",
        message: verifyResult.message || "Invalid verification code",
      };
    }

    // Atomic durable replay guard
    const updated = await AdminMfa.findOneAndUpdate(
      {
        _id: mfaDoc._id,
        status: "ACTIVE",
        lastUsedTimeStep: { $lt: verifyResult.timeStep! },
      },
      {
        $set: {
          lastUsedTimeStep: verifyResult.timeStep!,
          lastVerifiedAt: new Date(),
        },
      },
      { new: true },
    ).exec();

    if (!updated) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "MFA_VERIFICATION_FAILED",
        adminUserId: user._id,
        adminEmail: user.email,
        ipAddress,
        userAgent,
        reason: "Replayed TOTP code or concurrent attempt rejected",
      }).catch(Boolean);

      return {
        success: false,
        code: "REPLAYED_CODE",
        message:
          "This TOTP code has already been consumed or time window expired",
      };
    }

    adminSecurityAuditService.recordSecurityEvent({
      eventType: "MFA_VERIFICATION_SUCCEEDED",
      adminUserId: user._id,
      adminEmail: user.email,
      ipAddress,
      userAgent,
      reason: "TOTP verification succeeded",
    }).catch(Boolean);

    return {
      success: true,
      data: {
        timeStep: verifyResult.timeStep!,
      },
    };
  }

  /**
   * Verifies and atomically consumes a single-use recovery code.
   */
  async verifyRecoveryCode({
    adminUserId,
    recoveryCode,
    ipAddress,
    userAgent,
  }: VerifyMfaRecoveryCodeParams): Promise<
    MfaServiceResult<{ remainingCodes: number }>
  > {
    const userValidation = await this.validateAuthoritativeAdminUser(adminUserId);
    if (!userValidation.valid) {
      return {
        success: false,
        code: userValidation.code,
        message: userValidation.message,
      };
    }

    const { user } = userValidation;
    const codeHash = hashRecoveryCode(recoveryCode);

    // Atomically find and mark the recovery code as consumed (safe against null/undefined)
    const updated = await AdminMfa.findOneAndUpdate(
      {
        adminUserId: user._id,
        status: "ACTIVE",
        recoveryCodes: {
          $elemMatch: {
            codeHash,
            usedAt: { $in: [null, undefined] },
          },
        },
      },
      {
        $set: {
          "recoveryCodes.$.usedAt": new Date(),
          lastVerifiedAt: new Date(),
        },
      },
      { new: true },
    ).exec();

    if (!updated) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "MFA_VERIFICATION_FAILED",
        adminUserId: user._id,
        adminEmail: user.email,
        ipAddress,
        userAgent,
        reason: "Recovery code is invalid or has already been used",
      }).catch(Boolean);

      return {
        success: false,
        code: "INVALID_RECOVERY_CODE",
        message: "Recovery code is invalid or has already been consumed",
      };
    }

    const remainingCodes = updated.recoveryCodes.filter(
      (c) => !c.usedAt,
    ).length;

    adminSecurityAuditService.recordSecurityEvent({
      eventType: "MFA_RECOVERY_CODE_USED",
      adminUserId: user._id,
      adminEmail: user.email,
      ipAddress,
      userAgent,
      reason: `Recovery code used (${remainingCodes} remaining)`,
    }).catch(Boolean);

    return {
      success: true,
      data: {
        remainingCodes,
      },
    };
  }

  /**
   * Regenerates a new set of 10 single-use recovery codes.
   */
  async regenerateRecoveryCodes({
    adminUserId,
    token,
    ipAddress,
    userAgent,
  }: RegenerateRecoveryCodesParams): Promise<
    MfaServiceResult<{ recoveryCodes: string[] }>
  > {
    const tokenVerification = await this.verifyMfaToken({
      adminUserId,
      token,
      ipAddress,
      userAgent,
    });

    if (!tokenVerification.success) {
      return {
        success: false,
        code: tokenVerification.code,
        message: tokenVerification.message,
      };
    }

    const user = await User.findById(adminUserId).exec();
    if (!user) {
      return {
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found",
      };
    }

    const { rawCodes, hashedCodes } = generateRecoveryCodes(10);

    const updated = await AdminMfa.findOneAndUpdate(
      { adminUserId: user._id, status: "ACTIVE" },
      {
        $set: {
          recoveryCodes: hashedCodes,
        },
      },
      { new: true },
    ).exec();

    if (!updated) {
      return {
        success: false,
        code: "MFA_NOT_ACTIVE",
        message: "MFA is not active",
      };
    }

    adminSecurityAuditService.recordSecurityEvent({
      eventType: "MFA_RECOVERY_CODES_REGENERATED",
      adminUserId: user._id,
      adminEmail: user.email,
      ipAddress,
      userAgent,
      reason: "10 new single-use recovery codes generated",
    }).catch(Boolean);

    return {
      success: true,
      data: {
        recoveryCodes: rawCodes,
      },
    };
  }

  /**
   * Queries the authoritative MFA status for an administrator.
   */
  async getMfaStatus(adminUserId: string | Types.ObjectId): Promise<{
    configured: boolean;
    status: AdminMfaStatus | "UNCONFIGURED";
    confirmedAt?: Date;
    remainingRecoveryCodes: number;
    pendingExpired?: boolean;
  }> {
    const doc = await AdminMfa.findOne({ adminUserId }).exec();
    if (!doc) {
      return {
        configured: false,
        status: "UNCONFIGURED",
        remainingRecoveryCodes: 0,
        pendingExpired: false,
      };
    }

    const remainingRecoveryCodes = doc.recoveryCodes.filter(
      (c) => !c.usedAt,
    ).length;

    const mfaEnv = loadAdminMfaEnv();
    const maxPendingMs = mfaEnv.ADMIN_MFA_ENROLLMENT_EXPIRY_SECONDS * 1000;
    const isPendingExpired =
      doc.status === "PENDING" &&
      (!doc.enrolledAt ||
        isNaN(doc.enrolledAt.getTime()) ||
        doc.enrolledAt.getTime() > Date.now() + MFA_ENROLLMENT_CLOCK_SKEW_MS ||
        Date.now() - doc.enrolledAt.getTime() > maxPendingMs);

    return {
      configured: doc.status === "ACTIVE",
      status: doc.status,
      confirmedAt: doc.confirmedAt,
      remainingRecoveryCodes,
      pendingExpired: isPendingExpired,
    };
  }
}

export const adminMfaService = new AdminMfaService();