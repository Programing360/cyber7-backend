import { Router } from "express";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";
import { platformSettingsController } from "./platform-settings.controller.js";

export const platformSettingsRouter = Router();

// Base administrative protection pipeline
platformSettingsRouter.use(requireBffAssertion);
platformSettingsRouter.use(authenticateAdminSession);

// Get platform settings (SUPER_ADMIN and FINANCE_ADMIN)
platformSettingsRouter.get(
  "/",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => platformSettingsController.getSettings(req, res, next),
);

// Update platform settings (SUPER_ADMIN only)
platformSettingsRouter.patch(
  "/",
  requireAdminPlatformRole("SUPER_ADMIN"),
  (req, res, next) => platformSettingsController.updateSettings(req, res, next),
);

export default platformSettingsRouter;

