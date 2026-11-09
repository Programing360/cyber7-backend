import mongoose, { Schema, type Document } from "mongoose";

export interface ICustomPlan extends Document {
  code: string;
  name: string;
  priceBdt: number;
  description: string;
  limits: {
    maxWhatsAppNumbers: number;
    maxTeamMembers: number;
  };
  features: string[];
  createdAt: Date;
  updatedAt: Date;
}

const customPlanSchema = new Schema<ICustomPlan>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    priceBdt: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: "",
    },
    limits: {
      maxWhatsAppNumbers: {
        type: Number,
        required: true,
      },
      maxTeamMembers: {
        type: Number,
        required: true,
      },
    },
    features: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

const CustomPlan = mongoose.model<ICustomPlan>("CustomPlan", customPlanSchema);

export default CustomPlan;
