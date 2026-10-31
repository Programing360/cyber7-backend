import { Router } from "express";

import {
  connectWhatsAppController,
  updateWhatsAppStatusController,
  disconnectWhatsAppController,
  getWhatsAppAccountsController,
  getWhatsAppAccountByIdController,
  getWhatsAppConfigStatusController,
  sendWhatsAppMessage,
} from "./whatsapp.controller.js";

import {
  listContactsController,
  getContactByIdController,
  createContactController,
  updateContactController,
  deleteContactController,
  listConversationsController,
  getConversationByIdController,
  updateConversationStatusController,
  listConversationMessagesController,
} from "./whatsapp-chat.controller.js";

import {
  listTemplatesController,
  getTemplateByIdController,
  syncTemplatesController,
} from "./template.controller.js";

import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";
import {
  receiveWhatsAppWebhook,
  verifyWhatsAppWebhook,
} from "../controllers/whatsapp-webhook.controller.js";

const whatsappRoutes = Router();

// Public Webhook Routes
whatsappRoutes.get("/webhook", verifyWhatsAppWebhook);
whatsappRoutes.post("/webhook", receiveWhatsAppWebhook);

// Protected Account Routes
whatsappRoutes.get(
  "/:workspaceId/config-status",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getWhatsAppConfigStatusController,
);

whatsappRoutes.get(
  "/:workspaceId/accounts",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  getWhatsAppAccountsController,
);

whatsappRoutes.post(
  "/:workspaceId/accounts",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  connectWhatsAppController,
);

whatsappRoutes.get(
  "/:workspaceId/accounts/:accountId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  getWhatsAppAccountByIdController,
);

whatsappRoutes.patch(
  "/:workspaceId/accounts/:accountId/status",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  updateWhatsAppStatusController,
);

whatsappRoutes.delete(
  "/:workspaceId/accounts/:accountId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  disconnectWhatsAppController,
);

// Contacts Routes
whatsappRoutes.get(
  "/:workspaceId/contacts",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  listContactsController,
);

whatsappRoutes.post(
  "/:workspaceId/contacts",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  createContactController,
);

whatsappRoutes.get(
  "/:workspaceId/contacts/:contactId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getContactByIdController,
);

whatsappRoutes.patch(
  "/:workspaceId/contacts/:contactId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  updateContactController,
);

whatsappRoutes.delete(
  "/:workspaceId/contacts/:contactId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  deleteContactController,
);

// Conversations Routes
whatsappRoutes.get(
  "/:workspaceId/conversations",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  listConversationsController,
);

whatsappRoutes.get(
  "/:workspaceId/conversations/:conversationId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getConversationByIdController,
);

whatsappRoutes.patch(
  "/:workspaceId/conversations/:conversationId/status",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  updateConversationStatusController,
);

// Messages History Route
whatsappRoutes.get(
  "/:workspaceId/conversations/:conversationId/messages",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  listConversationMessagesController,
);

// Outbound Message Route
whatsappRoutes.post(
  "/:workspaceId/messages",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  sendWhatsAppMessage,
);

// Template Routes
whatsappRoutes.get(
  "/:workspaceId/templates",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  listTemplatesController,
);

whatsappRoutes.post(
  "/:workspaceId/templates/sync",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN"),
  syncTemplatesController,
);

whatsappRoutes.get(
  "/:workspaceId/templates/:templateId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getTemplateByIdController,
);

export default whatsappRoutes;
