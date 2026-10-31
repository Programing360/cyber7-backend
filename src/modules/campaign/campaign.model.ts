import mongoose, { Schema, Document, Model } from "mongoose";

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_AUDIENCE_MODES = [
  "ALL_CONTACTS",
  "SELECTED_CONTACTS",
] as const;

export type CampaignAudienceMode = (typeof CAMPAIGN_AUDIENCE_MODES)[number];

export interface ICampaignAudience {
  mode: CampaignAudienceMode;
  contactIds: mongoose.Types.ObjectId[];
}

export interface ICampaign extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  whatsappAccountId: mongoose.Types.ObjectId;
  templateId: mongoose.Types.ObjectId;
  audience: ICampaignAudience;
  status: CampaignStatus;
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const campaignAudienceSchema = new Schema<ICampaignAudience>(
  {
    mode: {
      type: String,
      enum: CAMPAIGN_AUDIENCE_MODES,
      default: "ALL_CONTACTS",
      required: true,
    },
    contactIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "WhatsAppContact",
        },
      ],
      default: [],
    },
  },
  {
    _id: false,
  },
);

const campaignSchema = new Schema<ICampaign>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Campaign name is required"],
      trim: true,
      minlength: [2, "Campaign name must be at least 2 characters"],
      maxlength: [100, "Campaign name cannot exceed 100 characters"],
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Campaign description cannot exceed 500 characters"],
    },

    whatsappAccountId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppAccount",
      required: [true, "WhatsApp account is required"],
      index: true,
    },

    templateId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppTemplate",
      required: [true, "WhatsApp template is required"],
      index: true,
    },

    audience: {
      type: campaignAudienceSchema,
      required: true,
      default: () => ({ mode: "ALL_CONTACTS", contactIds: [] }),
    },

    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: "DRAFT",
      required: true,
      index: true,
    },

    scheduledAt: {
      type: Date,
    },

    startedAt: {
      type: Date,
    },

    completedAt: {
      type: Date,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    totalRecipients: {
      type: Number,
      default: 0,
      min: 0,
    },

    sentCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    deliveredCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    readCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    failedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

campaignSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
campaignSchema.index({ workspaceId: 1, createdAt: -1 });
campaignSchema.index({ workspaceId: 1, scheduledAt: 1 });

const Campaign: Model<ICampaign> =
  mongoose.models.Campaign ||
  mongoose.model<ICampaign>("Campaign", campaignSchema);

export default Campaign;
