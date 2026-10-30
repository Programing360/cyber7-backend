import mongoose, { Schema, Document, Model } from "mongoose";

export type WhatsAppConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "PENDING"
  | "ERROR";

export interface IWhatsAppAccount extends Document {
  workspaceId: mongoose.Types.ObjectId;

  businessName: string;
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;

  accessTokenEncrypted: string;

  status: WhatsAppConnectionStatus;

  webhookVerified: boolean;

  connectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappAccountSchema = new Schema<IWhatsAppAccount>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessAccountId: {
      type: String,
      required: true,
      trim: true,
    },

    phoneNumberId: {
      type: String,
      required: true,
      trim: true,
    },

    displayPhoneNumber: {
      type: String,
      required: true,
      trim: true,
    },

    accessTokenEncrypted: {
      type: String,
      required: true,
      select: false,
    },

    status: {
      type: String,
      enum: ["CONNECTED", "DISCONNECTED", "PENDING", "ERROR"],
      default: "PENDING",
    },

    webhookVerified: {
      type: Boolean,
      default: false,
    },

    connectedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

// One phone number can belong to only one workspace connection.
whatsappAccountSchema.index({ phoneNumberId: 1 }, { unique: true });

// Prevent duplicate WABA registration inside a workspace.
whatsappAccountSchema.index(
  { workspaceId: 1, businessAccountId: 1 },
  { unique: true },
);

const WhatsAppAccount: Model<IWhatsAppAccount> =
  mongoose.models.WhatsAppAccount ||
  mongoose.model<IWhatsAppAccount>("WhatsAppAccount", whatsappAccountSchema);

export default WhatsAppAccount;
