import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface ISessionPolicies {
  idleTimeoutMinutes: number;
  absoluteLifetimeHours: number;
  highValueStepUpThresholdBdt: number;
}

export interface IGatewayToggles {
  bkashDirect: boolean;
  cityBankTransfer: boolean;
  portPosCards: boolean;
}

export interface IPlatformSettings extends Document {
  _id: Types.ObjectId;
  key: string;
  currency: string;
  sessionPolicies: ISessionPolicies;
  gatewayToggles: IGatewayToggles;
  updatedBy: Types.ObjectId | null;
  updatedAt: Date;
}

const sessionPoliciesSchema = new Schema<ISessionPolicies>(
  {
    idleTimeoutMinutes: { type: Number, default: 15, min: 1 },
    absoluteLifetimeHours: { type: Number, default: 8, min: 1 },
    highValueStepUpThresholdBdt: { type: Number, default: 50000, min: 0 },
  },
  { _id: false },
);

const gatewayTogglesSchema = new Schema<IGatewayToggles>(
  {
    bkashDirect: { type: Boolean, default: true },
    cityBankTransfer: { type: Boolean, default: true },
    portPosCards: { type: Boolean, default: true },
  },
  { _id: false },
);

const platformSettingsSchema = new Schema<IPlatformSettings>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "GLOBAL_CONFIG",
      index: true,
    },
    currency: {
      type: String,
      default: "BDT",
      trim: true,
      uppercase: true,
    },
    sessionPolicies: {
      type: sessionPoliciesSchema,
      default: () => ({
        idleTimeoutMinutes: 15,
        absoluteLifetimeHours: 8,
        highValueStepUpThresholdBdt: 50000,
      }),
    },
    gatewayToggles: {
      type: gatewayTogglesSchema,
      default: () => ({
        bkashDirect: true,
        cityBankTransfer: true,
        portPosCards: true,
      }),
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

const PlatformSettings = mongoose.model<IPlatformSettings>(
  "PlatformSettings",
  platformSettingsSchema,
);

export default PlatformSettings;

