import mongoose, { Schema, type Document, type Types } from "mongoose";

export type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
export type MessageSenderRole = "CUSTOMER" | "PLATFORM_ADMIN";

export interface ISupportMessageAttachment {
  filename: string;
  url: string;
}

export interface ISupportMessage {
  _id?: Types.ObjectId;
  senderId: Types.ObjectId;
  senderRole: MessageSenderRole;
  senderName?: string;
  content: string;
  attachments?: ISupportMessageAttachment[];
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  _id: Types.ObjectId;
  ticketNumber: string;
  workspaceId: Types.ObjectId;
  workspaceName: string;
  customerName: string;
  customerEmail: string;
  subject: string;
  category?: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedAdmin: Types.ObjectId | null;
  messages: ISupportMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const supportMessageAttachmentSchema = new Schema<ISupportMessageAttachment>(
  {
    filename: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const supportMessageSchema = new Schema<ISupportMessage>(
  {
    senderId: { type: Schema.Types.ObjectId, required: true },
    senderRole: {
      type: String,
      enum: ["CUSTOMER", "PLATFORM_ADMIN"],
      required: true,
    },
    senderName: { type: String, trim: true },
    content: { type: String, required: true, trim: true },
    attachments: { type: [supportMessageAttachmentSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    workspaceName: {
      type: String,
      required: true,
      trim: true,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    customerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      default: "Technical Issue",
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      default: "MEDIUM",
      index: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: "OPEN",
      index: true,
    },
    assignedAdmin: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    messages: {
      type: [supportMessageSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Composite search index
supportTicketSchema.index({
  ticketNumber: 1,
  workspaceName: 1,
  customerEmail: 1,
  subject: 1,
});

supportTicketSchema.index({ createdAt: -1 });

const SupportTicket = mongoose.model<ISupportTicket>(
  "SupportTicket",
  supportTicketSchema,
);

export default SupportTicket;

