import mongoose, { Schema, Document, Model } from "mongoose";

export type ConversationStatus = "OPEN" | "CLOSED" | "PENDING";

export interface IWhatsAppConversation extends Document {
  workspaceId: mongoose.Types.ObjectId;
  whatsappAccountId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  status: ConversationStatus;
  assignedTo?: mongoose.Types.ObjectId;
  lastMessageAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IWhatsAppConversation>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    whatsappAccountId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppAccount",
      required: true,
    },

    contactId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppContact",
      required: true,
    },

    status: {
      type: String,
      enum: ["OPEN", "CLOSED", "PENDING"],
      default: "OPEN",
    },

    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    lastMessageAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

// One conversation per contact per WhatsApp account.
conversationSchema.index(
  {
    workspaceId: 1,
    whatsappAccountId: 1,
    contactId: 1,
  },
  {
    unique: true,
  },
);

conversationSchema.index({
  workspaceId: 1,
  status: 1,
  lastMessageAt: -1,
});

const WhatsAppConversation: Model<IWhatsAppConversation> =
  mongoose.models.WhatsAppConversation ||
  mongoose.model<IWhatsAppConversation>(
    "WhatsAppConversation",
    conversationSchema,
  );

export default WhatsAppConversation;
