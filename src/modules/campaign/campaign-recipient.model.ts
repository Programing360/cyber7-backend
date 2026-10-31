import mongoose, { Schema, Document, Model } from "mongoose";

export const CAMPAIGN_RECIPIENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
] as const;

export type CampaignRecipientStatus =
  (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export interface ICampaignRecipient extends Document {
  workspaceId: mongoose.Types.ObjectId;
  campaignId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  phoneNumber: string;
  status: CampaignRecipientStatus;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const campaignRecipientSchema = new Schema<ICampaignRecipient>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },

    contactId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppContact",
      required: true,
      index: true,
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: CAMPAIGN_RECIPIENT_STATUSES,
      default: "PENDING",
      required: true,
      index: true,
    },

    providerMessageId: {
      type: String,
      trim: true,
    },

    errorCode: {
      type: String,
      trim: true,
    },

    errorMessage: {
      type: String,
      trim: true,
      maxlength: [500, "Error message cannot exceed 500 characters"],
    },

    sentAt: {
      type: Date,
    },

    deliveredAt: {
      type: Date,
    },

    readAt: {
      type: Date,
    },

    failedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

campaignRecipientSchema.index(
  { campaignId: 1, contactId: 1 },
  { unique: true },
);
campaignRecipientSchema.index({ workspaceId: 1, campaignId: 1, status: 1 });
campaignRecipientSchema.index({ campaignId: 1, status: 1 });
campaignRecipientSchema.index({ providerMessageId: 1 });

const CampaignRecipient: Model<ICampaignRecipient> =
  mongoose.models.CampaignRecipient ||
  mongoose.model<ICampaignRecipient>(
    "CampaignRecipient",
    campaignRecipientSchema,
  );

export default CampaignRecipient;
