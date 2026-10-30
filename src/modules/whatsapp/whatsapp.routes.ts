import { Router } from "express";

import {
  connectWhatsAppController,
  listWhatsAppAccountsController,
  getWhatsAppAccountController,
  updateWhatsAppStatusController,
  disconnectWhatsAppController,
  verifyWebhookController,
  handleWebhookController,
  getWhatsAppAccountsController,
  getWhatsAppAccountByIdController,
} from "./whatsapp.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";
import { receiveWhatsAppWebhook, verifyWhatsAppWebhook } from "../controllers/whatsapp-webhook.controller.js";

const whatsappRoutes = Router();

// ─── Webhook (public — no auth, called by Meta) ───────────────────────────────
whatsappRoutes.get("/webhook", verifyWebhookController);
whatsappRoutes.post("/webhook", handleWebhookController);

// ─── Protected workspace-scoped routes ────────────────────────────────────────

// List all connected WhatsApp accounts for a workspace
whatsappRoutes.get(
  "/:workspaceId/accounts",
  authenticate,
  requireWorkspaceMembership,
  listWhatsAppAccountsController,
);

// Connect (register) a new WhatsApp Business account
whatsappRoutes.post(
  "/:workspaceId/accounts",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  connectWhatsAppController,
);

// Get a single WhatsApp account
whatsappRoutes.get(
  "/:workspaceId/accounts/:accountId",
  authenticate,
  requireWorkspaceMembership,
  getWhatsAppAccountController,
);

whatsappRoutes.get(
  "/:workspaceId/accounts",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  getWhatsAppAccountsController,
);

// Update the connection status of a WhatsApp account
whatsappRoutes.patch(
  "/:workspaceId/accounts/:accountId/status",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  updateWhatsAppStatusController,
);

// Disconnect (delete) a WhatsApp account
whatsappRoutes.delete(
  "/:workspaceId/accounts/:accountId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  disconnectWhatsAppController,
);

whatsappRoutes.get(
  "/:workspaceId/accounts/:accountId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  getWhatsAppAccountByIdController,
);

whatsappRoutes.get(
  "/webhook",
  verifyWhatsAppWebhook,
);

whatsappRoutes.post(
  "/webhook",
  receiveWhatsAppWebhook,
);

export default whatsappRoutes;
