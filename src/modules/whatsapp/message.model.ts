import mongoose, { Schema, Document, Model } from "mongoose";

export type WhatsAppMessageDirection = "INBOUND" | "OUTBOUND";

export type WhatsAppMessageType =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "DOCUMENT"
  | "LOCATION"
  | "TEMPLATE"
  | "INTERACTIVE"
  | "UNKNOWN";

export type WhatsAppMessageStatus =
  | "RECEIVED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED";

export interface IWhatsAppMessage extends Document {
  workspaceId: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  whatsappAccountId: mongoose.Types.ObjectId;

  waMessageId?: string;
  direction: WhatsAppMessageDirection;
  type: WhatsAppMessageType;
  status: WhatsAppMessageStatus;

  text?: string;
  mediaId?: string;
  mediaMimeType?: string;

  senderId?: mongoose.Types.ObjectId;
  timestamp: Date;

  errorMessage?: string;

  createdAt: Date;
  updatedAt: Date;
}

const whatsappMessageSchema = new Schema<IWhatsAppMessage>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppConversation",
      required: true,
    },

    contactId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppContact",
      required: true,
    },

    whatsappAccountId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppAccount",
      required: true,
    },

    waMessageId: {
      type: String,
      trim: true,
    },

    direction: {
      type: String,
      enum: ["INBOUND", "OUTBOUND"],
      required: true,
    },

    type: {
      type: String,
      enum: [
        "TEXT",
        "IMAGE",
        "VIDEO",
        "AUDIO",
        "DOCUMENT",
        "LOCATION",
        "TEMPLATE",
        "INTERACTIVE",
        "UNKNOWN",
      ],
      required: true,
    },

    status: {
      type: String,
      enum: ["RECEIVED", "SENT", "DELIVERED", "READ", "FAILED"],
      required: true,
    },

    text: {
      type: String,
    },

    mediaId: {
      type: String,
    },

    mediaMimeType: {
      type: String,
    },

    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    timestamp: {
      type: Date,
      required: true,
    },

    errorMessage: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

// Prevent duplicate inbound/outbound messages from Meta retries.
whatsappMessageSchema.index(
  { whatsappAccountId: 1, waMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      waMessageId: { $type: "string" },
    },
  },
);

whatsappMessageSchema.index({
  workspaceId: 1,
  conversationId: 1,
  timestamp: -1,
});

const WhatsAppMessage: Model<IWhatsAppMessage> =
  mongoose.models.WhatsAppMessage ||
  mongoose.model<IWhatsAppMessage>("WhatsAppMessage", whatsappMessageSchema);

export default WhatsAppMessage;
