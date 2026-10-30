import mongoose, { Schema, Document, Model } from "mongoose";

export interface IWhatsAppContact extends Document {
  workspaceId: mongoose.Types.ObjectId;
  waId: string;
  phoneNumber: string;
  profileName?: string;
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
    },
  },
  {
    timestamps: true,
  },
);

// A contact must be unique within a workspace.
whatsappContactSchema.index({ workspaceId: 1, waId: 1 }, { unique: true });

const WhatsAppContact: Model<IWhatsAppContact> =
  mongoose.models.WhatsAppContact ||
  mongoose.model<IWhatsAppContact>("WhatsAppContact", whatsappContactSchema);

export default WhatsAppContact;
