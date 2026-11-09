import { z } from "zod";

export const ticketPriorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
export const ticketStatusEnum = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);

export const supportAttachmentSchema = z.object({
  filename: z.string().trim().min(1, "Attachment filename is required"),
  url: z.string().trim().url("Attachment url must be a valid URL"),
});

export const createTicketSchema = z.object({
  workspaceId: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "Invalid workspace ID format"),
  workspaceName: z.string().trim().optional(),
  customerName: z.string().trim().min(1, "Customer name is required"),
  customerEmail: z.string().trim().email("Invalid customer email address"),
  subject: z.string().trim().min(3, "Subject must be at least 3 characters"),
  priority: ticketPriorityEnum.default("MEDIUM"),
  initialMessage: z.string().trim().min(1, "Initial message is required"),
  attachments: z.array(supportAttachmentSchema).optional().default([]),
});

export const updateTicketStatusSchema = z.object({
  status: ticketStatusEnum,
});

export const assignTicketSchema = z.object({
  assignedAdminId: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "Invalid admin ID format")
    .nullable(),
});

export const addTicketMessageSchema = z.object({
  content: z.string().trim().min(1, "Message content is required"),
  attachments: z.array(supportAttachmentSchema).optional().default([]),
});

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z
    .union([ticketStatusEnum, z.literal("ALL")])
    .optional()
    .transform((val) => (val === "ALL" ? undefined : val)),
  priority: z
    .union([ticketPriorityEnum, z.literal("ALL")])
    .optional()
    .transform((val) => (val === "ALL" ? undefined : val)),
  search: z.string().trim().optional(),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;
export type AssignTicketInput = z.infer<typeof assignTicketSchema>;
export type AddTicketMessageInput = z.infer<typeof addTicketMessageSchema>;
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

