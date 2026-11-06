import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Types } from "mongoose";
import User, { type UserDocument } from "../auth/user.model.js";
import AdminBootstrapLock from "./admin-bootstrap.model.js";
import { adminSessionService } from "./admin-session.service.js";
import { adminMfaService } from "./admin-mfa.service.js";
import { adminSecurityAuditService } from "./admin-security-audit.service.js";
import { loadAdminBffEnv, loadAdminSessionEnv } from "../../config/env.js";
import {
  buildAdminCookieOptions,
  clearAdminCookieOptions,
} from "./admin-cookie.util.js";

export interface AdminAuthResult<T = unknown> {
  success: boolean;
  code?: string;
  message?: string;
  data?: T;
  rawToken?: string;
  challengeToken?: string;
  adminUser?: UserDocument & { _id: Types.ObjectId };
  cookieOptions?: {
    name: string;
    options: ReturnType<typeof buildAdminCookieOptions>;
  };
}

/**
 * Creates a cryptographically signed, short-lived MFA challenge token.
 * Token format: v1.mfa.<userId>.<expiryMs>.<signatureHex>
 */
export function createMfaChallengeToken(
  userId: string | Types.ObjectId,
  ttlMs: number = 5 * 60 * 1000,
): string {
  const bffEnv = loadAdminBffEnv();
  const exp = Date.now() + ttlMs;
  const payloadStr = `v1.mfa.${String(userId)}.${exp}`;

  const sig = crypto
    .createHmac("sha256", bffEnv.ADMIN_BFF_SECRET)
    .update(payloadStr)
    .digest("hex");

  return `${payloadStr}.${sig}`;
}

/**
 * Validates a signed MFA challenge token safely against timing attacks.
 */
export function verifyMfaChallengeToken(token: string): {
  valid: boolean;
  userId?: string;
  code?: string;
  message?: string;
} {
  if (!token || typeof token !== "string") {
    return {
      valid: false,
      code: "INVALID_CHALLENGE",
      message: "Missing challenge token",
    };
  }

  const delimiter = token.includes(".") ? "." : ":";
  const parts = token.split(delimiter);

  if (parts.length !== 5 || parts[0] !== "v1" || parts[1] !== "mfa") {
    return {
      valid: false,
      code: "MALFORMED_CHALLENGE",
      message: "Malformed challenge token",
    };
  }

  const [, , userId, expStr, providedSig] = parts;
  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Date.now() > exp) {
    return {
      valid: false,
      code: "EXPIRED_CHALLENGE",
      message: "MFA challenge token has expired",
    };
  }

  const bffEnv = loadAdminBffEnv();
  const payloadStr = `v1${delimiter}mfa${delimiter}${userId}${delimiter}${expStr}`;
  const expectedSig = crypto
    .createHmac("sha256", bffEnv.ADMIN_BFF_SECRET)
    .update(payloadStr)
    .digest("hex");

  const expectedBuf = Buffer.from(expectedSig, "utf8");
  const providedBuf = Buffer.from(providedSig, "utf8");

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return {
      valid: false,
      code: "INVALID_CHALLENGE_SIGNATURE",
      message: "Invalid challenge signature",
    };
  }

  return { valid: true, userId };
}

export class AdminAuthService {
  /**
   * Validates platform administrator credentials, status, and role prior to OTP dispatch.
   */
  async validateAdminCredentials({
    email,
    password,
    ipAddress,
    userAgent,
  }: {
    email: string;
    password?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AdminAuthResult> {
    if (!email || !password) {
      return {
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Email and password are required",
      };
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail })
      .select("+password")
      .exec();

    if (!user || !user.password) {
      await bcrypt.compare(
        password,
        "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456",
      );
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminEmail: cleanEmail,
          ipAddress,
          userAgent,
          reason: "INVALID_CREDENTIALS: User not found",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid administrator email or password",
      };
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminUserId: user._id,
          adminEmail: user.email,
          ipAddress,
          userAgent,
          reason: "INVALID_CREDENTIALS: Password mismatch",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid administrator email or password",
      };
    }

