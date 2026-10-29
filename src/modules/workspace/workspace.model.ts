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

export type WorkspaceDocument = InferSchemaType<typeof workspaceSchema>;

const Workspace = mongoose.model("Workspace", workspaceSchema);

export default Workspace;
