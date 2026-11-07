import type { Server, Socket } from "socket.io";
import mongoose from "mongoose";

import User from "../modules/auth/user.model.js";
import Workspace from "../modules/workspace/workspace.model.js";
import Membership from "../modules/workspace/membership.model.js";
import CallLog from "../modules/Calling/CallLog.js";
import { acceptMetaCallWithSdp } from "../services/whatsapp-calling-webhook.service.js";
import WhatsAppAccount from "../modules/whatsapp/whatsapp.model.js";

import { verifyAccessToken } from "../utils/jwt.js";
 import { terminateMetaCall } from "../services/whatsapp-calling-webhook.service.js";
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
      sdpOffer?: string;
    },
    ack?: (
      error: Error | null,
      response?: { received: boolean } | Array<{ received: boolean }>,
    ) => void,
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
    ack?: (
      error: Error | null,
      response?: { received: boolean } | Array<{ received: boolean }>,
    ) => void,
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
    sdpAnswer?: string;
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

export const getCallSocketIO = (): CallSocketServer | null => callSocketIO;

const getUserRoom = (userId: string): string => `${USER_ROOM_PREFIX}${userId}`;

const getAccessToken = (socket: CallSocket): string | null => {
  const authToken =
    socket.handshake.auth?.accessToken || socket.handshake.auth?.token;

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
 * Authorize workspace membership.
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

type IncomingCallNotificationData = {
  notificationId: string;
  workspaceId: string;
  callId: string;
  callSid: string;
  name: string;
  phone: string;
  sdpOffer?: string;
};

type CallEndedNotificationData = {
  notificationId: string;
  workspaceId: string;
  callId: string;
  status: "MISSED" | "REJECTED" | "ENDED";
};

const SOCKET_NOTIFICATION_ACK_TIMEOUT = 5000;

/**
 * Deliver an incoming-call notification directly to a user's private room.
 */
export function deliverIncomingCallNotification(
  userId: string,
  data: IncomingCallNotificationData,
): Promise<boolean> {
  if (!callSocketIO || !isValidObjectId(userId)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    (
      callSocketIO!
        .to(getUserRoom(userId))
        .timeout(SOCKET_NOTIFICATION_ACK_TIMEOUT) as any
    ).emit("incoming-call", data, (error: any, responses: any) => {
      const responseList = Array.isArray(responses) ? responses : [responses];
      const acknowledged = responseList.some(
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
 * Deliver a call-ended notification to a user's private room.
 */
export function deliverCallEndedNotification(
  userId: string,
  data: CallEndedNotificationData,
): Promise<boolean> {
  if (!callSocketIO || !isValidObjectId(userId)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    (
      callSocketIO!
        .to(getUserRoom(userId))
        .timeout(SOCKET_NOTIFICATION_ACK_TIMEOUT) as any
    ).emit("incoming-call-ended", data, (error: any, responses: any) => {
      const responseList = Array.isArray(responses) ? responses : [responses];
      const acknowledged = responseList.some(
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
 * Initialize authenticated Call Socket.IO server.
 */
export const initCallSocket = (io: CallSocketServer): void => {
  callSocketIO = io;

  io.use(async (socket, next) => {
    try {
      const authenticatedSocket = socket as CallSocket;
      const token = getAccessToken(authenticatedSocket);

      if (!token) {
        return next(new Error("Authentication token is required."));
      }

      const payload = verifyAccessToken(token) as any;
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

    // Join private user room
    void authenticatedSocket.join(getUserRoom(userId));

    authenticatedSocket.on("join-workspace", async (workspaceId) => {
      try {
        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          workspaceId,
        );

        if (!allowed) return;

        await authenticatedSocket.join(`workspace_${workspaceId}`);
        await authenticatedSocket.join(workspaceId);
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
     * Agent answers the call.
     * WebRTC SDP Answer is forwarded to Meta Graph API.
     */
    authenticatedSocket.on("answer-incoming-call", async (data) => {
      try {
        if (!data || !data.workspaceId || !data.callId) {
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

        // MongoDB _id অথবা providerCallId (wacid...) উভয় দিয়েই কল ম্যাচ করানো
        const callQuery: Record<string, unknown> = {
          workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
          status: "RINGING",
          ringingUserIds: new mongoose.Types.ObjectId(userId),
          $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }],
        };

        if (isValidObjectId(data.callId)) {
          callQuery._id = new mongoose.Types.ObjectId(data.callId);
        } else {
          callQuery.providerCallId = data.callId;
        }

        const call = await CallLog.findOneAndUpdate(
          callQuery,
          {
            $set: {
              status: "ASSIGNING",
              assignedTo: new mongoose.Types.ObjectId(userId),
              assignedAt: now,
              answeredAt: now,
            },
          },
          {
            new: true,
            runValidators: true,
          },
        )
          .select(
            "_id workspaceId ringingUserIds assignedTo providerCallId phoneNumberId",
          )
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
        const targetCallId = call.providerCallId || data.callId;

        // ব্রাউজার থেকে SDP Answer আসলে মেটাতে কল অ্যাক্সেপ্ট করা
        if (data.sdpAnswer) {
          const account = await WhatsAppAccount.findOne({
            workspaceId: call.workspaceId,
            status: "CONNECTED",
          })
            .select("phoneNumberId accessToken")
            .lean();

          const phoneId =
            (call as any).phoneNumberId ||
            account?.phoneNumberId ||
            process.env.TEST_PHONE_NUMBER_ID ||
            "1157794877408926";

          // FIXED: accessToken টাইপ সেফ রিডিং
          const token = (account as any)?.accessToken;

          const metaSuccess = await acceptMetaCallWithSdp(
            phoneId,
            targetCallId,
            data.sdpAnswer,
            token,
          );

          if (metaSuccess) {
            await CallLog.updateOne(
              { _id: call._id },
              { $set: { status: "CONNECTED" } },
            );
          }
        }

        // জয়ী এজেন্টকে কনফার্মেশন পাঠানো
        authenticatedSocket.emit("call-accepted", {
          workspaceId: data.workspaceId,
          callId: targetCallId,
          assignedTo,
        });

        // অন্য সব এজেন্টদের জানানো যে কলটি রিসিভ হয়ে গেছে
        for (const recipientId of call.ringingUserIds ?? []) {
          const recipient = recipientId.toString();
          if (recipient === assignedTo) continue;

          io.to(getUserRoom(recipient)).emit("call-taken", {
            workspaceId: data.workspaceId,
            callId: targetCallId,
            assignedTo,
          });
        }
      } catch (error) {
        console.error("[Call Socket] Answer event failed:", error);
        emitSocketError(
          authenticatedSocket,
          "CALL_ANSWER_FAILED",
          "Unable to answer this call.",
        );
      }
    });

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
          "Outgoing WhatsApp calling is not configured yet.",
        );
      } catch (error) {
        console.error("[Call Socket] Initiate event failed:", error);
      }
    });

   

    // callSocket.ts - io.on("connection") এর ভেতরে:
    authenticatedSocket.on("hangup-call", async (data) => {
      try {
        if (!data?.workspaceId || !data?.callId) return;

        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data.workspaceId,
        );
        if (!allowed) return;

        const query: Record<string, unknown> = {
          workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
        };

        if (isValidObjectId(data.callId)) {
          query._id = new mongoose.Types.ObjectId(data.callId);
        } else {
          query.providerCallId = data.callId;
        }

        const call = await CallLog.findOne(query);

        if (call && call.providerCallId) {
          const account = await WhatsAppAccount.findOne({
            workspaceId: call.workspaceId,
            status: "CONNECTED",
          })
            .select("phoneNumberId accessToken")
            .lean();

          const phoneId =
            call.phoneNumberId ||
            account?.phoneNumberId ||
            process.env.TEST_PHONE_NUMBER_ID ||
            "1157794877408926";

          const token = (account as any)?.accessToken;

          // ১. মেটা ক্লাউডে কল টার্মিনেট করা (এতে হোয়াটসঅ্যাপের কল সাথে সাথে কেটে যাবে)
          await terminateMetaCall(phoneId, call.providerCallId, token);

          // ২. ডাটাবেজ আপডেট
          call.status = "ENDED";
          call.endedAt = new Date();
          await call.save();

          // ৩. সব এজেন্টদের সকেটে জানানো যে কল শেষ
          const endData = {
            notificationId: call.providerCallId,
            workspaceId: data.workspaceId,
            callId: call.providerCallId,
            status: "ENDED" as const,
          };

          io.to(data.workspaceId).emit("incoming-call-ended", endData);
          io.to(`workspace_${data.workspaceId}`).emit(
            "incoming-call-ended",
            endData,
          );
        }
      } catch (error) {
        console.error("[Call Socket] Hangup event failed:", error);
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
