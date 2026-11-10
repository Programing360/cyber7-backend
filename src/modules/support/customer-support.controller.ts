import type { Response, NextFunction } from "express";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";
import {
  listTicketsQuerySchema,
  createCustomerTicketSchema,
  addTicketMessageSchema,
  updateTicketStatusSchema,
  updateTicketPrioritySchema,
} from "./support-ticket.validation.js";
import {
  supportTicketService,
  type CustomerActorContext,
} from "./support-ticket.service.js";

function getCustomerContext(req: WorkspaceRequest): CustomerActorContext {
  const user = req.user;
  return {
    userId: String(user?.id || (user as any)?._id || ""),
    userName: user?.name,
    userEmail: String(user?.email || ""),
  };
}

function resolveWorkspaceId(req: WorkspaceRequest): string {
  return (
    req.workspace?.id ||
    (req.params.workspaceId as string) ||
    (req.query.workspaceId as string) ||
    (req.headers["x-workspace-id"] as string) ||
    req.body?.workspaceId ||
    ""
  );
}

export class CustomerSupportTicketController {
  /**
   * GET /api/support/tickets or /api/workspaces/:workspaceId/support/tickets
   */
  async listTickets(
    req: WorkspaceRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = resolveWorkspaceId(req);
      if (!workspaceId) {
        res.status(400).json({
          success: false,
          error: "A valid workspace ID is required.",
        });
        return;
      }

      const parsed = listTicketsQuerySchema.safeParse({
        ...req.query,
        workspaceId,
      });

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Invalid query parameters.",
          details: parsed.error.issues,
        });
        return;
      }

      const result = await supportTicketService.listTickets(parsed.data);

      res.status(200).json({
        success: true,
        message: "Support tickets retrieved successfully.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/support/tickets or /api/workspaces/:workspaceId/support/tickets
   */
  async createTicket(
    req: WorkspaceRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = resolveWorkspaceId(req);
      if (!workspaceId) {
        res.status(400).json({
          success: false,
          error: "A valid workspace ID is required.",
        });
        return;
      }

      const parsed = createCustomerTicketSchema.safeParse({
        ...req.body,
        workspaceId,
      });

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getCustomerContext(req);
      const ticket = await supportTicketService.createTicketAsCustomer(
        {
          ...parsed.data,
          workspaceId,
        },
        actor,
      );

      res.status(201).json({
        success: true,
        message: "Support ticket created successfully.",
        data: ticket,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/support/tickets/:ticketId
   */
  async getTicket(
    req: WorkspaceRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const ticketId = String(req.params.ticketId || "").trim();

      if (!workspaceId || !ticketId) {
        res.status(400).json({
          success: false,
          error: "Workspace ID and Ticket ID are required.",
        });
        return;
      }

      const ticket = await supportTicketService.getTicketDetailsAsCustomer(
        ticketId,
        workspaceId,
      );

      res.status(200).json({
        success: true,
        data: ticket,
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to retrieve ticket";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, error: msg });
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/support/tickets/:ticketId/messages
   */
  async addMessage(
    req: WorkspaceRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const ticketId = String(req.params.ticketId || "").trim();

      if (!workspaceId || !ticketId) {
        res.status(400).json({
          success: false,
          error: "Workspace ID and Ticket ID are required.",
        });
        return;
      }

      const parsed = addTicketMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getCustomerContext(req);
      const ticket = await supportTicketService.addMessageAsCustomer(
        ticketId,
        workspaceId,
        parsed.data.content,
        actor,
      );

      res.status(201).json({
        success: true,
        message: "Message added to ticket successfully.",
        data: ticket,
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to add message to ticket";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, error: msg });
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/support/tickets/:ticketId/status
   */
  async updateStatus(
    req: WorkspaceRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const ticketId = String(req.params.ticketId || "").trim();

      if (!workspaceId || !ticketId) {
        res.status(400).json({
          success: false,
          error: "Workspace ID and Ticket ID are required.",
        });
        return;
      }

      const parsed = updateTicketStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getCustomerContext(req);
      const ticket = await supportTicketService.updateStatusAsCustomer(
        ticketId,
        workspaceId,
        parsed.data.status,
        actor,
      );

      res.status(200).json({
        success: true,
        message: "Ticket status updated successfully.",
        data: ticket,
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to update ticket status";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, error: msg });
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/support/tickets/:ticketId/priority
   */
  async updatePriority(
    req: WorkspaceRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const ticketId = String(req.params.ticketId || "").trim();

      if (!workspaceId || !ticketId) {
        res.status(400).json({
          success: false,
          error: "Workspace ID and Ticket ID are required.",
        });
        return;
      }

      const parsed = updateTicketPrioritySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getCustomerContext(req);
      const ticket = await supportTicketService.updatePriorityAsCustomer(
        ticketId,
        workspaceId,
        parsed.data.priority,
        actor,
      );

      res.status(200).json({
        success: true,
        message: "Ticket priority updated successfully.",
        data: ticket,
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to update ticket priority";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, error: msg });
        return;
      }
      next(error);
    }
  }
}

export const customerSupportTicketController =
  new CustomerSupportTicketController();
