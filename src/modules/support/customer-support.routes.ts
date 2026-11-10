import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";
import { customerSupportTicketController } from "./customer-support.controller.js";

export const customerSupportRouter = Router();

customerSupportRouter.use(authenticate);
customerSupportRouter.use(requireWorkspaceMembership);
customerSupportRouter.use(requireRole("OWNER", "ADMIN", "AGENT"));

// List tickets & stats for workspace
customerSupportRouter.get(
  "/tickets",
  customerSupportTicketController.listTickets,
);
customerSupportRouter.get("/", customerSupportTicketController.listTickets);

// Create new support ticket from workspace
customerSupportRouter.post(
  "/tickets",
  customerSupportTicketController.createTicket,
);
customerSupportRouter.post("/", customerSupportTicketController.createTicket);

// Get single ticket details
customerSupportRouter.get(
  "/tickets/:ticketId",
  customerSupportTicketController.getTicket,
);
customerSupportRouter.get(
  "/:ticketId",
  customerSupportTicketController.getTicket,
);

// Append customer reply message
customerSupportRouter.post(
  "/tickets/:ticketId/messages",
  customerSupportTicketController.addMessage,
);
customerSupportRouter.post(
  "/:ticketId/messages",
  customerSupportTicketController.addMessage,
);

// Update status (e.g. customer marks resolved/closed/reopened)
customerSupportRouter.patch(
  "/tickets/:ticketId/status",
  customerSupportTicketController.updateStatus,
);
customerSupportRouter.patch(
  "/:ticketId/status",
  customerSupportTicketController.updateStatus,
);

// Update priority
customerSupportRouter.patch(
  "/tickets/:ticketId/priority",
  customerSupportTicketController.updatePriority,
);
customerSupportRouter.patch(
  "/:ticketId/priority",
  customerSupportTicketController.updatePriority,
);

export default customerSupportRouter;

