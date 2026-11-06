import type { Server, Socket } from "socket.io";

import User from "../modules/auth/user.model.js";
import Workspace from "../modules/workspace/workspace.model.js";
import Membership from "../modules/workspace/membership.model.js";
import CallLog from "../modules/Calling/CallLog.js";

import { verifyAccessToken } from "../utils/jwt.js";

export interface ServerToClientEvents {
  "call-dialing": (data: { targetPhone: string; callerName: string }) => void;

  "incoming-call": (
    data: {
      notificationId: string;
      callId: string;
      name: string;
      phone: string;
      callSid: string;
      workspaceId: string;
    },
    ack: (response: { received: boolean }) => void,
  ) => void;

  "call-accepted": (data: {
    workspaceId: string;
    callId: string;
    assignedTo: string;
  }) => void;

  "call-taken": (data: {
    workspaceId: string;
    callId: string;
    assignedTo: string;
  }) => void;

  "incoming-call-ended": (
    data: {
      notificationId: string;
      workspaceId: string;
      callId: string;
      status: "MISSED" | "REJECTED" | "ENDED";
    },
    ack: (response: { received: boolean }) => void,
  ) => void;

  "webrtc-offer": (data: {
    workspaceId: string;
    callId: string;
    sdp: RTCSessionDescriptionInit;
  }) => void;

  "webrtc-answer": (data: {
    workspaceId: string;
    callId: string;
    sdp: RTCSessionDescriptionInit;
  }) => void;

