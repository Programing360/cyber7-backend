import mongoose, {
  Schema,
  Types,
  type HydratedDocument,
  type Model,
} from "mongoose";

export type CallType = "INCOMING" | "OUTGOING" | "MISSED";

/**
 * Call lifecycle states.
 *
 * RINGING      – incoming call received from Meta; eligible agents are notified.
 * ASSIGNING    – an agent claimed the call in DB (answer-incoming-call received).
 *                The call is NOT yet accepted at the Meta/provider level.
 * CONNECTED    – real provider/media connection confirmed (requires Meta API —
 *                NOT YET IMPLEMENTED; placeholder for future integration).
 * ENDED        – call finished normally after a period of connection.
 * REJECTED     – call explicitly rejected before connection.
 * MISSED       – call ended without any agent answering.
 * FAILED       – call could not be established due to a provider or system error.
 */
export type CallStatus =
  | "RINGING"
  | "ASSIGNING"
  | "CONNECTED"
  | "ENDED"
  | "REJECTED"
  | "MISSED"
  | "CANCELLED"
  | "FAILED";

export type CallAssignmentSource = "ASSIGNED_AGENT" | "OWNER_ADMIN_FALLBACK";

export interface ICallLog {
  workspaceId: string | Types.ObjectId;
  contactId?: Types.ObjectId;

  callerName: string;
  phoneNumber: string;

  callType: CallType;
  status: CallStatus;

  // Agent who eventually answered/owns the call.
  assignedTo?: Types.ObjectId;
  assignedAt?: Date;

  // Users who were eligible to receive this incoming call.
  ringingUserIds: Types.ObjectId[];

  assignmentSource?: CallAssignmentSource;

  // Provider call identity.
  providerCallId?: string;

  // Meta WhatsApp Business Phone Number ID.
  phoneNumberId?: string;

  // Legacy compatibility only.
  callSid?: string;

  durationSeconds: number;

  startedAt: Date;
  answeredAt?: Date;
  endedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type CallLogDocument = HydratedDocument<ICallLog>;

const callLogSchema = new Schema<ICallLog>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },

    contactId: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppContact",
    },

    callerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      default: "Unknown",
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },

    callType: {
      type: String,
      enum: ["INCOMING", "OUTGOING", "MISSED"],
      required: true,
    },

    status: {
      type: String,
      enum: [
        "RINGING",
        "ASSIGNING",
        "CONNECTED",
        "ENDED",
        "REJECTED",
        "MISSED",
        "CANCELLED",
        "FAILED",
      ],
      default: "RINGING",
      required: true,
    },

    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    assignedAt: {
      type: Date,
    },

    ringingUserIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      default: [],
    },

    assignmentSource: {
      type: String,
      enum: ["ASSIGNED_AGENT", "OWNER_ADMIN_FALLBACK"],
    },

    providerCallId: {
      type: String,
      trim: true,
      maxlength: 256,
      set: (value: unknown) =>
        typeof value === "string" && value.trim() ? value.trim() : undefined,
    },

    phoneNumberId: {
      type: String,
      trim: true,
      maxlength: 120,
    },

    callSid: {
      type: String,
      trim: true,
      sparse: true,
    },

    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isFinite,
        message: "Duration must be a finite number.",
      },
    },

    startedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },

    answeredAt: {
      type: Date,
    },

    endedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: "__v",
  },
);

// Tenant-scoped provider call idempotency.
callLogSchema.index(
  {
    workspaceId: 1,
    providerCallId: 1,
  },
  {
    unique: true,
    name: "unique_workspace_provider_call",
    partialFilterExpression: {
      providerCallId: { $type: "string" },
    },
  },
);

// Workspace call history.
callLogSchema.index(
  {
    workspaceId: 1,
    startedAt: -1,
  },
  {
    name: "workspace_call_history",
  },
);

// Workspace + assigned agent call lookup.
callLogSchema.index(
  {
    workspaceId: 1,
    assignedTo: 1,
    startedAt: -1,
  },
  {
    name: "workspace_assigned_calls",
  },
);

// Workspace + contact call history.
callLogSchema.index(
  {
    workspaceId: 1,
    contactId: 1,
    startedAt: -1,
  },
  {
    name: "workspace_contact_calls",
  },
);

// Workspace + eligible ringing users.
callLogSchema.index(
  {
    workspaceId: 1,
    ringingUserIds: 1,
    status: 1,
  },
  {
    name: "workspace_ringing_users",
  },
);

export const CallLog: Model<ICallLog> =
  (mongoose.models.CallLog as Model<ICallLog>) ||
  mongoose.model<ICallLog>("CallLog", callLogSchema);

export default CallLog;
