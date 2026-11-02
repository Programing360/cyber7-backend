import mongoose, { Schema, Document, Model } from "mongoose";

export type ConversationStatus = "OPEN" | "CLOSED" | "PENDING";

export interface IWhatsAppConversation extends Document {
  workspaceId: mongoose.Types.ObjectId;
  whatsappAccountId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  status: ConversationStatus;
  assignedTo?: mongoose.Types.ObjectId;
  lastMessageAt?: Date;
  lastCustomerMessageAt?: Date;
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

    lastCustomerMessageAt: {
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

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isCustomerServiceWindowOpen(
  lastCustomerMessageAt?: Date | string | null,
  nowMs: number = Date.now(),
): boolean {
  if (!lastCustomerMessageAt) return false;
  const time = new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(time)) return false;

  // Reject future timestamps that exceed acceptable clock skew (60s)
  if (time > nowMs + 60 * 1000) {
    return false;
  }

  // Clamp minor future drift to nowMs, then calculate elapsed time
  const effectiveTime = Math.min(time, nowMs);
  const elapsed = nowMs - effectiveTime;
  return elapsed >= 0 && elapsed <= CUSTOMER_SERVICE_WINDOW_MS;
}

export function getCustomerServiceWindowExpiry(
  lastCustomerMessageAt?: Date | string | null,
  nowMs: number = Date.now(),
): Date | null {
  if (!lastCustomerMessageAt) return null;
  const time = new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(time)) return null;
  if (time > nowMs + 60 * 1000) return null;
  const effectiveTime = Math.min(time, nowMs);
  return new Date(effectiveTime + CUSTOMER_SERVICE_WINDOW_MS);
}

const WhatsAppConversation: Model<IWhatsAppConversation> =
  mongoose.models.WhatsAppConversation ||
  mongoose.model<IWhatsAppConversation>(
    "WhatsAppConversation",
    conversationSchema,
  );

export default WhatsAppConversation;
