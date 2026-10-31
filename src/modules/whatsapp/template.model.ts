import mongoose, { Schema, Document, Model } from "mongoose";

export type MetaTemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export type MetaTemplateStatus =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "IN_APPEAL"
  | "DELETED"
  | "DRAFT";

export interface IWhatsAppTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{
    type: string;
    text?: string;
    url?: string;
    phoneNumber?: string;
  }>;
  example?: Record<string, unknown>;
}

export interface IWhatsAppTemplate extends Document {
  workspaceId: mongoose.Types.ObjectId;
  whatsappAccountId: mongoose.Types.ObjectId;
  metaTemplateId: string;
  name: string;
  category: MetaTemplateCategory;
  language: string;
  status: MetaTemplateStatus;
  header?: {
    format?: string;
    text?: string;
  };
  body: string;
  footer?: string;
  buttons: Array<{
    type: string;
    text?: string;
    url?: string;
    phoneNumber?: string;
  }>;
  variables: string[];
  components: IWhatsAppTemplateComponent[];
  qualityScore?: string;
  rejectedReason?: string;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappTemplateSchema = new Schema<IWhatsAppTemplate>(
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
      index: true,
    },
    metaTemplateId: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
      required: true,
    },
    language: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: [
        "APPROVED",
        "PENDING",
        "REJECTED",
        "PAUSED",
        "DISABLED",
        "IN_APPEAL",
        "DELETED",
        "DRAFT",
      ],
      default: "PENDING",
    },
    header: {
      format: { type: String },
      text: { type: String },
    },
    body: {
      type: String,
      required: true,
    },
    footer: {
      type: String,
      default: "",
    },
    buttons: [
      {
        type: { type: String },
        text: { type: String },
        url: { type: String },
        phoneNumber: { type: String },
      },
    ],
    variables: {
      type: [String],
      default: [],
    },
    components: {
      type: Schema.Types.Mixed,
      default: [],
    },
    qualityScore: {
      type: String,
    },
    rejectedReason: {
      type: String,
    },
    syncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// A Meta template ID must be unique per workspace
whatsappTemplateSchema.index(
  { workspaceId: 1, metaTemplateId: 1 },
  { unique: true },
);

whatsappTemplateSchema.index({ workspaceId: 1, status: 1 });
whatsappTemplateSchema.index({ workspaceId: 1, category: 1 });
whatsappTemplateSchema.index({ workspaceId: 1, name: 1 });

const WhatsAppTemplate: Model<IWhatsAppTemplate> =
  mongoose.models.WhatsAppTemplate ||
  mongoose.model<IWhatsAppTemplate>("WhatsAppTemplate", whatsappTemplateSchema);

export default WhatsAppTemplate;