import type { Request, Response, NextFunction } from "express";
import {
  createTicketSchema,
  updateTicketStatusSchema,
  assignTicketSchema,
  addTicketMessageSchema,
  listTicketsQuerySchema,
} from "./support-ticket.validation.js";
import {
  supportTicketService,
  type AdminActorContext,
} from "./support-ticket.service.js";

function getAdminContext(req: Request): AdminActorContext {
  const adminUser = (req as any).admin?.user;
  const adminSession = (req as any).admin?.session;

  return {
    adminUserId: adminUser?.id || adminUser?._id,
    adminEmail: adminUser?.email,
    sessionId: adminSession?.id || adminSession?._id,
    ipAddress:
      req.ip || (req.headers["x-forwarded-for"] as string) || "127.0.0.1",
    userAgent: req.headers["user-agent"] || "unknown",
  };
}

export function formatTicketResponse(ticket: any): any {
  if (!ticket) return ticket;
  const plain =
    typeof ticket.toObject === "function" ? ticket.toObject() : { ...ticket };

  const id =
    (plain._id ? plain._id.toString() : plain.id) ||
    plain.ticketNumber ||
    "";

  let assignedAdminName: string | null = null;
  let assignedAdminId: string | null = null;

  if (plain.assignedAdmin) {
    if (typeof plain.assignedAdmin === "object") {
      assignedAdminId =
        plain.assignedAdmin._id?.toString() ||
        plain.assignedAdmin.id?.toString() ||
        null;
      assignedAdminName =
        plain.assignedAdmin.name ||
        plain.assignedAdmin.email ||
        (assignedAdminId ? `Admin (${assignedAdminId.slice(-4)})` : null);
    } else if (typeof plain.assignedAdmin === "string") {
      if (/^[0-9a-fA-F]{24}$/.test(plain.assignedAdmin)) {
        assignedAdminId = plain.assignedAdmin;
      } else {
        assignedAdminName = plain.assignedAdmin;
      }
    }
  }

  if (plain.assignedAdminId && !assignedAdminId) {
    assignedAdminId = plain.assignedAdminId.toString();
  }

  return {
    ...plain,
    id,
    assignedAdminId,
    assignedAdmin: assignedAdminName,
  };
}

export class SupportTicketController {
  /**
   * GET /api/platform-admin/support/tickets
   */
  async listTickets(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const parsed = listTicketsQuerySchema.safeParse(req.query);
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
        data: {
          ...result,
          items: (result.items || []).map((t) => formatTicketResponse(t)),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/platform-admin/support/tickets
   */
  async createTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const parsed = createTicketSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getAdminContext(req);
      const ticket = await supportTicketService.createTicket(parsed.data, actor);

      res.status(201).json({
        success: true,
        message: "Support ticket created successfully.",
        data: formatTicketResponse(ticket),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/platform-admin/support/tickets/:ticketId/assign
   */
  async assignTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ticketId = String(req.params.ticketId || "").trim();
      if (!ticketId || ticketId === "undefined" || ticketId === "null") {
        res.status(400).json({
          success: false,
          error: "Ticket ID is required.",
        });
        return;
      }

      const parsed = assignTicketSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getAdminContext(req);
      const ticket = await supportTicketService.assignTicket(
        ticketId,
        parsed.data.assignedAdminId ?? null,
        actor,
      );

      res.status(200).json({
        success: true,
        message: "Ticket assigned successfully.",
        data: formatTicketResponse(ticket),
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to assign ticket";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, message: msg, error: msg });
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/platform-admin/support/tickets/:ticketId/status
   */
  async updateStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ticketId = String(req.params.ticketId || "").trim();
      if (!ticketId || ticketId === "undefined" || ticketId === "null") {
        res.status(400).json({
          success: false,
          message: "Ticket ID is required.",
          error: "Ticket ID is required.",
        });
        return;
      }

      const parsed = updateTicketStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          message: parsed.error.issues?.[0]?.message || "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getAdminContext(req);
      const ticket = await supportTicketService.updateStatus(
        ticketId,
        parsed.data.status,
        actor,
      );

      res.status(200).json({
        success: true,
        message: "Ticket status updated successfully.",
        data: formatTicketResponse(ticket),
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to update ticket status";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, message: msg, error: msg });
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/platform-admin/support/tickets/:ticketId/messages
   */
  async addMessage(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ticketId = String(req.params.ticketId || "").trim();
      if (!ticketId || ticketId === "undefined" || ticketId === "null") {
        res.status(400).json({
          success: false,
          message: "Ticket ID is required.",
          error: "Ticket ID is required.",
        });
        return;
      }

      const parsed = addTicketMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Validation failed.",
          message: parsed.error.issues?.[0]?.message || "Validation failed.",
          details: parsed.error.issues,
        });
        return;
      }

      const actor = getAdminContext(req);
      const ticket = await supportTicketService.addMessage(
        ticketId,
        parsed.data,
        actor,
      );

      res.status(201).json({
        success: true,
        message: "Message added to ticket successfully.",
        data: formatTicketResponse(ticket),
      });
    } catch (error: any) {
      const msg = error?.message || "Failed to add message to ticket";
      if (msg.toLowerCase().includes("not found")) {
        res.status(404).json({ success: false, message: msg, error: msg });
        return;
      }
      next(error);
    }
  }
}

export const supportTicketController = new SupportTicketController();

