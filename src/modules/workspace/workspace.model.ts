import mongoose, { Schema, type InferSchemaType } from "mongoose";

const workspaceSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Workspace name is required"],
      trim: true,
      minlength: [2, "Workspace name must be at least 2 characters"],
      maxlength: [100, "Workspace name cannot exceed 100 characters"],
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must contain only lowercase letters, numbers, and hyphens",
      ],
    },
    // Normalized name for global uniqueness
    nameNormalized: {
      type: String,
      required: true,
      select: false,
    },

    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED"],
      default: "ACTIVE",
    },

    suspensionReason: {
      type: String,
      default: null,
    },

    suspendedAt: {
      type: Date,
      default: null,
    },

    customLimits: {
      type: new Schema(
        {
          maxWhatsAppNumbers: { type: Number, default: null },
          maxTeamMembers: { type: Number, default: null },
        },
        { _id: false },
      ),
      default: () => ({
        maxWhatsAppNumbers: null,
        maxTeamMembers: null,
      }),
    },

    timezone: {
      type: String,
      default: "Asia/Dhaka",
    },

    currency: {
      type: String,
      default: "BDT",
      uppercase: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Globally unique workspace names
workspaceSchema.index(
  { nameNormalized: 1 },
  { unique: true, name: "unique_workspace_name" },
);


export type WorkspaceDocument = InferSchemaType<typeof workspaceSchema>;

const Workspace = mongoose.model("Workspace", workspaceSchema);

export default Workspace;
