import mongoose, { type Types } from "mongoose";
import SupportTicket, {
  type ISupportTicket,
  type TicketStatus,
} from "./support-ticket.model.js";
import Workspace from "../workspace/workspace.model.js";
import User from "../auth/user.model.js";
import { adminSecurityAuditService } from "../admin-auth/admin-security-audit.service.js";
import type {
  CreateTicketInput,
  ListTicketsQuery,
  AddTicketMessageInput,
} from "./support-ticket.validation.js";

export interface AdminActorContext {
  adminUserId?: string | Types.ObjectId;
  adminEmail?: string;
  sessionId?: string | Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
}

export class SupportTicketService {
  /**
   * Generate next sequential/unique ticket identifier (e.g. TICK-1001)
   */
  public async generateNextTicketNumber(): Promise<string> {
    try {
      const count = await SupportTicket.countDocuments();
      let seq = count + 1001;
      let candidate = `TICK-${seq}`;

      if (
        mongoose.connection.readyState !== 1 &&
        process.env.NODE_ENV !== "production"
      ) {
        return candidate;
      }

      // Check collision
      let existing = await SupportTicket.findOne({ ticketNumber: candidate });
      while (existing) {
        seq += 1;
        candidate = `TICK-${seq}`;
        existing = await SupportTicket.findOne({ ticketNumber: candidate });
      }

      return candidate;
    } catch {
      const rand = Math.floor(1000 + Math.random() * 9000);
      return `TICK-${Date.now().toString().slice(-4)}${rand}`;
    }
  }

  /**
   * List support tickets with pagination, status/priority filtering, and text search
   */
  public async listTickets(query: ListTicketsQuery): Promise<{
    items: ISupportTicket[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const filter: Record<string, any> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.priority) {
      filter.priority = query.priority;
    }

    if (query.search?.trim()) {
      const s = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(s, "i");
      filter.$or = [
        { ticketNumber: searchRegex },
        { workspaceName: searchRegex },
        { customerEmail: searchRegex },
        { customerName: searchRegex },
        { subject: searchRegex },
      ];
    }

    const page = Math.max(1, query.page || 1);
    const pageSize = Math.max(1, Math.min(100, query.pageSize || 10));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      SupportTicket.find(filter)
        .populate("assignedAdmin", "name email platformRole")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / pageSize) || 1;

    return {
      items: items as unknown as ISupportTicket[],
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  /**
   * Create a new support ticket
   */
  public async createTicket(
    input: CreateTicketInput,
    actor: AdminActorContext,
  ): Promise<ISupportTicket> {
    let workspaceName = input.workspaceName?.trim();
    if (!workspaceName) {
      const ws = await Workspace.findById(input.workspaceId);
      workspaceName = ws?.name || "Workspace Customer";
    }

    const ticketNumber = await this.generateNextTicketNumber();
    const senderId = actor.adminUserId
      ? new mongoose.Types.ObjectId(actor.adminUserId)
      : new mongoose.Types.ObjectId();

    const ticket = new SupportTicket({
      ticketNumber,
      workspaceId: new mongoose.Types.ObjectId(input.workspaceId),
      workspaceName,
      customerName: input.customerName.trim(),
      customerEmail: input.customerEmail.trim().toLowerCase(),
      subject: input.subject.trim(),
      priority: input.priority || "MEDIUM",
      status: "OPEN",
      assignedAdmin: null,
      messages: [
        {
          senderId,
          senderRole: "PLATFORM_ADMIN",
          content: input.initialMessage.trim(),
          attachments: input.attachments || [],
          createdAt: new Date(),
        },
      ],
    });

    await ticket.save();

    await adminSecurityAuditService.recordSecurityEvent({
      eventType: "SUPPORT_TICKET_CREATED",
      adminUserId: actor.adminUserId,
      adminEmail: actor.adminEmail,
      sessionId: actor.sessionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      reason: `Support ticket ${ticket.ticketNumber} created for workspace ${workspaceName}`,
      metadata: {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        workspaceId: String(ticket.workspaceId),
        priority: ticket.priority,
        subject: ticket.subject,
      },
    });

    return ticket;
  }

  /**
   * Assign or reassign ticket to an administrator
   */
  public async assignTicket(
    ticketId: string,
    assignedAdminId: string | null,
    actor: AdminActorContext,
  ): Promise<ISupportTicket> {
    let query: Record<string, unknown> = { ticketNumber: ticketId };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = { $or: [{ _id: ticketId }, { ticketNumber: ticketId }] };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    if (assignedAdminId) {
      const adminUser = await User.findById(assignedAdminId);
      if (!adminUser) {
        throw new Error(`Admin user '${assignedAdminId}' not found.`);
      }
      ticket.assignedAdmin = new mongoose.Types.ObjectId(assignedAdminId);
    } else {
      ticket.assignedAdmin = null;
    }

    await ticket.save();

    await adminSecurityAuditService.recordSecurityEvent({
      eventType: "SUPPORT_TICKET_ASSIGNED",
      adminUserId: actor.adminUserId,
      adminEmail: actor.adminEmail,
      sessionId: actor.sessionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      reason: `Support ticket ${ticket.ticketNumber} assigned to ${assignedAdminId || "unassigned"}`,
      metadata: {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        assignedAdminId,
      },
    });

    return ticket;
  }

  /**
   * Update support ticket status
   */
  public async updateStatus(
    ticketId: string,
    status: TicketStatus,
    actor: AdminActorContext,
  ): Promise<ISupportTicket> {
    let query: Record<string, unknown> = { ticketNumber: ticketId };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = { $or: [{ _id: ticketId }, { ticketNumber: ticketId }] };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    const previousStatus = ticket.status;
    ticket.status = status;
    await ticket.save();

    await adminSecurityAuditService.recordSecurityEvent({
      eventType: "SUPPORT_TICKET_STATUS_UPDATED",
      adminUserId: actor.adminUserId,
      adminEmail: actor.adminEmail,
      sessionId: actor.sessionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      reason: `Support ticket ${ticket.ticketNumber} status changed from ${previousStatus} to ${status}`,
      metadata: {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        previousStatus,
        newStatus: status,
      },
    });

    return ticket;
  }

  /**
   * Append a reply message to the ticket
   */
  public async addMessage(
    ticketId: string,
    input: AddTicketMessageInput,
    actor: AdminActorContext,
  ): Promise<ISupportTicket> {
    let query: Record<string, unknown> = { ticketNumber: ticketId };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = { $or: [{ _id: ticketId }, { ticketNumber: ticketId }] };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    const senderId = actor.adminUserId
      ? new mongoose.Types.ObjectId(actor.adminUserId)
      : new mongoose.Types.ObjectId();

    ticket.messages.push({
      senderId,
      senderRole: "PLATFORM_ADMIN",
      content: input.content.trim(),
      attachments: input.attachments || [],
      createdAt: new Date(),
    });

    // Auto-advance OPEN ticket to IN_PROGRESS upon admin reply
    if (ticket.status === "OPEN") {
      ticket.status = "IN_PROGRESS";
    }

    await ticket.save();

    await adminSecurityAuditService.recordSecurityEvent({
      eventType: "SUPPORT_TICKET_MESSAGE_ADDED",
      adminUserId: actor.adminUserId,
      adminEmail: actor.adminEmail,
      sessionId: actor.sessionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      reason: `Message reply added to ticket ${ticket.ticketNumber}`,
      metadata: {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        messageCount: ticket.messages.length,
      },
    });

    return ticket;
  }
}

export const supportTicketService = new SupportTicketService();
