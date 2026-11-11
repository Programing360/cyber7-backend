import mongoose, { type Types } from "mongoose";
import SupportTicket, {
  type ISupportTicket,
  type TicketStatus,
  type TicketPriority,
} from "./support-ticket.model.js";
import Workspace from "../workspace/workspace.model.js";
import User from "../auth/user.model.js";
import { adminSecurityAuditService } from "../admin-auth/admin-security-audit.service.js";
import type {
  CreateTicketInput,
  CreateCustomerTicketInput,
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

export interface CustomerActorContext {
  userId: string;
  userName?: string;
  userEmail: string;
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
    stats?: {
      total: number;
      open: number;
      inProgress: number;
      resolved: number;
    };
  }> {
    const filter: Record<string, any> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.priority) {
      filter.priority = query.priority;
    }

    if (
      query.workspaceId &&
      mongoose.Types.ObjectId.isValid(query.workspaceId)
    ) {
      filter.workspaceId = new mongoose.Types.ObjectId(query.workspaceId);
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

    const statsFilter: Record<string, any> = {};
    if (
      query.workspaceId &&
      mongoose.Types.ObjectId.isValid(query.workspaceId)
    ) {
      statsFilter.workspaceId = new mongoose.Types.ObjectId(query.workspaceId);
    }

    const [allTotal, openTotal, inProgressTotal, resolvedTotal, urgentTotal] =
      await Promise.all([
        SupportTicket.countDocuments(statsFilter),
        SupportTicket.countDocuments({
          ...statsFilter,
          status: "OPEN",
        }),
        SupportTicket.countDocuments({
          ...statsFilter,
          status: "IN_PROGRESS",
        }),
        SupportTicket.countDocuments({
          ...statsFilter,
          status: { $in: ["RESOLVED", "CLOSED"] },
        }),
        SupportTicket.countDocuments({
          ...statsFilter,
          priority: { $in: ["HIGH", "URGENT"] },
          status: { $nin: ["RESOLVED", "CLOSED"] },
        }),
      ]);

    const stats = {
      total: allTotal,
      open: openTotal,
      inProgress: inProgressTotal,
      resolved: resolvedTotal,
      urgent: urgentTotal,
    };

    const mappedItems = items.map((doc: any) => ({
      ...doc,
      id: doc._id?.toString() || doc.ticketNumber,
      assignedAdminId:
        doc.assignedAdmin && typeof doc.assignedAdmin === "object"
          ? doc.assignedAdmin._id?.toString() || doc.assignedAdmin.id?.toString() || null
          : doc.assignedAdmin
            ? String(doc.assignedAdmin)
            : null,
      assignedAdmin:
        doc.assignedAdmin && typeof doc.assignedAdmin === "object"
          ? doc.assignedAdmin.name || doc.assignedAdmin.email || null
          : doc.assignedAdmin || null,
    }));

    return {
      items: mappedItems as unknown as ISupportTicket[],
      total,
      page,
      pageSize,
      totalPages,
      stats,
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
    const cleanTicketId = String(ticketId || "").trim();
    let query: Record<string, unknown> = { ticketNumber: cleanTicketId };
    if (mongoose.Types.ObjectId.isValid(cleanTicketId)) {
      query = {
        $or: [
          { _id: new mongoose.Types.ObjectId(cleanTicketId) },
          { ticketNumber: cleanTicketId },
        ],
      };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${cleanTicketId}' not found.`);
    }

    if (assignedAdminId && String(assignedAdminId).trim()) {
      const cleanAdminId = String(assignedAdminId).trim();
      let adminUser: any = null;

      if (mongoose.Types.ObjectId.isValid(cleanAdminId)) {
        adminUser = await User.findById(cleanAdminId);
      }
      if (!adminUser) {
        adminUser = await User.findOne({
          email: cleanAdminId.toLowerCase(),
        });
      }
      if (!adminUser) {
        const nameMatches = await User.find({
          name: {
            $regex: new RegExp(
              `^${cleanAdminId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
              "i",
            ),
          },
          platformRole: { $in: ["SUPER_ADMIN", "FINANCE_ADMIN"] },
        });
        if (nameMatches.length === 1) {
          adminUser = nameMatches[0];
        }
      }
      if (!adminUser) {
        throw new Error(
          `Admin user '${cleanAdminId}' not found. Please provide a valid admin ID, email, or select an active administrator.`,
        );
      }
      ticket.assignedAdmin = adminUser._id as Types.ObjectId;
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

    if (typeof (ticket as any).populate === "function") {
      await (ticket as any).populate("assignedAdmin", "name email platformRole");
    }
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
    const cleanTicketId = String(ticketId || "").trim();
    let query: Record<string, unknown> = { ticketNumber: cleanTicketId };
    if (mongoose.Types.ObjectId.isValid(cleanTicketId)) {
      query = {
        $or: [
          { _id: new mongoose.Types.ObjectId(cleanTicketId) },
          { ticketNumber: cleanTicketId },
        ],
      };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${cleanTicketId}' not found.`);
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

    if (typeof (ticket as any).populate === "function") {
      await (ticket as any).populate("assignedAdmin", "name email platformRole");
    }
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
    const cleanTicketId = String(ticketId || "").trim();
    let query: Record<string, unknown> = { ticketNumber: cleanTicketId };
    if (mongoose.Types.ObjectId.isValid(cleanTicketId)) {
      query = {
        $or: [
          { _id: new mongoose.Types.ObjectId(cleanTicketId) },
          { ticketNumber: cleanTicketId },
        ],
      };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${cleanTicketId}' not found.`);
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

    if (typeof (ticket as any).populate === "function") {
      await (ticket as any).populate("assignedAdmin", "name email platformRole");
    }
    return ticket;
  }

  /**
   * Customer: Create a support ticket from workspace dashboard
   */
  public async createTicketAsCustomer(
    input: CreateCustomerTicketInput,
    actor: CustomerActorContext,
  ): Promise<ISupportTicket> {
    const wsId = input.workspaceId;
    if (!wsId || !mongoose.Types.ObjectId.isValid(wsId)) {
      throw new Error("A valid workspace ID is required to create a ticket.");
    }

    const ws = await Workspace.findById(wsId);
    const workspaceName = ws?.name || "Workspace";

    const ticketNumber = await this.generateNextTicketNumber();
    const senderId = new mongoose.Types.ObjectId(actor.userId);
    const customerName =
      input.customerName?.trim() || actor.userName || "Customer";
    const customerEmail =
      input.customerEmail?.trim().toLowerCase() ||
      actor.userEmail.toLowerCase();

    const ticket = new SupportTicket({
      ticketNumber,
      workspaceId: new mongoose.Types.ObjectId(wsId),
      workspaceName,
      customerName,
      customerEmail,
      subject: input.subject.trim(),
      category: input.category?.trim() || "Technical Issue",
      priority: (input.priority || "MEDIUM").toUpperCase(),
      status: "OPEN",
      assignedAdmin: null,
      messages: [
        {
          senderId,
          senderRole: "CUSTOMER",
          senderName: customerName,
          content: input.description.trim(),
          attachments: input.attachments || [],
          createdAt: new Date(),
        },
      ],
    });

    await ticket.save();
    return ticket;
  }

  /**
   * Customer: Get details of a ticket belonging to their workspace
   */
  public async getTicketDetailsAsCustomer(
    ticketId: string,
    workspaceId: string,
  ): Promise<ISupportTicket> {
    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
    let query: Record<string, unknown> = {
      ticketNumber: ticketId,
      workspaceId: wsObjectId,
    };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = {
        $or: [{ _id: ticketId }, { ticketNumber: ticketId }],
        workspaceId: wsObjectId,
      };
    }

    const ticket = await SupportTicket.findOne(query)
      .populate("assignedAdmin", "name email platformRole")
      .lean();

    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    return ticket as unknown as ISupportTicket;
  }

  /**
   * Customer: Append message reply to ticket
   */
  public async addMessageAsCustomer(
    ticketId: string,
    workspaceId: string,
    content: string,
    actor: CustomerActorContext,
  ): Promise<ISupportTicket> {
    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
    let query: Record<string, unknown> = {
      ticketNumber: ticketId,
      workspaceId: wsObjectId,
    };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = {
        $or: [{ _id: ticketId }, { ticketNumber: ticketId }],
        workspaceId: wsObjectId,
      };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    ticket.messages.push({
      senderId: new mongoose.Types.ObjectId(actor.userId),
      senderRole: "CUSTOMER",
      senderName: actor.userName || "Customer",
      content: content.trim(),
      attachments: [],
      createdAt: new Date(),
    });

    // If ticket was resolved or closed, customer reply reopens it
    if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
      ticket.status = "OPEN";
    }

    await ticket.save();
    return ticket;
  }

  /**
   * Customer: Update ticket status (e.g. resolve or reopen)
   */
  public async updateStatusAsCustomer(
    ticketId: string,
    workspaceId: string,
    status: TicketStatus,
    _actor: CustomerActorContext,
  ): Promise<ISupportTicket> {
    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
    let query: Record<string, unknown> = {
      ticketNumber: ticketId,
      workspaceId: wsObjectId,
    };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = {
        $or: [{ _id: ticketId }, { ticketNumber: ticketId }],
        workspaceId: wsObjectId,
      };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    ticket.status = status;
    await ticket.save();
    return ticket;
  }

  /**
   * Customer: Update ticket priority
   */
  public async updatePriorityAsCustomer(
    ticketId: string,
    workspaceId: string,
    priority: TicketPriority,
    _actor: CustomerActorContext,
  ): Promise<ISupportTicket> {
    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
    let query: Record<string, unknown> = {
      ticketNumber: ticketId,
      workspaceId: wsObjectId,
    };
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      query = {
        $or: [{ _id: ticketId }, { ticketNumber: ticketId }],
        workspaceId: wsObjectId,
      };
    }

    const ticket = await SupportTicket.findOne(query);
    if (!ticket) {
      throw new Error(`Support ticket '${ticketId}' not found.`);
    }

    ticket.priority = priority;
    await ticket.save();
    return ticket;
  }
}

export const supportTicketService = new SupportTicketService();
