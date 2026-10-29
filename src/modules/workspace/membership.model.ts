import mongoose, { Schema, type InferSchemaType } from "mongoose";

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

membershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export type MembershipDocument = InferSchemaType<typeof membershipSchema>;

const Membership = mongoose.model("Membership", membershipSchema);

export default Membership;
