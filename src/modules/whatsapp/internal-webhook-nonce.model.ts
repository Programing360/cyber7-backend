import mongoose, { Schema, Model } from "mongoose";

export interface IInternalWebhookNonce {
  _id: string; // Nonce (UUIDv4)
  timestamp: Date;
  createdAt: Date;
}

const internalWebhookNonceSchema = new Schema<IInternalWebhookNonce>(
  {
    _id: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    _id: false,
    versionKey: false,
  },
);

// TTL index: automatically delete after 600 seconds (10 minutes)
internalWebhookNonceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

const InternalWebhookNonce: Model<IInternalWebhookNonce> =
  mongoose.models.InternalWebhookNonce ||
  mongoose.model<IInternalWebhookNonce>(
    "InternalWebhookNonce",
    internalWebhookNonceSchema,
    "internal_webhook_nonces",
  );

export default InternalWebhookNonce;
