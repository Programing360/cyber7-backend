import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const membershipSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["OWNER", "ADMIN", "AGENT"],
      required: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "INVITED", "SUSPENDED"],
      default: "ACTIVE",
      required: true,
    },

    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// One membership per user in a workspace.
membershipSchema.index(
  {
    workspaceId: 1,
    userId: 1,
  },
  {
    unique: true,
    name: "unique_workspace_membership",
  },
);

// Find active OWNER/ADMIN fallback recipients.
membershipSchema.index(
  {
    workspaceId: 1,
    role: 1,
    status: 1,
  },
  {
    name: "workspace_active_role_lookup",
  },
);

export type MembershipDocument = InferSchemaType<typeof membershipSchema>;

const Membership: Model<MembershipDocument> =
  (mongoose.models.Membership as Model<MembershipDocument>) ||
  mongoose.model<MembershipDocument>("Membership", membershipSchema);

export default Membership;
