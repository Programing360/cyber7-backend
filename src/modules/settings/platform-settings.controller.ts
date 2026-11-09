import type { Request, Response, NextFunction } from "express";
import { updatePlatformSettingsSchema } from "./platform-settings.validation.js";
import { platformSettingsService } from "./platform-settings.service.js";

function getAdminContext(req: Request) {
  const adminUser = (req as any).admin?.user;
  const adminSession = (req as any).admin?.session;

  return {
    adminUserId: adminUser?._id,
    adminEmail: adminUser?.email,
    sessionId: adminSession?._id,
    ipAddress:
      req.ip || (req.headers["x-forwarded-for"] as string) || "127.0.0.1",
    userAgent: req.headers["user-agent"] || "unknown",
  };
}

export class PlatformSettingsController {
  /**
   * GET /api/platform-admin/settings
   */
  async getSettings(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const settings = await platformSettingsService.getSettings();

      res.status(200).json({
        success: true,
        data: settings,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/platform-admin/settings
   */
  async updateSettings(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const parsed = updatePlatformSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getAdminContext(req);
      const settings = await platformSettingsService.updateSettings(
        parsed.data,
        actor,
      );

      res.status(200).json({
        success: true,
        message: "Platform settings updated successfully.",
        data: settings,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const platformSettingsController = new PlatformSettingsController();

