import type { Response, NextFunction } from "express";
import type { AdminAuthenticatedRequest } from "../../middlewares/authenticate-admin-session.js";
import { getRouteParam } from "../../utils/get-route-param.js";
import { AppError } from "../../utils/app-error.js";
import { platformAdminGovernanceService } from "./governance.service.js";
import {
  updateWorkspaceStatusSchema,
  updateUserRoleSchema,
  revokeUserSessionsSchema,
  updateUserStatusSchema,
  deleteUserSchema,
} from "./governance.validation.js";

export class PlatformAdminGovernanceController {
  /**
   * PATCH /api/platform-admin/workspaces/:workspaceId/status
   * PATCH /api/admin/workspaces/:workspaceId/status
   */
  async updateWorkspaceStatus(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = getRouteParam(req, "workspaceId");
      if (!workspaceId) {
        throw new AppError("A valid workspace ID is required", 400);
      }

      const validation = updateWorkspaceStatusSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const workspace = await platformAdminGovernanceService.updateWorkspaceStatus({
        workspaceId,
        status: validation.data.status,
        reason: validation.data.reason,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: `Workspace ${validation.data.status === "SUSPENDED" ? "suspended" : "activated"} successfully`,
        data: { workspace },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/platform-admin/users/:userId/role
   * PATCH /api/admin/users/:userId/role
   */
  async updateUserRole(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getRouteParam(req, "userId");
      if (!userId) {
        throw new AppError("A valid user ID is required", 400);
      }

      const validation = updateUserRoleSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await platformAdminGovernanceService.updateUserRole({
        userId,
        platformRole: validation.data.platformRole,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: `User platform role updated to ${validation.data.platformRole}`,
        data: { user: result },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/platform-admin/users/:userId/revoke-sessions
   * POST /api/admin/users/:userId/revoke-sessions
   */
  async revokeUserSessions(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getRouteParam(req, "userId");
      if (!userId) {
        throw new AppError("A valid user ID is required", 400);
      }

      const validation = revokeUserSessionsSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await platformAdminGovernanceService.revokeUserSessions({
        userId,
        reason: validation.data.reason,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: "Active user sessions revoked successfully",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/platform-admin/users/:userId/status
   * PATCH /api/admin/users/:userId/status
   */
  async updateUserStatus(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getRouteParam(req, "userId");
      if (!userId) {
        throw new AppError("A valid user ID is required", 400);
      }

      const validation = updateUserStatusSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await platformAdminGovernanceService.updateUserStatus({
        userId,
        isActive: validation.data.isActive,
        reason: validation.data.reason,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: `User account ${validation.data.isActive ? "activated" : "deactivated"} successfully`,
        data: { user: result },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/platform-admin/users/:userId
   * DELETE /api/admin/users/:userId
   */
  async deleteAbandonedUser(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getRouteParam(req, "userId");
      if (!userId) {
        throw new AppError("A valid user ID is required", 400);
      }

      const validation = deleteUserSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed. You must provide confirmation: 'DELETE'",
          errors: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const adminUser = req.admin?.user || (req as any).user;
      if (!adminUser) {
        throw new AppError("Platform administrator authentication required", 401);
      }

      const ipAddress =
        req.ip || (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await platformAdminGovernanceService.deleteAbandonedUser({
        userId,
        confirmation: validation.data.confirmation,
        adminUser: { id: adminUser.id, email: adminUser.email },
        ipAddress,
        userAgent,
      });

      res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const platformAdminGovernanceController = new PlatformAdminGovernanceController();
