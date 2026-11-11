import type { Server, Socket } from "socket.io";
import mongoose from "mongoose";

import User from "../modules/auth/user.model.js";
import Workspace from "../modules/workspace/workspace.model.js";
import Membership from "../modules/workspace/membership.model.js";
import CallLog from "../modules/Calling/CallLog.js";
import WhatsAppAccount from "../modules/whatsapp/whatsapp.model.js";
import {
  acceptMetaCallWithSdp,
  terminateMetaCall,
  initiateMetaOutgoingCall,
} from "../services/whatsapp-calling-webhook.service.js";
import { createCallEndMessage } from "../modules/services/call-message.service.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { decrypt } from "../utils/encryption.js";

export interface ServerToClientEvents {
  "call-dialing": (data: {
    targetPhone: string;
    callerName: string;
    callId?: string;
  }) => void;

  "incoming-call": (
    data: {
      notificationId: string;
      callId: string;
      name: string;
      phone: string;
      callSid: string;
      workspaceId: string;
      sdpOffer?: string;
      phoneNumberId?: string;
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

  "call:accepted"?: (data: {
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
      status: "MISSED" | "REJECTED" | "ENDED" | "CANCELLED";
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

  "new-message": (data: {
    _id: string;
    workspaceId: string;
    conversationId: string;
    contactId: string;
    whatsappAccountId: string;
    direction: string;
    type: string;
    status: string;
    text?: string;
    mediaId?: string;
    mediaMimeType?: string;
    callLogId?: string;
    timestamp: string;
    createdAt: string;
  }) => void;

  "call-terminated": (data: { workspaceId: string; callId?: string }) => void;

  "call-ended": (data: { callSid: string }) => void;

  "socket-error": (data: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  "join-workspace": (workspaceId: string) => void;

  "answer-incoming-call": (
    data: { workspaceId: string; callId: string; sdpAnswer?: string },
    ack?: (error: Error | null, response?: { accepted: boolean }) => void,
  ) => void;

  "initiate-call": (
    data: {
      workspaceId: string;
      targetPhone: string;
      callerName?: string;
      sdpOffer?: string;
    },
    ack?: (
      error: Error | null,
      response?: { accepted: boolean; callId?: string },
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

  "hangup-call": (data: { workspaceId: string; callId: string }) => void;

  "call:cancel": (data: {
    workspaceId: string;
    callId?: string;
    targetPhone?: string;
  }) => void;

  "cancel-call": (data: {
    workspaceId: string;
    callId?: string;
    targetPhone?: string;
  }) => void;
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

declare global {
  // eslint-disable-next-line no-var
  var __CALL_SOCKET_IO__: CallSocketServer | null | undefined;
}

let callSocketIO: CallSocketServer | null = null;

// Track cancelled calls by workspace and phone number to abort inflight calls
const cancelledCallTargets = new Map<string, number>();

const cleanExpiredCancelledTargets = () => {
  const now = Date.now();
  for (const [key, timestamp] of cancelledCallTargets.entries()) {
    if (now - timestamp > 60000) {
      cancelledCallTargets.delete(key);
    }
  }
};

// 🔥 একক এবং নিরাপদ গ্লোবাল রিটার্ন (কোনও ডুপ্লিকেট ডিক্লেয়ারেশন নেই)
export const getCallSocketIO = (): CallSocketServer | null => {
  return globalThis.__CALL_SOCKET_IO__ ?? callSocketIO ?? null;
};

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
  phoneNumberId?: string;
};

type CallEndedNotificationData = {
  notificationId: string;
  workspaceId: string;
  callId: string;
  status: "MISSED" | "REJECTED" | "ENDED" | "CANCELLED";
};

const SOCKET_NOTIFICATION_ACK_TIMEOUT = 5000;

export function deliverIncomingCallNotification(
  userId: string,
  data: IncomingCallNotificationData,
): Promise<boolean> {
  const io = getCallSocketIO();
  if (!io || !isValidObjectId(userId)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    (
      io.to(getUserRoom(userId)).timeout(SOCKET_NOTIFICATION_ACK_TIMEOUT) as any
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

export function deliverCallEndedNotification(
  userId: string,
  data: CallEndedNotificationData,
): Promise<boolean> {
  const io = getCallSocketIO();
  if (!io || !isValidObjectId(userId)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    (
      io.to(getUserRoom(userId)).timeout(SOCKET_NOTIFICATION_ACK_TIMEOUT) as any
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

export const initCallSocket = (io: CallSocketServer): void => {
  callSocketIO = io;
  globalThis.__CALL_SOCKET_IO__ = io; // 🔥 নিশ্চিত গ্লোবাল রেফারেন্স সংরক্ষণ
  console.info(
    "✅ [Call Socket] Global callSocketIO initialized successfully.",
  );

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
        console.info(
          `[Call Socket] User ${userId} joined workspace: ${workspaceId}`,
        );
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
     * Agent answers incoming call
     */
    authenticatedSocket.on("answer-incoming-call", async (data, ack) => {
      try {
        if (!data || !data.workspaceId || !data.callId) {
          const error = new Error(
            "A valid workspace ID and call ID are required.",
          );
          emitSocketError(
            authenticatedSocket,
            "INVALID_CALL_DATA",
            error.message,
          );
          ack?.(error);
          return;
        }

        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data.workspaceId,
        );

        if (!allowed) {
          ack?.(new Error("Workspace access denied."));
          return;
        }

        if (!data.sdpAnswer?.trim()) {
          const error = new Error(
            "SDP answer is required to accept a WhatsApp call.",
          );
          emitSocketError(
            authenticatedSocket,
            "INVALID_SDP_ANSWER",
            error.message,
          );
          ack?.(error);
          return;
        }

        const now = new Date();

        const callQuery: Record<string, unknown> = {
          workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
          status: "RINGING",
          $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }],
        };

        if (isValidObjectId(data.callId)) {
          callQuery._id = new mongoose.Types.ObjectId(data.callId);
        } else {
          callQuery.providerCallId = data.callId;
        }

        const call = await CallLog.findOneAndUpdate(
          callQuery,
          // {
          //   $set: {
          //     status: "ASSIGNING",
          //     assignedTo: new mongoose.Types.ObjectId(userId),
          //     assignedAt: now,
          //     answeredAt: now,
          //   },
          // },
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
          const error = new Error(
            "This call is no longer available or was answered by someone else.",
          );
          emitSocketError(
            authenticatedSocket,
            "CALL_NOT_AVAILABLE",
            error.message,
          );
          ack?.(error);
          return;
        }

        const assignedTo = call.assignedTo?.toString() ?? userId;
        const targetCallId = call.providerCallId || data.callId;

        const account = await WhatsAppAccount.findOne({
          workspaceId: call.workspaceId,
          status: "CONNECTED",
        })
          .select("phoneNumberId +accessTokenEncrypted")
          .lean();

        const phoneId = (call as any).phoneNumberId || account?.phoneNumberId;
        let token: string | undefined;
        if (account?.accessTokenEncrypted) {
          try {
            token = decrypt(account.accessTokenEncrypted);
          } catch (decryptErr) {
            console.error(
              "[Call Socket] Failed to decrypt account token for answer-incoming-call:",
              decryptErr,
            );
          }
        }

        if (!token) {
          token =
            process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
            process.env.META_SYSTEM_USER_TOKEN ||
            process.env.WHATSAPP_ACCESS_TOKEN;
        }

        if (!phoneId || !token) {
          await CallLog.updateOne(
            { _id: call._id, status: "ASSIGNING" },
            {
              $set: { status: "RINGING" },
              $unset: { assignedTo: 1, assignedAt: 1, answeredAt: 1 },
            },
          );
          const error = new Error("WhatsApp account credentials not found.");
          emitSocketError(
            authenticatedSocket,
            "ACCOUNT_NOT_CONFIGURED",
            error.message,
          );
          ack?.(error);
          return;
        }

        // console.log("[CALL ACCEPT ATTEMPT]", {
        //   userId,
        //   workspaceId: data.workspaceId,
        //   receivedCallId: data.callId,
        //   providerCallId: call.providerCallId,
        //   callLogId: call._id.toString(),
        //   status: call.status,
        //   timestamp: new Date().toISOString(),
        // });

        const metaSuccess = await acceptMetaCallWithSdp(
          phoneId,
          targetCallId,
          data.sdpAnswer,
          token,
        );

        if (!metaSuccess) {
          await CallLog.updateOne(
            { _id: call._id, status: "ASSIGNING" },
            {
              $set: { status: "RINGING" },
              $unset: { assignedTo: 1, assignedAt: 1, answeredAt: 1 },
            },
          );
          const error = new Error("Meta rejected the call acceptance request.");
          emitSocketError(
            authenticatedSocket,
            "META_CALL_ACCEPT_FAILED",
            error.message,
          );
          ack?.(error);
          return;
        }
        await CallLog.updateOne(
          {
            _id: call._id,
            workspaceId: call.workspaceId,
          },
          {
            $set: {
              status: "RINGING",
              assignedTo: new mongoose.Types.ObjectId(userId),
              assignedAt: call.assignedAt || new Date(),
            },
            $unset: {
              answeredAt: 1,
            },
          },
        );

        ack?.(null, { accepted: true });

        // অন্য সব এজেন্টদের রিং বন্ধ করতে জানানো
        socket.to(data.workspaceId).emit("call-taken", {
          workspaceId: data.workspaceId,
          callId: targetCallId,
          assignedTo,
        });
      } catch (error) {
        console.error("[Call Socket] Answer event failed:", error);
        const message =
          error instanceof Error
            ? error.message
            : "Unable to answer this call.";
        emitSocketError(authenticatedSocket, "CALL_ANSWER_FAILED", message);
        ack?.(error instanceof Error ? error : new Error(message));
      }
    });

    /**
     * Outgoing Call handler
     */
    authenticatedSocket.on("initiate-call", async (data, ack) => {
      try {
        if (!data?.workspaceId || !data?.targetPhone || !data?.sdpOffer) {
          const error = new Error(
            "workspaceId, targetPhone, and sdpOffer are required.",
          );
          emitSocketError(
            authenticatedSocket,
            "INVALID_CALL_PARAMS",
            error.message,
          );
          ack?.(error);
          return;
        }

        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data.workspaceId,
        );

        if (!allowed) {
          ack?.(new Error("Workspace access denied."));
          return;
        }

        const account = await WhatsAppAccount.findOne({
          workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
          status: "CONNECTED",
        })
          .select("phoneNumberId +accessTokenEncrypted")
          .lean();

        let token: string | undefined;
        if (account?.accessTokenEncrypted) {
          try {
            token = decrypt(account.accessTokenEncrypted);
          } catch (decryptErr) {
            console.error(
              "[Call Socket] Failed to decrypt account token for initiate-call:",
              decryptErr,
            );
          }
        }

        if (!token) {
          token =
            process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
            process.env.META_SYSTEM_USER_TOKEN ||
            process.env.WHATSAPP_ACCESS_TOKEN;
        }
        const phoneId = account?.phoneNumberId;

        if (!phoneId || !token) {
          const error = new Error("Connected WhatsApp credentials missing.");
          emitSocketError(
            authenticatedSocket,
            "NO_CONNECTED_ACCOUNT",
            error.message,
          );
          ack?.(error);
          return;
        }

        const response = await initiateMetaOutgoingCall(
          phoneId,
          data.targetPhone,
          data.sdpOffer,
          token,
        );

        if (!response.success || !response.callId) {
          const error = new Error("Meta rejected the outgoing call.");
          emitSocketError(
            authenticatedSocket,
            "META_CALL_INITIATION_FAILED",
            error.message,
          );
          ack?.(error);
          return;
        }

        cleanExpiredCancelledTargets();
        const cancelKey = `${data.workspaceId}:${data.targetPhone}`;
        if (cancelledCallTargets.has(cancelKey)) {
          cancelledCallTargets.delete(cancelKey);
          console.info(
            `[Call Socket] Call to ${data.targetPhone} was cancelled during dialing. Terminating immediately.`,
          );
          await terminateMetaCall(phoneId, response.callId, token);

          const callLogId = new mongoose.Types.ObjectId();
          await CallLog.create({
            _id: callLogId,
            workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
            providerCallId: response.callId,
            callSid: callLogId.toString(),
            phoneNumber: data.targetPhone,
            callerName: data.callerName || "Customer",
            phoneNumberId: phoneId,
            callType: "OUTGOING",
            status: "CANCELLED",
            assignedTo: new mongoose.Types.ObjectId(userId),
            startedAt: new Date(),
            endedAt: new Date(),
            durationSeconds: 0,
          });

          await createCallEndMessage(callLogId);

          const cancelData = {
            notificationId: response.callId,
            workspaceId: data.workspaceId,
            callId: response.callId,
            status: "CANCELLED" as const,
          };
          authenticatedSocket.emit("incoming-call-ended", cancelData);
          io.to(data.workspaceId).emit("incoming-call-ended", cancelData);
          io.to(`workspace_${data.workspaceId}`).emit(
            "incoming-call-ended",
            cancelData,
          );
          ack?.(null, { accepted: false, callId: response.callId });
          return;
        }

        const callLogId = new mongoose.Types.ObjectId();
        await CallLog.create({
          _id: callLogId,
          workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
          providerCallId: response.callId,
          callSid: callLogId.toString(),
          phoneNumber: data.targetPhone,
          callerName: data.callerName || "Customer",
          phoneNumberId: phoneId,
          callType: "OUTGOING",
          status: "RINGING",
          assignedTo: new mongoose.Types.ObjectId(userId),
          startedAt: new Date(),
          durationSeconds: 0,
        });

        authenticatedSocket.emit("call-dialing", {
          targetPhone: data.targetPhone,
          callerName: data.callerName || "Customer",
          callId: response.callId,
        });

        if (response.sdpAnswer) {
          authenticatedSocket.emit("webrtc-answer", {
            workspaceId: data.workspaceId,
            callId: response.callId,
            sdp: {
              type: "answer",
              sdp: response.sdpAnswer,
            },
          });
        }

        ack?.(null, { accepted: true, callId: response.callId });
      } catch (error) {
        console.error("[Call Socket] Initiate event failed:", error);
        const message =
          error instanceof Error
            ? error.message
            : "Could not start outgoing call.";
        emitSocketError(authenticatedSocket, "INITIATE_CALL_FAILED", message);
        ack?.(error instanceof Error ? error : new Error(message));
      }
    });

    /**
     * Hangup handler
     */
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

        if (call) {
          const account = await WhatsAppAccount.findOne({
            workspaceId: call.workspaceId,
            status: "CONNECTED",
          })
            .select("phoneNumberId +accessTokenEncrypted")
            .lean();

          const phoneId = call.phoneNumberId || account?.phoneNumberId;
          let token: string | undefined;
          if (account?.accessTokenEncrypted) {
            try {
              token = decrypt(account.accessTokenEncrypted);
            } catch (decryptErr) {
              console.error(
                "[Call Socket] Failed to decrypt account token for hangup-call:",
                decryptErr,
              );
            }
          }

          if (!token) {
            token =
              process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
              process.env.META_SYSTEM_USER_TOKEN ||
              process.env.WHATSAPP_ACCESS_TOKEN;
          }

          const metaCallId = call.providerCallId;
          if (
            metaCallId &&
            !/^[a-f\d]{24}$/i.test(metaCallId) &&
            phoneId &&
            token
          ) {
            await terminateMetaCall(phoneId, metaCallId, token);
          }

          const isRinging =
            call.status === "RINGING" || call.status === "ASSIGNING";
          call.status = isRinging ? "CANCELLED" : "ENDED";
          call.endedAt = new Date();
          if (isRinging) {
            call.durationSeconds = 0;
          }
          await call.save();

          // Generate and broadcast call log bubble in chat
          await createCallEndMessage(call._id);

          const endData = {
            notificationId: metaCallId || call._id.toString(),
            workspaceId: data.workspaceId,
            callId: metaCallId || call._id.toString(),
            status: (isRinging ? "CANCELLED" : "ENDED") as "ENDED" | "CANCELLED",
          };

          io.to(data.workspaceId).emit("incoming-call-ended", endData);
          io.to(`workspace_${data.workspaceId}`).emit(
            "incoming-call-ended",
            endData,
          );
          authenticatedSocket.emit("incoming-call-ended", endData);
        }
      } catch (error) {
        console.error("[Call Socket] Hangup event failed:", error);
      }
    });

    /**
     * Early Call Cancellation / Ghost Ring Prevention handler
     */
    const handleCallCancel = async (data: {
      workspaceId: string;
      callId?: string;
      targetPhone?: string;
    }) => {
      try {
        if (!data?.workspaceId) return;

        const allowed = await authorizeWorkspace(
          authenticatedSocket,
          data.workspaceId,
        );
        if (!allowed) return;

        if (data.targetPhone) {
          cleanExpiredCancelledTargets();
          cancelledCallTargets.set(
            `${data.workspaceId}:${data.targetPhone}`,
            Date.now(),
          );
        }

        const query: Record<string, unknown> = {
          workspaceId: new mongoose.Types.ObjectId(data.workspaceId),
        };

        if (data.callId && isValidObjectId(data.callId)) {
          query._id = new mongoose.Types.ObjectId(data.callId);
        } else if (data.callId) {
          query.providerCallId = data.callId;
        } else if (data.targetPhone) {
          query.phoneNumber = data.targetPhone;
          query.status = { $in: ["RINGING", "ASSIGNING"] };
        } else {
          return;
        }

        const call = await CallLog.findOne(query).sort({ createdAt: -1 });

        if (call) {
          const account = await WhatsAppAccount.findOne({
            workspaceId: call.workspaceId,
            status: "CONNECTED",
          })
            .select("phoneNumberId +accessTokenEncrypted")
            .lean();

          const phoneId = call.phoneNumberId || account?.phoneNumberId;
          let token: string | undefined;
          if (account?.accessTokenEncrypted) {
            try {
              token = decrypt(account.accessTokenEncrypted);
            } catch (decryptErr) {
              console.error(
                "[Call Socket] Failed to decrypt account token for call:cancel:",
                decryptErr,
              );
            }
          }

          if (!token) {
            token =
              process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
              process.env.META_SYSTEM_USER_TOKEN ||
              process.env.WHATSAPP_ACCESS_TOKEN;
          }

          const metaCallId = call.providerCallId;
          if (
            metaCallId &&
            !/^[a-f\d]{24}$/i.test(metaCallId) &&
            phoneId &&
            token
          ) {
            await terminateMetaCall(phoneId, metaCallId, token);
          }

          call.status = "CANCELLED";
          call.endedAt = new Date();
          call.durationSeconds = 0;
          await call.save();

          await createCallEndMessage(call._id);

          const cancelData = {
            notificationId: metaCallId || call._id.toString(),
            workspaceId: data.workspaceId,
            callId: metaCallId || call._id.toString(),
            status: "CANCELLED" as const,
          };

          io.to(data.workspaceId).emit("incoming-call-ended", cancelData);
          io.to(`workspace_${data.workspaceId}`).emit(
            "incoming-call-ended",
            cancelData,
          );
          authenticatedSocket.emit("incoming-call-ended", cancelData);
        }
      } catch (error) {
        console.error("[Call Socket] Call cancel failed:", error);
      }
    };

    authenticatedSocket.on("call:cancel", handleCallCancel);
    authenticatedSocket.on("cancel-call", handleCallCancel);

    authenticatedSocket.on("disconnect", (reason) => {
      console.info("[Call Socket] Disconnected:", {
        userId,
        reason,
      });
    });
  });
};
