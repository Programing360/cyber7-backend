import { Router } from "express";
import { requireBffAssertion } from "../../middlewares/verify-bff-assertion.js";
import {
  authenticateAdminSession,
  requireAdminPlatformRole,
} from "../../middlewares/authenticate-admin-session.js";
import { supportTicketController } from "./support-ticket.controller.js";

export const supportTicketRouter = Router();

// Base administrative protection pipeline
supportTicketRouter.use(requireBffAssertion);
supportTicketRouter.use(authenticateAdminSession);

// List tickets (Accessible to SUPER_ADMIN and FINANCE_ADMIN)
supportTicketRouter.get(
  "/tickets",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.listTickets(req, res, next),
);
supportTicketRouter.get(
  "/",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.listTickets(req, res, next),
);

// Create new ticket
supportTicketRouter.post(
  "/tickets",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.createTicket(req, res, next),
);
supportTicketRouter.post(
  "/",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.createTicket(req, res, next),
);

// Assign ticket
supportTicketRouter.patch(
  "/tickets/:ticketId/assign",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.assignTicket(req, res, next),
);
supportTicketRouter.patch(
  "/:ticketId/assign",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.assignTicket(req, res, next),
);

// Update ticket status
supportTicketRouter.patch(
  "/tickets/:ticketId/status",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.updateStatus(req, res, next),
);
supportTicketRouter.patch(
  "/:ticketId/status",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.updateStatus(req, res, next),
);

// Append message
supportTicketRouter.post(
  "/tickets/:ticketId/messages",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.addMessage(req, res, next),
);
supportTicketRouter.post(
  "/:ticketId/messages",
  requireAdminPlatformRole("SUPER_ADMIN", "FINANCE_ADMIN"),
  (req, res, next) => supportTicketController.addMessage(req, res, next),
);

export default supportTicketRouter;
