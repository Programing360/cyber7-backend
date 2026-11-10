import mongoose, { Schema, Document, Model } from "mongoose";

export interface IWhatsAppContact extends Document {
  workspaceId: mongoose.Types.ObjectId;

  waId: string;
  phoneNumber: string;
  profileName?: string;

  // Contact assignment.
  assignedTo?: mongoose.Types.ObjectId;
  assignedAt?: Date;

  isOptedOut: boolean;
  optOutTimestamp?: Date;
  optOutSource?: "STOP_MESSAGE" | "USER_ACTION" | "API";

  optInTimestamp?: Date;
  optInSource?: "START_MESSAGE" | "USER_ACTION" | "API";

  tags: string[];
  leadStatus: "NEW" | "CONTACTED" | "QUALIFIED" | "UNQUALIFIED" | "CONVERTED";

  createdAt: Date;
  updatedAt: Date;
}

const whatsappContactSchema = new Schema<IWhatsAppContact>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    waId: {
      type: String,
      required: true,
      trim: true,
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },

    profileName: {
      type: String,
      trim: true,
      maxlength: 120,
    },

    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
    },

    assignedAt: {
      type: Date,
    },

    isOptedOut: {
      type: Boolean,
      default: false,
      index: true,
    },

    optOutTimestamp: {
      type: Date,
    },

    optOutSource: {
      type: String,
      enum: ["STOP_MESSAGE", "USER_ACTION", "API"],
    },

    optInTimestamp: {
      type: Date,
    },

    optInSource: {
      type: String,
      enum: ["START_MESSAGE", "USER_ACTION", "API"],
    },
    
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    leadStatus: {
      type: String,
      enum: ["NEW", "CONTACTED", "QUALIFIED", "UNQUALIFIED", "CONVERTED"],
      default: "NEW",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// A contact must be unique within a workspace.
whatsappContactSchema.index(
  {
    workspaceId: 1,
    waId: 1,
  },
  {
    unique: true,
    name: "unique_workspace_whatsapp_contact",
  },
);

// Workspace + assigned agent contact lookup.
whatsappContactSchema.index(
  {
    workspaceId: 1,
    assignedTo: 1,
  },
  {
    name: "workspace_assigned_contacts",
  },
);

const WhatsAppContact: Model<IWhatsAppContact> =
  (mongoose.models.WhatsAppContact as Model<IWhatsAppContact>) ||
  mongoose.model<IWhatsAppContact>("WhatsAppContact", whatsappContactSchema);

export default WhatsAppContact;