  "webrtc-ice-candidate": (data: {
    workspaceId: string;
    callId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  "call-terminated": (data: { workspaceId: string; callId?: string }) => void;

  "call-ended": (data: { callSid: string }) => void;

  "socket-error": (data: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  "join-workspace": (workspaceId: string) => void;

  "answer-incoming-call": (data: {
    workspaceId: string;
    callId: string;
  }) => void;

  "initiate-call": (data: {
    workspaceId: string;
    targetPhone: string;
    callerName: string;
  }) => void;

  "webrtc-offer": (data: {
    workspaceId: string;
    callId: string;
    sdp: RTCSessionDescriptionInit;
  }) => void;

  "webrtc-answer": (data: {
    workspaceId: string;
    callId: string;
    sdp: RTCSessionDescriptionInit;
  }) => void;

  "webrtc-ice-candidate": (data: {
    workspaceId: string;
    callId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  "hangup-call": (data: { workspaceId: string; callId: string }) => void;
}

export interface CallSocketData {
  userId: string;
}

type CallSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  CallSocketData
>;

type CallSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  CallSocketData
>;

const USER_ROOM_PREFIX = "user_";

let callSocketIO: CallSocketServer | null = null;

const getUserRoom = (userId: string): string => `${USER_ROOM_PREFIX}${userId}`;

const getAccessToken = (socket: CallSocket): string | null => {
  const authToken = socket.handshake.auth?.accessToken;

  if (typeof authToken === "string" && authToken.trim()) {
    return authToken.trim();
  }

  const authorization = socket.handshake.headers.authorization;

  if (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ")
  ) {
    const token = authorization.slice(7).trim();
    return token || null;
  }

  return null;
};

const emitSocketError = (
  socket: CallSocket,
  code: string,
  message: string,
): void => {
  socket.emit("socket-error", {
    code,
    message,
  });
};

const isValidObjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

/**
 * Verifies:
 * 1. Valid workspace ID.
 * 2. User still exists and is active.
 * 3. Workspace exists and is active.
 * 4. User has active membership in that workspace.
 */
const authorizeWorkspace = async (
  socket: CallSocket,
  workspaceId: unknown,
): Promise<boolean> => {
  if (!isValidObjectId(workspaceId)) {
    emitSocketError(
      socket,
      "INVALID_WORKSPACE_ID",
      "A valid workspace ID is required.",
    );

    return false;
  }

  const [activeUser, activeWorkspace, membership] = await Promise.all([
    User.exists({
      _id: socket.data.userId,
      isActive: true,
    }),

    Workspace.exists({
      _id: workspaceId,
      status: "ACTIVE",
    }),

    Membership.exists({
      workspaceId,
      userId: socket.data.userId,
      status: "ACTIVE",
    }),
  ]);

  if (!activeUser) {
    emitSocketError(socket, "USER_INACTIVE", "Your account is inactive.");

    return false;
  }

  if (!activeWorkspace || !membership) {
    emitSocketError(
      socket,
      "WORKSPACE_ACCESS_DENIED",
      "You do not have access to this active workspace.",
    );

    return false;
  }

  return true;
};

/**
 * Sends incoming call notifications only to selected private user rooms.
 */

/**
 * Legacy incoming-call emitter.
 * New Outbox delivery should use deliverIncomingCallNotification().
 */
export function emitIncomingCallToUsers(
  userIds: string[],
  data: {
    workspaceId: string;
    callId: string;
    name: string;
    phone: string;
  },
): void {
  if (!callSocketIO) {
    console.error("[Call Socket] Socket.IO is not initialized.");
    return;
  }

  const payload = {
    notificationId: data.callId,
    callId: data.callId,
    callSid: data.callId,
    workspaceId: data.workspaceId,
    name: data.name,
    phone: data.phone,
  };

  for (const userId of new Set(userIds)) {
    if (!isValidObjectId(userId)) continue;

    callSocketIO.to(getUserRoom(userId)).emit("incoming-call", payload, () => {
      // Legacy acknowledgement callback.
    });
  }
}

/**
 * Notifies eligible users when an incoming call ends.
 */

/**
 * Legacy call-ended emitter.
 * New Outbox delivery should use deliverCallEndedNotification().
 */
export function emitIncomingCallEndedToUsers(
  userIds: string[],
  data: {
    workspaceId: string;
    callId: string;
    status: "MISSED" | "REJECTED" | "ENDED";
  },
): void {
  if (!callSocketIO) return;

  const payload = {
    notificationId: data.callId,
    ...data,
  };

  for (const userId of new Set(userIds)) {
    if (!isValidObjectId(userId)) continue;

    callSocketIO
      .to(getUserRoom(userId))
      .emit("incoming-call-ended", payload, () => {
        // Legacy acknowledgement callback.
      });
  }
}

type IncomingCallNotificationData = {
  notificationId: string;
  workspaceId: string;
  callId: string;
  name: string;
  phone: string;
};

type CallEndedNotificationData = {
  notificationId: string;
  workspaceId: string;
  callId: string;
  status: "MISSED" | "REJECTED" | "ENDED";
};

const SOCKET_NOTIFICATION_ACK_TIMEOUT = 5000;

/**
 * Deliver an incoming-call notification to one private user room.
 * Returns true when at least one connected client acknowledges it.
 */
export function deliverIncomingCallNotification(
  userId: string,
  data: IncomingCallNotificationData,
): Promise<boolean> {
  if (!callSocketIO || !isValidObjectId(userId)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    callSocketIO!
      .to(getUserRoom(userId))
      .timeout(SOCKET_NOTIFICATION_ACK_TIMEOUT)
      .emit(
        "incoming-call",
        {
          ...data,
          callSid: data.callId,
        },
        (error, responses) => {
          const acknowledged = (responses ?? []).some(
            (response) => response?.received === true,
          );

          if (error && !acknowledged) {
            resolve(false);
            return;
          }

          resolve(acknowledged);
        },
      );
  });
}

/**
 * Deliver a call-ended notification to one private user room.
 */
export function deliverCallEndedNotification(
  userId: string,
  data: CallEndedNotificationData,
): Promise<boolean> {
  if (!callSocketIO || !isValidObjectId(userId)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    callSocketIO!
      .to(getUserRoom(userId))
      .timeout(SOCKET_NOTIFICATION_ACK_TIMEOUT)
      .emit("incoming-call-ended", data, (error, responses) => {
        const acknowledged = (responses ?? []).some(
          (response) => response?.received === true,
        );

        if (error && !acknowledged) {
          resolve(false);
          return;
        }

        resolve(acknowledged);
      });
  });
}

/**
 * Initialize authenticated Call Socket.IO.
 */
export const initCallSocket = (io: CallSocketServer): void => {
  callSocketIO = io;

  /**
   * Socket authentication middleware.
   */
  // callSocket.ts - io.use মিডলওয়্যারে এই অংশটি আপডেট করুন:

  io.use(async (socket, next) => {
    try {
      const authenticatedSocket = socket as CallSocket;
      const token = getAccessToken(authenticatedSocket);

      if (!token) {
        return next(new Error("Authentication token is required."));
      }

      const payload = verifyAccessToken(token) as any;

      // sub, userId অথবা id — যে কোনো একটি থাকলে গ্রহণ করবে
      const userId = payload?.sub || payload?.userId || payload?.id;

      if (!userId || !isValidObjectId(userId)) {
        return next(
          new Error("Invalid authentication token payload (User ID missing)."),
        );
      }

      const user = await User.findById(userId).select("_id isActive").lean();

      if (!user || !user.isActive) {
        return next(
          new Error("User authentication failed or account inactive."),
        );
      }

      authenticatedSocket.data.userId = user._id.toString();
      return next();
    } catch (error: any) {
      console.error("[Call Socket Auth Error]:", error?.message);
      return next(new Error("Invalid or expired authentication token."));
    }
  });

  io.on("connection", (socket) => {
    const authenticatedSocket = socket as CallSocket;

    const userId = authenticatedSocket.data.userId;

    // Private room for every authenticated user.
    void authenticatedSocket.join(getUserRoom(userId));

    /**
     * Join workspace.
     * Workspace rooms are not used for incoming call notifications.
     */
    authenticatedSocket.on("join-workspace", async (workspaceId) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          workspaceId,
        );

        if (!allowed) return;

        await authenticatedSocket.join(`workspace_${workspaceId}`);
      } catch (error) {
        console.error("[Call Socket] Workspace join failed:", error);

        emitSocketError(
          authenticatedSocket,
          "WORKSPACE_JOIN_FAILED",
          "Unable to join workspace.",
        );
      }
    });

    /**
     * First eligible user to answer wins.
     *
     * This does NOT accept the call at Meta/provider level.
     * It only assigns the call to one eligible workspace user.
     */
    authenticatedSocket.on("answer-incoming-call", async (data) => {
      try {
        if (
          !data ||
          !isValidObjectId(data.workspaceId) ||
          !isValidObjectId(data.callId)
        ) {
          emitSocketError(
            authenticatedSocket,
            "INVALID_CALL_DATA",
            "A valid workspace ID and call ID are required.",
          );

          return;
        }

        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data.workspaceId,
        );

        if (!allowed) return;

        const now = new Date();

        /**
         * Atomic first-answer-wins assignment.
         *
         * Transitions the call from RINGING → ASSIGNING.
         * This records that a Cyber7 agent has claimed the call in the DB.
         *
         * NOTE: This does NOT accept the call at the Meta/provider level.
         * "ASSIGNING" = Cyber7-side claim only.
         * "CONNECTED" = real provider media confirmed (requires Meta API — NOT IMPLEMENTED).
         */
        const call = await CallLog.findOneAndUpdate(
          {
            _id: data.callId,
            workspaceId: data.workspaceId,
            status: "RINGING",

            // Only originally selected recipients may answer.
            ringingUserIds: userId,

            // No previous user may have won.
            $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }],
          },
          {
            $set: {
              status: "ASSIGNING",
              assignedTo: userId,
              assignedAt: now,
              answeredAt: now,
            },
          },
          {
            new: true,
            runValidators: true,
          },
        )
          .select("_id workspaceId ringingUserIds assignedTo")
          .lean();

        if (!call) {
          emitSocketError(
            authenticatedSocket,
            "CALL_NOT_AVAILABLE",
            "This call is no longer available or you are not an eligible recipient.",
          );

          return;
        }

        const assignedTo = call.assignedTo?.toString() ?? userId;

        // Notify winning user.
        authenticatedSocket.emit("call-accepted", {
          workspaceId: data.workspaceId,
          callId: data.callId,
          assignedTo,
        });

        // Notify all other originally eligible recipients.
        for (const recipientId of call.ringingUserIds ?? []) {
          const recipient = recipientId.toString();

          if (recipient === assignedTo) continue;

          io.to(getUserRoom(recipient)).emit("call-taken", {
            workspaceId: data.workspaceId,
            callId: data.callId,
            assignedTo,
          });
        }

        console.info("[Call Socket] Incoming call assigned:", {
          callId: data.callId,
          workspaceId: data.workspaceId,
          assignedTo,
        });
      } catch (error) {
        console.error("[Call Socket] Answer event failed:", error);

        emitSocketError(
          authenticatedSocket,
          "CALL_ANSWER_FAILED",
          "Unable to answer this call.",
        );
      }
    });

    /**
     * Provider call initiation is not implemented.
     * Browser cannot create fake provider calls.
     */
    authenticatedSocket.on("initiate-call", async (data) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data?.workspaceId,
        );

        if (!allowed) return;

        emitSocketError(
          authenticatedSocket,
          "META_CALLING_NOT_IMPLEMENTED",
          "Call initiation is not implemented yet.",
        );
      } catch (error) {
        console.error("[Call Socket] Initiate event failed:", error);

        emitSocketError(
          authenticatedSocket,
          "CALL_EVENT_FAILED",
          "Unable to process call event.",
        );
      }
    });

    /**
     * WebRTC signaling is intentionally disabled until
     * actual Meta Calling media integration is implemented.
     */
    authenticatedSocket.on("webrtc-offer", async (data) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data?.workspaceId,
        );

        if (!allowed) return;

        emitSocketError(
          authenticatedSocket,
          "WEBRTC_SIGNALING_NOT_AVAILABLE",
          "WebRTC signaling is not implemented yet.",
        );
      } catch (error) {
        console.error("[Call Socket] WebRTC offer failed:", error);

        emitSocketError(
          authenticatedSocket,
          "WEBRTC_EVENT_FAILED",
          "Unable to process WebRTC offer.",
        );
      }
    });

    authenticatedSocket.on("webrtc-answer", async (data) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data?.workspaceId,
        );

        if (!allowed) return;

        emitSocketError(
          authenticatedSocket,
          "WEBRTC_SIGNALING_NOT_AVAILABLE",
          "WebRTC signaling is not implemented yet.",
        );
      } catch (error) {
        console.error("[Call Socket] WebRTC answer failed:", error);

        emitSocketError(
          authenticatedSocket,
          "WEBRTC_EVENT_FAILED",
          "Unable to process WebRTC answer.",
        );
      }
    });

    authenticatedSocket.on("webrtc-ice-candidate", async (data) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data?.workspaceId,
        );

        if (!allowed) return;

        emitSocketError(
          authenticatedSocket,
          "WEBRTC_SIGNALING_NOT_AVAILABLE",
          "WebRTC signaling is not implemented yet.",
        );
      } catch (error) {
        console.error("[Call Socket] ICE candidate failed:", error);

        emitSocketError(
          authenticatedSocket,
          "WEBRTC_EVENT_FAILED",
          "Unable to process ICE candidate.",
        );
      }
    });

    /**
     * Provider call termination is not implemented.
     */
    authenticatedSocket.on("hangup-call", async (data) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data?.workspaceId,
        );

        if (!allowed) return;

        emitSocketError(
          authenticatedSocket,
          "META_CALL_TERMINATION_NOT_IMPLEMENTED",
          "Provider call termination is not implemented yet.",
        );
      } catch (error) {
        console.error("[Call Socket] Hangup event failed:", error);

        emitSocketError(
          authenticatedSocket,
          "CALL_EVENT_FAILED",
          "Unable to process hangup event.",
        );
      }
    });

    authenticatedSocket.on("disconnect", (reason) => {
      console.info("[Call Socket] Disconnected:", {
        userId,
        reason,
      });
    });
  });
};