    if (!user.isActive) {
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminUserId: user._id,
          adminEmail: user.email,
          ipAddress,
          userAgent,
          reason: "USER_INACTIVE: Inactive admin login attempt",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "USER_INACTIVE",
        message: "Administrator account is deactivated",
      };
    }

    if (
      user.platformRole !== "SUPER_ADMIN" &&
      user.platformRole !== "FINANCE_ADMIN"
    ) {
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminUserId: user._id,
          adminEmail: user.email,
          ipAddress,
          userAgent,
          reason: `ROLE_UNAUTHORIZED: Role '${user.platformRole}' attempted platform admin login`,
        })
        .catch(Boolean);

      return {
        success: false,
        code: "UNAUTHORIZED_ADMIN_ROLE",
        message: "Account does not possess platform administrator privileges",
      };
    }

    const sessionEnv = loadAdminSessionEnv();
    if (sessionEnv.ADMIN_REQUIRE_EMAIL_VERIFIED && !user.isEmailVerified) {
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminUserId: user._id,
          adminEmail: user.email,
          ipAddress,
          userAgent,
          reason: "EMAIL_NOT_VERIFIED: Administrator email not verified",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Administrator email must be verified prior to login",
      };
    }

    const challengeToken = createMfaChallengeToken(user._id);

    return {
      success: true,
      challengeToken,
      adminUser: user as UserDocument & { _id: Types.ObjectId },
    };
  }

  /**
   * Secure Initial Platform Admin Bootstrap.
   */
  async bootstrapPlatformAdmin({
    email,
    bootstrapSecret,
    ipAddress,
    userAgent,
  }: {
    email: string;
    bootstrapSecret: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AdminAuthResult> {
    const bffEnv = loadAdminBffEnv();

    if (!bffEnv.PLATFORM_ADMIN_BOOTSTRAP_ENABLED) {
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminEmail: email,
          ipAddress,
          userAgent,
          reason: "BOOTSTRAP_DISABLED: Bootstrap endpoint is disabled",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "BOOTSTRAP_DISABLED",
        message: "Platform admin bootstrap is disabled in this environment",
      };
    }

    const configuredSecret = bffEnv.PLATFORM_ADMIN_BOOTSTRAP_SECRET;
    if (!configuredSecret || !bootstrapSecret) {
      return {
        success: false,
        code: "UNAUTHORIZED_BOOTSTRAP",
        message: "Invalid bootstrap secret",
      };
    }

    const providedBuf = Buffer.from(bootstrapSecret, "utf8");
    const configuredBuf = Buffer.from(configuredSecret, "utf8");
    if (
      providedBuf.length !== configuredBuf.length ||
      !crypto.timingSafeEqual(providedBuf, configuredBuf)
    ) {
      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "AUTHENTICATION_REJECTED",
          adminEmail: email,
          ipAddress,
          userAgent,
          reason: "INVALID_BOOTSTRAP_SECRET: Secret mismatch",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "UNAUTHORIZED_BOOTSTRAP",
        message: "Invalid bootstrap secret",
      };
    }

    try {
      await AdminBootstrapLock.create({
        _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
        status: "PENDING",
        createdAt: new Date(),
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === 11000
      ) {
        const superAdminsCount = await User.countDocuments({
          platformRole: "SUPER_ADMIN",
        }).exec();

        if (superAdminsCount === 0) {
          await AdminBootstrapLock.deleteOne({
            _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
          });
          await AdminBootstrapLock.create({
            _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
            status: "PENDING",
            createdAt: new Date(),
          });
        } else {
          adminSecurityAuditService
            .recordSecurityEvent({
              eventType: "AUTHENTICATION_REJECTED",
              adminEmail: email,
              ipAddress,
              userAgent,
              reason:
                "BOOTSTRAP_ALREADY_COMPLETED: Re-bootstrap rejected by lock",
            })
            .catch(Boolean);

          return {
            success: false,
            code: "BOOTSTRAP_ALREADY_COMPLETED",
            message: "Platform super admin has already been provisioned.",
          };
        }
      } else {
        throw err;
      }
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail }).exec();
    if (!user) {
      await AdminBootstrapLock.deleteOne({
        _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
      }).catch(Boolean);
      return {
        success: false,
        code: "USER_NOT_FOUND",
        message: `Account '${cleanEmail}' must be registered before receiving administrative privileges.`,
      };
    }

    if (!user.isActive) {
      await AdminBootstrapLock.deleteOne({
        _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
      }).catch(Boolean);
      return {
        success: false,
        code: "USER_INACTIVE",
        message: "Target account is deactivated and cannot be promoted.",
      };
    }

    const sessionEnv = loadAdminSessionEnv();
    if (sessionEnv.ADMIN_REQUIRE_EMAIL_VERIFIED && !user.isEmailVerified) {
      await AdminBootstrapLock.deleteOne({
        _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
      }).catch(Boolean);
      return {
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message:
          "Target account email must be verified prior to administrative promotion.",
      };
    }

    try {
      user.platformRole = "SUPER_ADMIN";
      await user.save();

      await AdminBootstrapLock.updateOne(
        { _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP" },
        {
          $set: {
            adminUserId: user._id,
            adminEmail: user.email,
            status: "COMPLETED",
            completedAt: new Date(),
          },
        },
      );
    } catch (saveErr) {
      const countAfterFailure = await User.countDocuments({
        platformRole: "SUPER_ADMIN",
      }).exec();

      if (countAfterFailure === 0) {
        await AdminBootstrapLock.deleteOne({
          _id: "INITIAL_SUPER_ADMIN_BOOTSTRAP",
        }).catch(Boolean);
      }
      throw saveErr;
    }

    adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "SESSION_CREATED",
        adminUserId: user._id,
        adminEmail: user.email,
        ipAddress,
        userAgent,
        reason:
          "SUPER_ADMIN_BOOTSTRAP_SUCCESSFUL: Initial platform administrator provisioned",
      })
      .catch(Boolean);

    return {
      success: true,
      code: "BOOTSTRAP_SUCCESSFUL",
      message: `Successfully provisioned initial SUPER_ADMIN for '${cleanEmail}'`,
      data: {
        email: user.email,
        platformRole: user.platformRole,
      },
    };
  }

  /**
   * Completes direct session establishment after successful OTP verification.
   */
  async completeChallengeSession({
    userId,
    ipAddress,
    userAgent,
  }: {
    userId: string | Types.ObjectId;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AdminAuthResult> {
    const user = await User.findById(userId).exec();
    if (!user || !user.isActive) {
      return {
        success: false,
        code: "USER_INACTIVE",
        message: "Administrator account is inactive",
      };
    }

    if (
      user.platformRole !== "SUPER_ADMIN" &&
      user.platformRole !== "FINANCE_ADMIN"
    ) {
      return {
        success: false,
        code: "UNAUTHORIZED_ADMIN_ROLE",
        message: "Account does not possess platform administrator privileges",
      };
    }

    return this.createAdminSessionAndCookie(
      user as UserDocument & { _id: Types.ObjectId },
      ipAddress,
      userAgent,
    );
  }

  /**
   * Revokes the active AdminSession and returns cookie clearing headers.
   */
  async logout({
    sessionId,
    ipAddress,
    userAgent,
  }: {
    sessionId: string | Types.ObjectId;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AdminAuthResult> {
    try {
      await adminSessionService.revokeAdminSession(sessionId, "ADMIN_LOGOUT");
    } catch {
      // Ignore if session not found or already revoked
    }

    const sessionEnv = loadAdminSessionEnv();
    const isProd =
      (sessionEnv.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() ===
      "production";

    return {
      success: true,
      cookieOptions: {
        name: sessionEnv.ADMIN_SESSION_COOKIE_NAME,
        options: clearAdminCookieOptions(isProd),
      },
      message: "Administrator session terminated successfully",
    };
  }

  /**
   * Helper to create an AdminSession and construct secure cookie options.
   */
  private async createAdminSessionAndCookie(
    user: UserDocument & { _id: Types.ObjectId },
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AdminAuthResult> {
    try {
      const sessionResult = await adminSessionService.createAdminSession({
        userId: user._id,
        ip: ipAddress,
        userAgent,
      });

      const sessionEnv = loadAdminSessionEnv();
      const isProd =
        (sessionEnv.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() ===
        "production";

      const cookieOptions = buildAdminCookieOptions(
        sessionResult.session.absoluteExpiresAt,
        sessionResult.session.idleExpiresAt,
        isProd,
      );

      return {
        success: true,
        rawToken: sessionResult.rawToken,
        cookieOptions: {
          name: sessionEnv.ADMIN_SESSION_COOKIE_NAME,
          options: cookieOptions,
        },
        data: {
          user: {
            id: String(user._id),
            email: user.email,
            name: user.name,
            platformRole: user.platformRole,
          },
          session: {
            id: String(sessionResult.session._id),
            idleExpiresAt: sessionResult.session.idleExpiresAt,
            absoluteExpiresAt: sessionResult.session.absoluteExpiresAt,
          },
        },
      };
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : "Failed to create administrator session";
      return {
        success: false,
        code: "SESSION_CREATION_FAILED",
        message: errorMsg,
      };
    }
  }
}

export const adminAuthService = new AdminAuthService();
