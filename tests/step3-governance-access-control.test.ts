import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// Ensure test environment variables
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-jwt-access-secret-super-safe-and-long-enough-32-chars";

import User from "../src/modules/auth/user.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import Payment from "../src/modules/billing/payment.model.js";
import Subscription from "../src/modules/billing/subscription.model.js";
import Membership from "../src/modules/workspace/membership.model.js";
import AdminSession from "../src/modules/admin-auth/admin-session.model.js";
import {
  updateWorkspaceStatusSchema,
  updateUserRoleSchema,
  revokeUserSessionsSchema,
  updateUserStatusSchema,
  deleteUserSchema,
} from "../src/modules/platform-admin-dashboard/governance.validation.js";
import { platformAdminGovernanceService } from "../src/modules/platform-admin-dashboard/governance.service.js";
import { platformAdminGovernanceRouter } from "../src/modules/platform-admin-dashboard/governance.routes.js";
import { AppError } from "../src/utils/app-error.js";

describe("Step 3: Tenant & User Governance (Workspaces & Access Control) Test Suite", () => {
  const superAdminId = new mongoose.Types.ObjectId().toString();
  const superAdminEmail = "super.admin@vexchat.app";
  const adminActor = { id: superAdminId, email: superAdminEmail };

  describe("Governance Input Validation Schemas", () => {
    it("should validate updateWorkspaceStatusSchema correctly", () => {
      const validSuspended = updateWorkspaceStatusSchema.safeParse({
        status: "SUSPENDED",
        reason: "Overdue payment grace period elapsed",
      });
      assert.ok(validSuspended.success);
      assert.strictEqual(validSuspended.data.status, "SUSPENDED");

      const validActive = updateWorkspaceStatusSchema.safeParse({
        status: "ACTIVE",
      });
      assert.ok(validActive.success);
      assert.strictEqual(validActive.data.status, "ACTIVE");

      const invalidStatus = updateWorkspaceStatusSchema.safeParse({
        status: "CANCELLED",
      });
      assert.strictEqual(invalidStatus.success, false);
    });

    it("should validate updateUserRoleSchema restricting to valid platform roles", () => {
      assert.ok(updateUserRoleSchema.safeParse({ platformRole: "SUPER_ADMIN" }).success);
      assert.ok(updateUserRoleSchema.safeParse({ platformRole: "FINANCE_ADMIN" }).success);
      assert.ok(updateUserRoleSchema.safeParse({ platformRole: "USER" }).success);

      assert.strictEqual(
        updateUserRoleSchema.safeParse({ platformRole: "OWNER" }).success,
        false,
      );
      assert.strictEqual(
        updateUserRoleSchema.safeParse({ platformRole: "ADMIN" }).success,
        false,
      );
    });

    it("should validate updateUserStatusSchema requiring boolean isActive", () => {
      assert.ok(
        updateUserStatusSchema.safeParse({
          isActive: false,
          reason: "Suspected credential leakage",
        }).success,
      );
      assert.ok(updateUserStatusSchema.safeParse({ isActive: true }).success);

      assert.strictEqual(
        updateUserStatusSchema.safeParse({ isActive: "false" }).success,
        false,
      );
    });

    it("should validate deleteUserSchema requiring literal 'DELETE'", () => {
      assert.ok(deleteUserSchema.safeParse({ confirmation: "DELETE" }).success);

      assert.strictEqual(
        deleteUserSchema.safeParse({ confirmation: "delete" }).success,
        false,
      );
      assert.strictEqual(
        deleteUserSchema.safeParse({ confirmation: "CONFIRM" }).success,
        false,
      );
      assert.strictEqual(deleteUserSchema.safeParse({}).success, false);
    });
  });

  describe("Workspace Status Mutation (Suspension / Activation)", () => {
    it("should suspend an active workspace setting status, suspensionReason, and suspendedAt", async () => {
      const mockWorkspace = {
        _id: new mongoose.Types.ObjectId(),
        name: "Acme Labs",
        status: "ACTIVE",
        suspensionReason: null,
        suspendedAt: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = Workspace.findById;
      try {
        (Workspace as any).findById = () => mockWorkspace;

        const updated = await platformAdminGovernanceService.updateWorkspaceStatus({
          workspaceId: mockWorkspace._id.toString(),
          status: "SUSPENDED",
          reason: "Chargeback dispute pending",
          adminUser: adminActor,
        });

        assert.strictEqual(updated.status, "SUSPENDED");
        assert.strictEqual(updated.suspensionReason, "Chargeback dispute pending");
        assert.ok(updated.suspendedAt instanceof Date);
      } finally {
        Workspace.findById = originalFindById;
      }
    });

    it("should reactivate a suspended workspace clearing suspensionReason and suspendedAt", async () => {
      const mockWorkspace = {
        _id: new mongoose.Types.ObjectId(),
        name: "Acme Labs",
        status: "SUSPENDED",
        suspensionReason: "Previous overdue invoice",
        suspendedAt: new Date("2026-11-01"),
        save: async function () {
          return this;
        },
      };

      const originalFindById = Workspace.findById;
      try {
        (Workspace as any).findById = () => mockWorkspace;

        const updated = await platformAdminGovernanceService.updateWorkspaceStatus({
          workspaceId: mockWorkspace._id.toString(),
          status: "ACTIVE",
          adminUser: adminActor,
        });

        assert.strictEqual(updated.status, "ACTIVE");
        assert.strictEqual(updated.suspensionReason, null);
        assert.strictEqual(updated.suspendedAt, null);
      } finally {
        Workspace.findById = originalFindById;
      }
    });
  });

  describe("User Platform Role Management & Privilege Protection", () => {
    it("should prevent self-demotion when admin tries to demote their own platform role", async () => {
      await assert.rejects(
        async () => {
          await platformAdminGovernanceService.updateUserRole({
            userId: superAdminId, // same as adminActor.id
            platformRole: "USER",
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "CANNOT_DEMOTE_SELF");
          return true;
        },
      );
    });

    it("should prevent demoting the sole remaining Super Admin in the system", async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(otherUserId),
        name: "Other Admin",
        email: "other@vexchat.app",
        platformRole: "SUPER_ADMIN",
        save: async function () {
          return this;
        },
      };

      const originalFindById = User.findById;
      const originalCountDocuments = User.countDocuments;

      try {
        (User as any).findById = () => mockUser;
        (User as any).countDocuments = () => 1; // sole super admin

        await assert.rejects(
          async () => {
            await platformAdminGovernanceService.updateUserRole({
              userId: otherUserId,
              platformRole: "FINANCE_ADMIN",
              adminUser: adminActor,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 400);
            assert.strictEqual(err.code, "SOLE_SUPER_ADMIN");
            return true;
          },
        );
      } finally {
        User.findById = originalFindById;
        User.countDocuments = originalCountDocuments;
      }
    });

    it("should allow promoting a USER to FINANCE_ADMIN or SUPER_ADMIN", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        name: "Finance Manager",
        email: "finance@vexchat.app",
        platformRole: "USER",
        save: async function () {
          return this;
        },
      };

      const originalFindById = User.findById;
      try {
        (User as any).findById = () => mockUser;

        const result = await platformAdminGovernanceService.updateUserRole({
          userId: targetUserId,
          platformRole: "FINANCE_ADMIN",
          adminUser: adminActor,
        });

        assert.strictEqual(result.platformRole, "FINANCE_ADMIN");
        assert.strictEqual(mockUser.platformRole, "FINANCE_ADMIN");
      } finally {
        User.findById = originalFindById;
      }
    });
  });

  describe("Instant Session Revocation & Account Status Toggle", () => {
    it("should set tokenInvalidBefore and revoke active sessions", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        name: "Compromised User",
        email: "compromised@vexchat.app",
        tokenInvalidBefore: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = User.findById;
      const originalUpdateMany = AdminSession.updateMany;

      try {
        (User as any).findById = () => mockUser;
        (AdminSession as any).updateMany = async () => ({ modifiedCount: 1 });

        const result = await platformAdminGovernanceService.revokeUserSessions({
          userId: targetUserId,
          reason: "Security audit trigger",
          adminUser: adminActor,
        });

        assert.ok(result.tokenInvalidBefore instanceof Date);
        assert.ok(mockUser.tokenInvalidBefore instanceof Date);
      } finally {
        User.findById = originalFindById;
        AdminSession.updateMany = originalUpdateMany;
      }
    });

    it("should prevent self-deactivation when admin attempts to deactivate themselves", async () => {
      await assert.rejects(
        async () => {
          await platformAdminGovernanceService.updateUserStatus({
            userId: superAdminId,
            isActive: false,
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "CANNOT_DEACTIVATE_SELF");
          return true;
        },
      );
    });

    it("should deactivate user and automatically invalidate active tokens", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        name: "Abusive User",
        email: "abusive@vexchat.app",
        isActive: true,
        suspendedReason: null,
        tokenInvalidBefore: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = User.findById;
      const originalUpdateMany = AdminSession.updateMany;

      try {
        (User as any).findById = () => mockUser;
        (AdminSession as any).updateMany = async () => ({ modifiedCount: 0 });

        const result = await platformAdminGovernanceService.updateUserStatus({
          userId: targetUserId,
          isActive: false,
          reason: "Terms of service violation",
          adminUser: adminActor,
        });

        assert.strictEqual(result.isActive, false);
        assert.strictEqual(result.suspendedReason, "Terms of service violation");
        assert.ok(mockUser.tokenInvalidBefore instanceof Date);
      } finally {
        User.findById = originalFindById;
        AdminSession.updateMany = originalUpdateMany;
      }
    });
  });

  describe("Safe Abandoned User Cleanup Guard (Pre-checks)", () => {
    it("should reject deletion if confirmation is not 'DELETE'", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      await assert.rejects(
        async () => {
          await platformAdminGovernanceService.deleteAbandonedUser({
            userId: targetUserId,
            confirmation: "NOPE",
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "INVALID_CONFIRMATION");
          return true;
        },
      );
    });

    it("should reject deletion if user attempts to delete their own account", async () => {
      await assert.rejects(
        async () => {
          await platformAdminGovernanceService.deleteAbandonedUser({
            userId: superAdminId,
            confirmation: "DELETE",
            adminUser: adminActor,
          });
        },
        (err: any) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "CANNOT_DELETE_SELF");
          return true;
        },
      );
    });

    it("should BLOCK deletion (HTTP 409) if user has completed financial transactions", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        email: "paying.customer@vexchat.app",
        isPaid: true,
      };

      const originalFindById = User.findById;
      const originalPaymentCount = Payment.countDocuments;

      try {
        (User as any).findById = () => mockUser;
        // User has 1 completed payment
        (Payment as any).countDocuments = async () => 1;

        await assert.rejects(
          async () => {
            await platformAdminGovernanceService.deleteAbandonedUser({
              userId: targetUserId,
              confirmation: "DELETE",
              adminUser: adminActor,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 409);
            assert.strictEqual(err.code, "USER_HAS_FINANCIAL_TRANSACTIONS");
            return true;
          },
        );
      } finally {
        User.findById = originalFindById;
        Payment.countDocuments = originalPaymentCount;
      }
    });

    it("should BLOCK deletion (HTTP 409) if user has active or paid subscription", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        email: "active.sub@vexchat.app",
        isPaid: true,
        subscriptionStatus: "active",
      };

      const originalFindById = User.findById;
      const originalPaymentCount = Payment.countDocuments;
      const originalWorkspaceFind = Workspace.find;

      try {
        (User as any).findById = () => mockUser;
        (Payment as any).countDocuments = async () => 0;
        (Workspace as any).find = () => ({
          select: () => [],
        });

        await assert.rejects(
          async () => {
            await platformAdminGovernanceService.deleteAbandonedUser({
              userId: targetUserId,
              confirmation: "DELETE",
              adminUser: adminActor,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 409);
            assert.strictEqual(err.code, "USER_HAS_ACTIVE_SUBSCRIPTION");
            return true;
          },
        );
      } finally {
        User.findById = originalFindById;
        Payment.countDocuments = originalPaymentCount;
        Workspace.find = originalWorkspaceFind;
      }
    });

    it("should BLOCK deletion (HTTP 409) if owned workspace has active team members", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        email: "team.owner@vexchat.app",
        isPaid: false,
        subscriptionStatus: "trial",
      };

      const originalFindById = User.findById;
      const originalPaymentCount = Payment.countDocuments;
      const originalWorkspaceFind = Workspace.find;
      const originalSubscriptionCount = Subscription.countDocuments;
      const originalMembershipCount = Membership.countDocuments;

      try {
        (User as any).findById = () => mockUser;
        (Payment as any).countDocuments = async () => 0;
        (Workspace as any).find = () => ({
          select: () => [{ _id: new mongoose.Types.ObjectId(), name: "Team WS" }],
        });
        (Subscription as any).countDocuments = async () => 0;
        // Workspace has 2 other active members
        (Membership as any).countDocuments = async () => 2;

        await assert.rejects(
          async () => {
            await platformAdminGovernanceService.deleteAbandonedUser({
              userId: targetUserId,
              confirmation: "DELETE",
              adminUser: adminActor,
            });
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.statusCode, 409);
            assert.strictEqual(err.code, "WORKSPACE_HAS_ACTIVE_MEMBERS");
            return true;
          },
        );
      } finally {
        User.findById = originalFindById;
        Payment.countDocuments = originalPaymentCount;
        Workspace.find = originalWorkspaceFind;
        Subscription.countDocuments = originalSubscriptionCount;
        Membership.countDocuments = originalMembershipCount;
      }
    });

    it("should successfully purge completely clean / abandoned account with zero dependencies", async () => {
      const targetUserId = new mongoose.Types.ObjectId().toString();
      const mockUser = {
        _id: new mongoose.Types.ObjectId(targetUserId),
        email: "abandoned.empty@vexchat.app",
        isPaid: false,
        subscriptionStatus: "trial",
      };

      let userDeleted = false;
      let workspacesDeleted = false;
      let membershipsDeleted = false;

      const originalFindById = User.findById;
      const originalPaymentCount = Payment.countDocuments;
      const originalWorkspaceFind = Workspace.find;
      const originalSubscriptionCount = Subscription.countDocuments;
      const originalMembershipCount = Membership.countDocuments;
      const originalWorkspaceDeleteMany = Workspace.deleteMany;
      const originalMembershipDeleteMany = Membership.deleteMany;
      const originalAdminSessionDeleteMany = AdminSession.deleteMany;
      const originalUserDeleteOne = User.deleteOne;

      try {
        (User as any).findById = () => mockUser;
        (Payment as any).countDocuments = async () => 0;
        (Workspace as any).find = () => ({
          select: () => [{ _id: new mongoose.Types.ObjectId(), name: "Empty Sandbox" }],
        });
        (Subscription as any).countDocuments = async () => 0;
        (Membership as any).countDocuments = async () => 0;

        (Workspace as any).deleteMany = async () => {
          workspacesDeleted = true;
          return { deletedCount: 1 };
        };
        (Membership as any).deleteMany = async () => {
          membershipsDeleted = true;
          return { deletedCount: 1 };
        };
        (AdminSession as any).deleteMany = async () => ({ deletedCount: 0 });
        (User as any).deleteOne = async () => {
          userDeleted = true;
          return { deletedCount: 1 };
        };

        const result = await platformAdminGovernanceService.deleteAbandonedUser({
          userId: targetUserId,
          confirmation: "DELETE",
          adminUser: adminActor,
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(userDeleted, true);
        assert.strictEqual(workspacesDeleted, true);
        assert.strictEqual(membershipsDeleted, true);
      } finally {
        User.findById = originalFindById;
        Payment.countDocuments = originalPaymentCount;
        Workspace.find = originalWorkspaceFind;
        Subscription.countDocuments = originalSubscriptionCount;
        Membership.countDocuments = originalMembershipCount;
        Workspace.deleteMany = originalWorkspaceDeleteMany;
        Membership.deleteMany = originalMembershipDeleteMany;
        AdminSession.deleteMany = originalAdminSessionDeleteMany;
        User.deleteOne = originalUserDeleteOne;
      }
    });
  });

  describe("Platform Admin Governance Router Configuration", () => {
    it("should mount all 5 required governance endpoints", () => {
      const routes = platformAdminGovernanceRouter.stack
        .filter((l) => l.route)
        .map((l) => ({
          path: l.route.path,
          methods: Object.keys(l.route.methods),
        }));

      const paths = routes.map((r) => r.path);
      assert.ok(
        paths.includes("/workspaces/:workspaceId/status"),
        "Must include /workspaces/:workspaceId/status",
      );
      assert.ok(paths.includes("/users/:userId/role"), "Must include /users/:userId/role");
      assert.ok(
        paths.includes("/users/:userId/revoke-sessions"),
        "Must include /users/:userId/revoke-sessions",
      );
      assert.ok(
        paths.includes("/users/:userId/status"),
        "Must include /users/:userId/status",
      );
      assert.ok(paths.includes("/users/:userId"), "Must include /users/:userId");
    });
  });
});
