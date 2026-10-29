import { Schema, model, Types } from "mongoose";

export type InvitationRole = "ADMIN" | "AGENT";

export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

const invitationSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    role: {
      type: String,
      enum: ["ADMIN", "AGENT"],
      required: true,
    },

    tokenHash: {
      type: String,
      required: true,
      select: false,
    },

    status: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"],
      default: "PENDING",
      required: true,
    },

    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    acceptedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

invitationSchema.index({
  workspaceId: 1,
  email: 1,
  status: 1,
});

export type InvitationDocument = {
  workspaceId: Types.ObjectId;
  email: string;
  role: InvitationRole;
  tokenHash: string;
  status: InvitationStatus;
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  acceptedAt: Date | null;
};

export const Invitation = model("Invitation", invitationSchema);
