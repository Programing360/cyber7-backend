import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./authenticate.js";

export type PlatformRole = "USER" | "FINANCE_ADMIN" | "SUPER_ADMIN";

export const requirePlatformAdmin = (
  ...allowedRoles: Array<"FINANCE_ADMIN" | "SUPER_ADMIN">
) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const rolesToCheck: Array<"FINANCE_ADMIN" | "SUPER_ADMIN"> =
      allowedRoles.length > 0 ? allowedRoles : ["FINANCE_ADMIN", "SUPER_ADMIN"];

    const currentRole = (req.user.platformRole || "USER") as PlatformRole;

    if (!rolesToCheck.includes(currentRole as "FINANCE_ADMIN" | "SUPER_ADMIN")) {
      res.status(403).json({
        success: false,
        message: "Platform administrator authorization required",
      });
      return;
    }

    next();
  };
};

