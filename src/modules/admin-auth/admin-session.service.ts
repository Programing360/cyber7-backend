import type { ClientSession, Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import { loadAdminSessionEnv } from "../../config/env.js";
import User, { type UserDocument } from "../auth/user.model.js";
import AdminSession, {
  type AdminSessionStatus,
  type IAdminSession,
} from "./admin-session.model.js";
import {
  generateAdminRawToken,
  hashAdminToken,
  sanitizeIp,
  sanitizeUserAgent,
} from "./admin-token.util.js";
import { adminSecurityAuditService } from "./admin-security-audit.service.js";

export type AdminAuthenticationErrorCode =
  | "INVALID_TOKEN_FORMAT"
  | "SESSION_NOT_FOUND"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "SESSION_EXPIRED_IDLE"
  | "SESSION_EXPIRED_ABSOLUTE"
  | "USER_INACTIVE"
  | "ROLE_UNAUTHORIZED"
  | "EMAIL_UNVERIFIED";

export interface AdminAuthenticationSuccess {
  success: true;
  session: IAdminSession;
  user: UserDocument & { _id: Types.ObjectId };
}

export interface AdminAuthenticationFailure {
  success: false;
  code: AdminAuthenticationErrorCode;
  message: string;
  session?: IAdminSession | null;
}

export type AdminAuthenticationResult =
  | AdminAuthenticationSuccess
  | AdminAuthenticationFailure;

export interface CreateAdminSessionParams {
  userId: string | Types.ObjectId;
  ip?: string;
  userAgent?: string;
  session?: ClientSession;
}

export class AdminSessionService {
  /**
   * Creates a dedicated AdminSession for a verified platform administrator.
   */
  public async createAdminSession(
    params: CreateAdminSessionParams,
  ): Promise<{ session: IAdminSession; rawToken: string }> {
    const { userId, ip, userAgent, session: clientSession } = params;

    const user = await User.findById(userId).session(clientSession ?? null);
    if (!user) {
      throw new AppError("Administrator user not found", 404, "USER_NOT_FOUND");
    }

    if (!user.isActive) {
      throw new AppError(
        "Administrator account is inactive",
        403,
        "ADMIN_ACCOUNT_INACTIVE",
      );
    }

    const platformRole = (user as unknown as { platformRole?: string }).platformRole;
    if (platformRole !== "SUPER_ADMIN" && platformRole !== "FINANCE_ADMIN") {
      throw new AppError(
        "User does not have platform administrator privileges",
        403,
        "PLATFORM_ROLE_UNAUTHORIZED",
      );
    }

    const config = loadAdminSessionEnv();

    if (config.ADMIN_REQUIRE_EMAIL_VERIFIED && !user.isEmailVerified) {
      throw new AppError(
        "Administrator email address must be verified before administrative access is granted",
        403,
        "ADMIN_EMAIL_UNVERIFIED",
      );
    }

    const now = new Date();
    const idleExpiresAt = new Date(
      now.getTime() + config.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000,
    );
    const absoluteExpiresAt = new Date(
      now.getTime() + config.ADMIN_SESSION_ABSOLUTE_LIFETIME_HOURS * 3600 * 1000,
    );

    const rawToken = generateAdminRawToken();
    const tokenHash = hashAdminToken(rawToken);

    const sessionDoc = new AdminSession({
      userId: user._id,
      tokenHash,
      status: "ACTIVE" as AdminSessionStatus,
      createdAt: now,
      lastActivityAt: now,
      lastAuthenticatedAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      createdFromIp: sanitizeIp(ip),
      userAgent: sanitizeUserAgent(userAgent),
    });

    await sessionDoc.save({ session: clientSession ?? undefined });

    // Non-blocking audit trail
    adminSecurityAuditService.recordSecurityEvent({
      eventType: "SESSION_CREATED",
      adminUserId: user._id,
      adminEmail: user.email,
      sessionId: sessionDoc._id,
      ipAddress: ip,
      userAgent,
      session: clientSession,
      metadata: {
        platformRole,
        idleTimeoutMinutes: config.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES,
        absoluteLifetimeHours: config.ADMIN_SESSION_ABSOLUTE_LIFETIME_HOURS,
      },
    }).catch((err) => console.error("[AdminAudit] Audit logging failed:", err));

    return {
      session: sessionDoc,
      rawToken,
    };
  }

  /**
   * Authenticates an incoming admin request with single-pass population.
   */
  public async authenticateAdminSession(
    rawToken: string,
  ): Promise<AdminAuthenticationResult> {
    if (typeof rawToken !== "string" || rawToken.trim().length === 0) {
      return {
        success: false,
        code: "INVALID_TOKEN_FORMAT",
        message: "Session token must be a non-empty string",
      };
    }

    let tokenHash: string;
    try {
      tokenHash = hashAdminToken(rawToken);
    } catch {
      return {
        success: false,
        code: "INVALID_TOKEN_FORMAT",
        message: "Failed to compute token hash",
      };
    }

    const session = await AdminSession.findOne({ tokenHash });

    if (!session) {
      return {
        success: false,
        code: "SESSION_NOT_FOUND",
        message: "No active administrator session matches this token",
      };
    }

    if (session.status === "REVOKED") {
      return {
        success: false,
        code: "SESSION_REVOKED",
        message: "Administrator session has been revoked",
        session,
      };
    }

    if (session.status === "EXPIRED") {
      return {
        success: false,
        code: "SESSION_EXPIRED",
        message: "Administrator session has expired",
        session,
      };
    }

    const now = new Date();

    // 1. Dynamic Absolute Expiry Check
    if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "EXPIRED",
            revocationReason: "ABSOLUTE_LIFETIME_EXCEEDED",
          },
        },
      );
      session.status = "EXPIRED";
      session.revocationReason = "ABSOLUTE_LIFETIME_EXCEEDED";

      adminSecurityAuditService.recordSecurityEvent({
        eventType: "SESSION_EXPIRED",
        adminUserId: (session.userId as any)?._id || session.userId,
        sessionId: session._id,
        reason: "ABSOLUTE_LIFETIME_EXCEEDED",
      }).catch(Boolean);

      return {
        success: false,
        code: "SESSION_EXPIRED_ABSOLUTE",
        message: "Administrator session absolute lifetime has been exceeded",
        session,
      };
    }

    // 2. Dynamic Sliding Idle Expiry Check
    if (now.getTime() >= session.idleExpiresAt.getTime()) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "EXPIRED",
            revocationReason: "IDLE_TIMEOUT_EXCEEDED",
          },
        },
      );
      session.status = "EXPIRED";
      session.revocationReason = "IDLE_TIMEOUT_EXCEEDED";

      adminSecurityAuditService.recordSecurityEvent({
        eventType: "SESSION_EXPIRED",
        adminUserId: (session.userId as any)?._id || session.userId,
        sessionId: session._id,
        reason: "IDLE_TIMEOUT_EXCEEDED",
      }).catch(Boolean);

      return {
        success: false,
        code: "SESSION_EXPIRED_IDLE",
        message: "Administrator session idle timeout has expired",
        session,
      };
    }

    // 3. User Validation: retrieve user document
    const user =
      session.userId && typeof session.userId === "object" && "isActive" in session.userId
        ? (session.userId as unknown as UserDocument & { _id: Types.ObjectId })
        : await User.findById(session.userId);

    if (!user || !user.isActive) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revocationReason: "USER_INACTIVE",
          },
        },
      );
      session.status = "REVOKED";
      session.revokedAt = now;
      session.revocationReason = "USER_INACTIVE";

      adminSecurityAuditService.recordSecurityEvent({
        eventType: "ADMIN_DEACTIVATED",
        adminUserId: user?._id || session.get("userId"),
        adminEmail: user?.email,
        sessionId: session._id,
        reason: "USER_INACTIVE",
      }).catch(Boolean);

      return {
        success: false,
        code: "USER_INACTIVE",
        message: "Administrator account is inactive or no longer exists",
        session,
      };
    }

    // 4. Global Invalidation Check: tokenInvalidBefore
    if (
      user.tokenInvalidBefore &&
      session.createdAt.getTime() < new Date(user.tokenInvalidBefore).getTime()
    ) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revocationReason: "SESSIONS_REVOKED_GLOBAL",
          },
        },
      );
      session.status = "REVOKED";
      session.revokedAt = now;
      session.revocationReason = "SESSIONS_REVOKED_GLOBAL";

      adminSecurityAuditService
        .recordSecurityEvent({
          eventType: "SESSION_REVOKED",
          adminUserId: user._id,
          adminEmail: user.email,
          sessionId: session._id,
          reason:
            "SESSIONS_REVOKED_GLOBAL: session created before tokenInvalidBefore timestamp",
        })
        .catch(Boolean);

      return {
        success: false,
        code: "SESSION_REVOKED",
        message:
          "Administrator session has been invalidated by a security event or password reset",
        session,
      };
    }

    const platformRole = (user as unknown as { platformRole?: string }).platformRole;
    if (platformRole !== "SUPER_ADMIN" && platformRole !== "FINANCE_ADMIN") {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revocationReason: "ROLE_UNAUTHORIZED",
          },
        },
      );
      session.status = "REVOKED";
      session.revokedAt = now;
      session.revocationReason = "ROLE_UNAUTHORIZED";

      adminSecurityAuditService.recordSecurityEvent({
        eventType: "ADMIN_DEMOTED",
        adminUserId: user._id,
        adminEmail: user.email,
        sessionId: session._id,
        reason: "ROLE_UNAUTHORIZED",
        metadata: { demotedRole: platformRole },
      }).catch(Boolean);

      return {
        success: false,
        code: "ROLE_UNAUTHORIZED",
        message: "User platform administrator privileges have been revoked",
        session,
      };
    }

    const config = loadAdminSessionEnv();
    if (config.ADMIN_REQUIRE_EMAIL_VERIFIED && !user.isEmailVerified) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revocationReason: "EMAIL_UNVERIFIED",
          },
        },
      );
      session.status = "REVOKED";
      session.revokedAt = now;
      session.revocationReason = "EMAIL_UNVERIFIED";

      return {
        success: false,
        code: "EMAIL_UNVERIFIED",
        message:
          "Administrator email must be verified before administrative access is granted",
        session,
      };
    }

    return {
      success: true,
      session,
      user,
    };
  }

  /**
   * Atomically touches an active session using atomic query filters after revalidating user & timeouts.
   */
  public async touchAdminSession(
    sessionId: string | Types.ObjectId,
  ): Promise<IAdminSession | null> {
    const config = loadAdminSessionEnv();
    const session = await AdminSession.findById(sessionId);
    if (!session || session.status === "REVOKED") {
      return null;
    }

    const now = new Date();
    if (now.getTime() >= session.idleExpiresAt.getTime()) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "EXPIRED",
            revocationReason: "IDLE_TIMEOUT_EXCEEDED",
          },
        },
      );
      return null;
    }

    if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "EXPIRED",
            revocationReason: "ABSOLUTE_LIFETIME_EXCEEDED",
          },
        },
      );
      return null;
    }

    const user = await User.findById(session.userId);
    if (!user || !user.isActive) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revocationReason: "USER_INACTIVE",
          },
        },
      );
      return null;
    }

    if (
      user.platformRole !== "SUPER_ADMIN" &&
      user.platformRole !== "FINANCE_ADMIN"
    ) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revocationReason: "ROLE_UNAUTHORIZED",
          },
        },
      );
      return null;
    }

    if (config.ADMIN_REQUIRE_EMAIL_VERIFIED && !user.isEmailVerified) {
      await AdminSession.updateOne(
        { _id: session._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revocationReason: "EMAIL_UNVERIFIED",
          },
        },
      );
      return null;
    }

    const idleMs = config.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;
    const candidateIdle = new Date(now.getTime() + idleMs);
    const nextIdle =
      candidateIdle.getTime() < session.absoluteExpiresAt.getTime()
        ? candidateIdle
        : session.absoluteExpiresAt;

    const updated = await AdminSession.findOneAndUpdate(
      {
        _id: sessionId,
        status: "ACTIVE",
        idleExpiresAt: { $gt: now },
        absoluteExpiresAt: { $gt: now },
      },
      {
        $set: {
          lastActivityAt: now,
          idleExpiresAt: nextIdle,
        },
      },
      { new: true },
    );

    return updated;
  }

  public async revokeAdminSession(
    sessionId: string | Types.ObjectId,
    reason: string = "ADMIN_LOGOUT",
  ): Promise<IAdminSession | null> {
    const now = new Date();

    const session = await AdminSession.findOneAndUpdate(
      { _id: sessionId, status: "ACTIVE" },
      {
        $set: {
          status: "REVOKED",
          revokedAt: now,
          revocationReason: reason,
        },
      },
      { new: true },
    );

    if (session) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "SESSION_REVOKED",
        adminUserId: session.userId,
        sessionId: session._id,
        reason,
      }).catch(Boolean);
    }

    return session;
  }

  public async revokeAllAdminSessions(
    userId: string | Types.ObjectId,
    reason: string = "BULK_REVOCATION",
  ): Promise<number> {
    const now = new Date();

    const result = await AdminSession.updateMany(
      { userId, status: "ACTIVE" },
      {
        $set: {
          status: "REVOKED",
          revokedAt: now,
          revocationReason: reason,
        },
      },
    );

    if (result.modifiedCount > 0) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "SESSION_REVOKED",
        adminUserId: userId,
        reason: `BULK_REVOCATION: ${reason} (count: ${result.modifiedCount})`,
      }).catch(Boolean);
    }

    return result.modifiedCount;
  }

  public async cleanupExpiredAdminSessions(): Promise<number> {
    const now = new Date();

    const result = await AdminSession.updateMany(
      {
        status: "ACTIVE",
        $or: [
          { idleExpiresAt: { $lte: now } },
          { absoluteExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "EXPIRED",
          revocationReason: "LIFETIME_CLEANUP",
        },
      },
    );

    if (result.modifiedCount > 0) {
      adminSecurityAuditService.recordSecurityEvent({
        eventType: "SESSION_EXPIRED",
        reason: `CLEANUP_EXPIRED: count=${result.modifiedCount}`,
      }).catch(Boolean);
    }

    return result.modifiedCount;
  }

  public async purgeSessions(actor?: {
    adminUserId?: string | Types.ObjectId;
    adminEmail?: string;
    sessionId?: string | Types.ObjectId;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<number> {
    const now = new Date();
    const result = await AdminSession.deleteMany({
      $or: [
        { idleExpiresAt: { $lt: now } },
        { absoluteExpiresAt: { $lt: now } },
        { status: "REVOKED" },
        { status: "EXPIRED" },
      ],
    });

    if (actor) {
      await adminSecurityAuditService.recordSecurityEvent({
        eventType: "ADMIN_SESSIONS_PURGED",
        adminUserId: actor.adminUserId,
        adminEmail: actor.adminEmail,
        sessionId: actor.sessionId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        reason: `Purged ${result.deletedCount} expired and revoked admin sessions`,
        metadata: {
          purgedCount: result.deletedCount,
        },
      });
    }

    return result.deletedCount;
  }
}

export const adminSessionService = new AdminSessionService();