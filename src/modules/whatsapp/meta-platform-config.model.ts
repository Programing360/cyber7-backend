import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMetaPlatformConfig extends Document {
  key: string;
  webhookVerified: boolean;
  webhookVerifiedAt?: Date;
  lastVerifiedIp?: string;
  createdAt: Date;
  updatedAt: Date;
}

const metaPlatformConfigSchema = new Schema<IMetaPlatformConfig>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "webhook_verification",
      trim: true,
    },
    webhookVerified: {
      type: Boolean,
      default: false,
    },
    webhookVerifiedAt: {
      type: Date,
    },
    lastVerifiedIp: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

const MetaPlatformConfig: Model<IMetaPlatformConfig> =
  mongoose.models.MetaPlatformConfig ||
  mongoose.model<IMetaPlatformConfig>(
    "MetaPlatformConfig",
    metaPlatformConfigSchema,
  );

export default MetaPlatformConfig;

/**
 * Records successful GET webhook handshake from Meta.
 */
export async function recordWebhookVerificationSuccess(
  ip?: string,
): Promise<void> {
  await MetaPlatformConfig.findOneAndUpdate(
    { key: "webhook_verification" },
    {
      $set: {
        webhookVerified: true,
        webhookVerifiedAt: new Date(),
        ...(ip ? { lastVerifiedIp: ip } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * Retrieves whether Meta platform webhook has been verified via GET handshake.
 */
export async function getPlatformWebhookVerificationStatus(): Promise<boolean> {
  const config = await MetaPlatformConfig.findOne({
    key: "webhook_verification",
  });
  return config?.webhookVerified ?? false;
}

/**
 * Resets platform webhook verification status (used in testing or re-verification).
 */
export async function resetPlatformWebhookVerification(): Promise<void> {
  await MetaPlatformConfig.findOneAndUpdate(
    { key: "webhook_verification" },
    {
      $set: {
        webhookVerified: false,
        webhookVerifiedAt: undefined,
        lastVerifiedIp: undefined,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

