import { Router } from "express";

import { connectWhatsAppController } from "./whatsapp.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";

const whatsappRoutes = Router();

whatsappRoutes.post(
  "/:workspaceId/connect",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  connectWhatsAppController,
);

export default whatsappRoutes;
