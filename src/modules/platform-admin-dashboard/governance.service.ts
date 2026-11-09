import mongoose, { type Types } from "mongoose";
import Workspace from "../workspace/workspace.model.js";
import Membership from "../workspace/membership.model.js";
import User from "../auth/user.model.js";
import Payment from "../billing/payment.model.js";
import Subscription from "../billing/subscription.model.js";
import AdminSession from "../admin-auth/admin-session.model.js";
import { adminSecurityAuditService } from "../admin-auth/admin-security-audit.service.js";
import { AppError } from "../../utils/app-error.js";

export class PlatformAdminGovernanceService {
  /**
   * Updates workspace operational status (SUSPENDED or ACTIVE).
   * Data remains intact when suspended, but status/reason flags are toggled.
   */
  async updateWorkspaceStatus(params: {
    workspaceId: string | Types.ObjectId;
    status: "ACTIVE" | "SUSPENDED";
    reason?: string;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { workspaceId, status, reason, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      throw new AppError("A valid workspace ID is required", 400);
    }

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      throw new AppError("Workspace not found", 404);
    }

    const previousStatus = workspace.status;

    if (status === "SUSPENDED") {
      workspace.status = "SUSPENDED";
      workspace.suspensionReason = reason?.trim() || "Suspended by platform administrator";
      workspace.suspendedAt = new Date();
    } else {
      workspace.status = "ACTIVE";
      workspace.suspensionReason = null;
      workspace.suspendedAt = null;
    }

    await workspace.save();

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "WORKSPACE_STATUS_UPDATED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason:
          reason?.trim() ||
          (status === "SUSPENDED" ? "Workspace suspended" : "Workspace activated"),
        metadata: {
          workspaceId: String(workspace._id),
          workspaceName: workspace.name,
          newStatus: status,
          previousStatus,
        },
      })
      .catch((err) => {
        console.error("[GovernanceAudit] Failed to record workspace audit log:", err);
      });

    return workspace;
  }

  /**
   * Modifies a user's platform role.
   * Guarded strictly to prevent self-demotion or demoting the sole Super Admin.
   */
  async updateUserRole(params: {
    userId: string | Types.ObjectId;
    platformRole: "SUPER_ADMIN" | "FINANCE_ADMIN" | "USER";
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { userId, platformRole, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError("A valid user ID is required", 400);
    }

    // Zero Privilege Escalation / Self-demotion guard
    if (String(userId) === String(adminUser.id) && platformRole !== "SUPER_ADMIN") {
      throw new AppError(
        "Administrators cannot modify or demote their own platform role",
        400,
        "CANNOT_DEMOTE_SELF",
      );
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    const previousRole = targetUser.platformRole || "USER";

    // Sole Super Admin protection
    if (previousRole === "SUPER_ADMIN" && platformRole !== "SUPER_ADMIN") {
      const superAdminCount = await User.countDocuments({ platformRole: "SUPER_ADMIN" });
      if (superAdminCount <= 1) {
        throw new AppError(
          "Cannot demote the sole remaining Super Admin in the system",
          400,
          "SOLE_SUPER_ADMIN",
        );
      }
    }

    targetUser.platformRole = platformRole;

    // If demoting an admin to standard user, instantly invalidate their sessions
    if (platformRole === "USER" && previousRole !== "USER") {
      targetUser.tokenInvalidBefore = new Date();
      await AdminSession.updateMany(
        { adminUserId: targetUser._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: new Date(),
            revokedReason: "Platform role modified to USER by Super Admin",
          },
        },
      ).catch(() => {});
    }

    await targetUser.save();

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: platformRole === "USER" ? "ADMIN_DEMOTED" : "USER_ROLE_UPDATED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: `Platform role updated from ${previousRole} to ${platformRole}`,
        metadata: {
          targetUserId: String(targetUser._id),
          targetEmail: targetUser.email,
          previousRole,
          newRole: platformRole,
        },
      })
      .catch((err) => {
        console.error("[GovernanceAudit] Failed to record role change audit:", err);
      });

    return {
      id: String(targetUser._id),
      name: targetUser.name,
      email: targetUser.email,
      platformRole: targetUser.platformRole,
    };
  }

  /**
   * Instantly revokes all active customer JWTs and AdminSessions for a target user.
   */
  async revokeUserSessions(params: {
    userId: string | Types.ObjectId;
    reason?: string;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { userId, reason, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError("A valid user ID is required", 400);
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    const revocationTime = new Date();
    targetUser.tokenInvalidBefore = revocationTime;
    await targetUser.save();

    // Revoke any active AdminSession cookies
    await AdminSession.updateMany(
      { adminUserId: targetUser._id, status: "ACTIVE" },
      {
        $set: {
          status: "REVOKED",
          revokedAt: revocationTime,
          revokedReason: reason?.trim() || "Immediate administrative session revocation",
        },
      },
    ).catch(() => {});

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "USER_SESSIONS_REVOKED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: reason?.trim() || "Immediate administrative session revocation",
        metadata: {
          targetUserId: String(targetUser._id),
          targetEmail: targetUser.email,
          tokenInvalidBefore: revocationTime.toISOString(),
        },
      })
      .catch((err) => {
        console.error("[GovernanceAudit] Failed to record session revocation audit:", err);
      });

    return {
      userId: String(targetUser._id),
      tokenInvalidBefore: revocationTime,
    };
  }

  /**
   * Deactivates or reactivates a user account.
   * Deactivation automatically invokes session revocation.
   */
  async updateUserStatus(params: {
    userId: string | Types.ObjectId;
    isActive: boolean;
    reason?: string;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { userId, isActive, reason, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError("A valid user ID is required", 400);
    }

    // Self-deactivation guard
    if (String(userId) === String(adminUser.id) && !isActive) {
      throw new AppError(
        "Administrators cannot deactivate their own account",
        400,
        "CANNOT_DEACTIVATE_SELF",
      );
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    targetUser.isActive = isActive;

    if (!isActive) {
      const revocationTime = new Date();
      targetUser.tokenInvalidBefore = revocationTime;
      targetUser.suspendedReason = reason?.trim() || "Deactivated by platform administrator";

      await AdminSession.updateMany(
        { adminUserId: targetUser._id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: revocationTime,
            revokedReason: reason?.trim() || "Account deactivated by platform administrator",
          },
        },
      ).catch(() => {});
    } else {
      targetUser.suspendedReason = null;
    }

    await targetUser.save();

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: isActive ? "USER_STATUS_UPDATED" : "ADMIN_DEACTIVATED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason:
          reason?.trim() ||
          (isActive ? "User account reactivated" : "User account deactivated"),
        metadata: {
          targetUserId: String(targetUser._id),
          targetEmail: targetUser.email,
          isActive,
        },
      })
      .catch((err) => {
        console.error("[GovernanceAudit] Failed to record user status audit:", err);
      });

    return {
      id: String(targetUser._id),
      name: targetUser.name,
      email: targetUser.email,
      isActive: targetUser.isActive,
      suspendedReason: targetUser.suspendedReason,
    };
  }

  /**
   * Safely purges an abandoned/unverified user account and empty sandbox artifacts.
   * STRICT FAIL-CLOSED INTEGRITY GUARDS:
   * Rejects with HTTP 409 if user has any completed financial payments, paid workspaces,
   * active subscriptions, or active team members.
   */
  async deleteAbandonedUser(params: {
    userId: string | Types.ObjectId;
    confirmation: string;
    adminUser: { id: string; email: string };
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { userId, confirmation, adminUser, ipAddress, userAgent } = params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError("A valid user ID is required", 400);
    }

    if (confirmation !== "DELETE") {
      throw new AppError(
        "Invalid confirmation. Request payload must include confirmation: 'DELETE'",
        400,
        "INVALID_CONFIRMATION",
      );
    }

    // Self-deletion guard
    if (String(userId) === String(adminUser.id)) {
      throw new AppError(
        "Administrators cannot delete their own account",
        400,
        "CANNOT_DELETE_SELF",
      );
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    // Guard 1: Direct completed financial transactions initiated by user
    const userPaymentsCount = await Payment.countDocuments({
      initiatedBy: targetUser._id,
      status: "COMPLETED",
    });
    if (userPaymentsCount > 0) {
      throw new AppError(
        `Cannot delete user: account has ${userPaymentsCount} completed financial transaction(s). Ledger integrity requires retaining the account. Deactivate the user instead.`,
        409,
        "USER_HAS_FINANCIAL_TRANSACTIONS",
      );
    }

    // Find all workspaces owned by the user
    const ownedWorkspaces = await Workspace.find({ ownerId: targetUser._id }).select("_id name");
    const ownedWorkspaceIds = ownedWorkspaces.map((w) => w._id);

    // Guard 2: Completed payments tied to user's owned workspaces
    if (ownedWorkspaceIds.length > 0) {
      const workspacePaymentsCount = await Payment.countDocuments({
        workspaceId: { $in: ownedWorkspaceIds },
        status: "COMPLETED",
      });
      if (workspacePaymentsCount > 0) {
        throw new AppError(
          `Cannot delete user: owned workspace(s) have ${workspacePaymentsCount} completed financial transaction(s). Ledger integrity requires retaining the account. Deactivate the user instead.`,
          409,
          "WORKSPACE_HAS_FINANCIAL_TRANSACTIONS",
        );
      }
    }

    // Guard 3: Active or paid subscriptions
    if (targetUser.isPaid || targetUser.subscriptionStatus === "active") {
      throw new AppError(
        "Cannot delete user: user has an active or paid subscription. Account must be cancelled or deactivated instead.",
        409,
        "USER_HAS_ACTIVE_SUBSCRIPTION",
      );
    }

    if (ownedWorkspaceIds.length > 0) {
      const activeSubsCount = await Subscription.countDocuments({
        workspaceId: { $in: ownedWorkspaceIds },
        status: "ACTIVE",
      });
      if (activeSubsCount > 0) {
        throw new AppError(
          `Cannot delete user: owned workspace(s) have ${activeSubsCount} active subscription(s). Deactivate the user instead.`,
          409,
          "WORKSPACE_HAS_ACTIVE_SUBSCRIPTION",
        );
      }
    }

    // Guard 4: Non-empty workspaces with other active team members
    if (ownedWorkspaceIds.length > 0) {
      const otherMembersCount = await Membership.countDocuments({
        workspaceId: { $in: ownedWorkspaceIds },
        userId: { $ne: targetUser._id },
        status: "ACTIVE",
      });
      if (otherMembersCount > 0) {
        throw new AppError(
          `Cannot delete user: owned workspace has ${otherMembersCount} other active team member(s). Ownership must be transferred first.`,
          409,
          "WORKSPACE_HAS_ACTIVE_MEMBERS",
        );
      }
    }

    // All pre-checks passed: Clean/abandoned user purge
    if (ownedWorkspaceIds.length > 0) {
      await Workspace.deleteMany({ _id: { $in: ownedWorkspaceIds } });
    }
    await Membership.deleteMany({ userId: targetUser._id });
    await AdminSession.deleteMany({ adminUserId: targetUser._id }).catch(() => {});
    await User.deleteOne({ _id: targetUser._id });

    await adminSecurityAuditService
      .recordSecurityEvent({
        eventType: "USER_DELETED",
        adminUserId: adminUser.id,
        adminEmail: adminUser.email,
        ipAddress,
        userAgent,
        reason: "Purged abandoned user account with zero financial and team dependencies",
        metadata: {
          deletedUserId: String(targetUser._id),
          deletedEmail: targetUser.email,
          deletedWorkspacesCount: ownedWorkspaceIds.length,
        },
      })
      .catch((err) => {
        console.error("[GovernanceAudit] Failed to record user deletion audit:", err);
      });

    return {
      success: true,
      message: "Abandoned user account and empty sandbox artifacts purged successfully",
    };
  }
}

export const platformAdminGovernanceService = new PlatformAdminGovernanceService();
