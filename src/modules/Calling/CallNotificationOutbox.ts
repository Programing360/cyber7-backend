import mongoose, {
  Schema,
  Types,
  type HydratedDocument,
  type Model,
} from "mongoose";

export type CallNotificationEvent = "INCOMING_CALL" | "CALL_ENDED";

export type CallNotificationStatus =
  | "PENDING"
  | "PROCESSING"
  | "DELIVERED"
  | "FAILED";

export interface ICallNotificationOutbox {
  workspaceId: Types.ObjectId;
  callLogId: Types.ObjectId;

  providerCallId: string;
  recipientUserId: Types.ObjectId;

  eventType: CallNotificationEvent;
  status: CallNotificationStatus;

  payload: {
    workspaceId: string;
    callId: string;
    name?: string;
    phone?: string;
    sdpOffer?: string;
    phoneNumberId?: string;
    endStatus?: "MISSED" | "REJECTED" | "ENDED";
  };

  attempts: number;
  nextAttemptAt: Date;
  lastAttemptAt?: Date;
  deliveredAt?: Date;
  lastError?: string;

  // Worker lease tracking for atomic claim and crash recovery.
  processingAt?: Date;
  leaseExpiresAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type CallNotificationOutboxDocument =
  HydratedDocument<ICallNotificationOutbox>;

const callNotificationOutboxSchema = new Schema<ICallNotificationOutbox>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },

    callLogId: {
      type: Schema.Types.ObjectId,
      ref: "CallLog",
      required: true,
    },

    providerCallId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
    },

    recipientUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    eventType: {
      type: String,
      enum: ["INCOMING_CALL", "CALL_ENDED"],
      required: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "DELIVERED", "FAILED"],
      default: "PENDING",
      required: true,
    },

    payload: {
      workspaceId: {
        type: String,
        required: true,
      },
      callId: {
        type: String,
        required: true,
      },
      name: {
        type: String,
      },
      phone: {
        type: String,
      },

      sdpOffer: {
        type: String,
      },
      phoneNumberId: {
        type: String,
        trim: true,
      },
      endStatus: {
        type: String,
        enum: ["MISSED", "REJECTED", "ENDED"],
      },
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    nextAttemptAt: {
      type: Date,
      default: Date.now,
      required: true,
    },

    lastAttemptAt: {
      type: Date,
    },

    deliveredAt: {
      type: Date,
    },

    lastError: {
      type: String,
      maxlength: 1000,
    },

    // Worker lease fields for atomic claim and crash recovery.
    processingAt: {
      type: Date,
    },

    leaseExpiresAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: "__v",
  },
);

// One notification per call, recipient and event.
callNotificationOutboxSchema.index(
  {
    workspaceId: 1,
    providerCallId: 1,
    recipientUserId: 1,
    eventType: 1,
  },
  {
    unique: true,
    name: "unique_call_recipient_event",
  },
);

// Find pending notifications that are ready for delivery.
callNotificationOutboxSchema.index(
  {
    status: 1,
    nextAttemptAt: 1,
  },
  {
    name: "pending_call_notification_delivery",
  },
);

// Workspace notification history.
callNotificationOutboxSchema.index(
  {
    workspaceId: 1,
    recipientUserId: 1,
    createdAt: -1,
  },
  {
    name: "workspace_user_notification_history",
  },
);

// Stale PROCESSING lease recovery: find crashed worker jobs.
callNotificationOutboxSchema.index(
  {
    status: 1,
    leaseExpiresAt: 1,
  },
  {
    name: "stale_processing_lease_recovery",
  },
);

export const CallNotificationOutbox: Model<ICallNotificationOutbox> =
  (mongoose.models.CallNotificationOutbox as
    | Model<ICallNotificationOutbox>
    | undefined) ??
  mongoose.model<ICallNotificationOutbox>(
    "CallNotificationOutbox",
    callNotificationOutboxSchema,
  );

export default CallNotificationOutbox;
