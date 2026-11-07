import mongoose from "mongoose";
import type { Response } from "express";
import axios from "axios";

import CallLog from "../Calling/CallLog.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Format duration safely.
 * Returns "00:00" or formatted time string instead of undefined.
 */
const formatDuration = (seconds?: number | null): string => {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return "00:00";
  }

  const safeSeconds = Math.floor(seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
};

/**
 * Safely format Date to ISO string without throwing RangeError.
 */
const safeToISOString = (date?: Date | string | null): string | null => {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Get call logs with pagination, search, and filtering
 */
export const getCallLogs = async (
  req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  try {
    const workspaceId =
      req.workspace?.id ??
      (typeof req.params.workspaceId === "string" ? req.params.workspaceId : undefined);

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(403).json({
        success: false,
        code: "WORKSPACE_CONTEXT_REQUIRED",
        message: "Valid workspace authorization is required.",
      });
    }

    const { filter, search, page = "1", limit = "50" } = req.query;

    const allowedFilters = ["ALL", "MISSED", "INCOMING", "OUTGOING"];
    if (
      filter !== undefined &&
      !allowedFilters.includes(String(filter).toUpperCase())
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CALL_FILTER",
        message:
          "Invalid call filter. Allowed: ALL, MISSED, INCOMING, OUTGOING",
      });
    }

    if (search !== undefined && typeof search !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_CALL_SEARCH",
        message: "Search must be a string.",
      });
    }

    const query: Record<string, unknown> = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    };

    const upperFilter =
      typeof filter === "string" ? filter.toUpperCase() : "ALL";
    if (upperFilter === "MISSED") {
      query.callType = "MISSED";
    } else if (upperFilter === "INCOMING") {
      query.callType = "INCOMING";
    } else if (upperFilter === "OUTGOING") {
      query.callType = "OUTGOING";
    }

    if (typeof search === "string" && search.trim()) {
      const safeSearch = escapeRegex(search.trim().slice(0, 80));
      query.$or = [
        { callerName: { $regex: safeSearch, $options: "i" } },
        { phoneNumber: { $regex: safeSearch, $options: "i" } },
      ];
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(
      100,
      Math.max(1, parseInt(String(limit), 10) || 50),
    );
    const skip = (pageNum - 1) * limitNum;

    const [logs, totalCount] = await Promise.all([
      CallLog.find(query)
        .sort({ startedAt: -1, _id: -1 })
        .skip(skip)
        .limit(limitNum)
        .select(
          [
            "_id",
            "callerName",
            "phoneNumber",
            "callType",
            "status",
            "providerCallId",
            "callSid",
            "durationSeconds",
            "startedAt",
            "endedAt",
            "createdAt",
          ].join(" "),
        )
        .lean(),
      CallLog.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      meta: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
      },
      data: logs.map((log) => ({
        id: log._id.toString(),
        name: log.callerName || "Unknown",
        phone: log.phoneNumber,
        type: log.callType,
        status: log.status,
        providerCallId: log.providerCallId ?? null,
        callSid: log.callSid ?? null,
        startedAt: log.startedAt ?? null,
        endedAt: log.endedAt ?? null,
        timestamp: safeToISOString(log.startedAt),
        duration: formatDuration(log.durationSeconds),
        durationSeconds: log.durationSeconds ?? 0,
      })),
    });
  } catch (error) {
    console.error("[Calling] Get call logs failed:", error);
    return res.status(500).json({
      success: false,
      code: "CALL_LOG_FETCH_FAILED",
      message: "Unable to fetch call logs.",
    });
  }
};

/**
 * Initiates an outgoing call via Meta WhatsApp Cloud API.
 */
export const startOutgoingCall = async (
  req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  try {
    const workspaceId =
      req.workspace?.id ??
      (typeof req.params.workspaceId === "string" ? req.params.workspaceId : undefined);
    const userId = req.user?.id;

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(403).json({
        success: false,
        code: "WORKSPACE_CONTEXT_REQUIRED",
        message: "Valid workspace authorization is required.",
      });
    }

    const { phoneNumber, callerName, sdpOffer } = req.body;

    if (!phoneNumber || typeof phoneNumber !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PHONE_NUMBER",
        message: "Recipient phone number is required.",
      });
    }

    // телефон নম্বর ফরম্যাট ঠিক করা (E.164: শুধু সংখ্যা)
    const cleanPhone = phoneNumber.replace(/\D/g, "");

    if (!cleanPhone || cleanPhone.length < 7) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PHONE_NUMBER",
        message: "A valid recipient phone number is required.",
      });
    }

    // ১. ওয়ার্কস্পেসের WhatsApp অ্যাকাউন্ট ক্রেডেনশিয়াল রিট্রিভ করা
    const account = await WhatsAppAccount.findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      status: "CONNECTED",
    })
      .select("phoneNumberId accessToken")
      .lean();

    if (!account) {
      return res.status(400).json({
        success: false,
        code: "WHATSAPP_ACCOUNT_NOT_CONNECTED",
        message:
          "No connected WhatsApp Business account found for this workspace.",
      });
    }

    const token =
      (account as any).accessToken ||
      process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
      process.env.WHATSAPP_ACCESS_TOKEN;

    const phoneNumberId =
      account.phoneNumberId || process.env.TEST_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      return res.status(500).json({
        success: false,
        code: "WHATSAPP_CREDENTIALS_MISSING",
        message: "WhatsApp Access Token or Phone Number ID is missing.",
      });
    }

    // ২. মেটার Graph API দিয়ে আউটগোয়িং কল তৈরি করা
    let providerCallId: string | undefined;
    let metaSessionData: unknown = null;

    try {
      const metaPayload: Record<string, unknown> = {
        messaging_product: "whatsapp",
        to: cleanPhone,
        action: "connect",
      };

      if (sdpOffer) {
        metaPayload.session = {
          sdp_type: "offer",
          sdp: sdpOffer,
        };
      }

      const metaResponse = await axios.post(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/calls`,
        metaPayload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );

      providerCallId = metaResponse.data?.id || metaResponse.data?.call_id;
      metaSessionData = metaResponse.data?.session ?? null;
    } catch (metaError: any) {
      console.error(
        "[Meta Outgoing Call Error]:",
        metaError.response?.data || metaError.message,
      );

      const errorMessage =
        metaError.response?.data?.error?.message ||
        "Failed to initiate call via WhatsApp Cloud API.";

      return res.status(400).json({
        success: false,
        code: "META_OUTGOING_FAILED",
        message: errorMessage,
      });
    }

    // ৩. ডাটাবেজে OUTGOING CallLog তৈরি করা
    const callLog = await CallLog.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      phoneNumber: cleanPhone,
      callerName: callerName || "Unknown",
      callType: "OUTGOING",
      status: "RINGING",
      providerCallId: providerCallId || `outgoing_${Date.now()}`,
      phoneNumberId,
      startedAt: new Date(),
      assignedTo: userId && mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : undefined,
      durationSeconds: 0,
      ringingUserIds: [],
    });

    return res.status(200).json({
      success: true,
      data: {
        id: callLog._id.toString(),
        callId: callLog.providerCallId,
        status: callLog.status,
        session: metaSessionData,
      },
    });
  } catch (error) {
    console.error("[Calling] Start outgoing call error:", error);
    return res.status(500).json({
      success: false,
      code: "START_OUTGOING_CALL_FAILED",
      message: "An internal error occurred while starting the call.",
    });
  }
};

/**
 * Call termination endpoint.
 */
export const endCallSession = async (
  req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  try {
    const workspaceId =
      req.workspace?.id ??
      (typeof req.params.workspaceId === "string" ? req.params.workspaceId : undefined);

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(403).json({
        success: false,
        code: "WORKSPACE_CONTEXT_REQUIRED",
        message: "Valid workspace authorization is required.",
      });
    }

    const callId = req.params.callId || req.body.callId;
    const duration =
      req.body.durationSeconds !== undefined
        ? Number(req.body.durationSeconds)
        : req.body.duration !== undefined
          ? Number(req.body.duration)
          : undefined;
    const status = req.body.status || "ENDED";

    if (!callId) {
      return res.status(400).json({
        success: false,
        code: "CALL_ID_REQUIRED",
        message: "Call ID is required to end the session.",
      });
    }

    // MongoDB _id অথবা providerCallId উভয় দিয়েই কল খুঁজে নেওয়া
    const query: Record<string, unknown> = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    };

    if (mongoose.Types.ObjectId.isValid(callId)) {
      query._id = new mongoose.Types.ObjectId(callId);
    } else {
      query.providerCallId = callId;
    }

    const call = await CallLog.findOne(query);

    if (!call) {
      return res.status(404).json({
        success: false,
        code: "CALL_NOT_FOUND",
        message: "Call session not found.",
      });
    }

    const now = new Date();
    const finalDuration =
      duration !== undefined
        ? Math.floor(duration)
        : call.startedAt
          ? Math.max(
            0,
            Math.floor((now.getTime() - call.startedAt.getTime()) / 1000),
          )
          : 0;

    // মেটাতে টার্মিনেশন রিকোয়েস্ট পাঠানো (যদি কলটি এখনও সক্রিয় থাকে)
    if (call.providerCallId) {
      const account = await WhatsAppAccount.findOne({
        workspaceId: call.workspaceId,
        status: "CONNECTED",
      })
        .select("phoneNumberId accessToken")
        .lean();

      const token =
        (account as any)?.accessToken ||
        process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
        process.env.WHATSAPP_ACCESS_TOKEN;

      const targetPhoneNumberId =
        call.phoneNumberId ||
        account?.phoneNumberId ||
        process.env.TEST_PHONE_NUMBER_ID;

      if (token && targetPhoneNumberId) {
        try {
          await axios.post(
            `https://graph.facebook.com/v21.0/${targetPhoneNumberId}/calls`,
            {
              messaging_product: "whatsapp",
              call_id: call.providerCallId,
              action: "terminate",
            },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            },
          );
        } catch (metaErr: any) {
          // মেটা আগে থেকেই ড্রপ করে থাকলে ওয়ার্নিং লগ করে প্রসেস চালিয়ে নেওয়া
          console.warn(
            "[Calling] Meta terminate call warning:",
            metaErr.response?.data?.error?.message || metaErr.message,
          );
        }
      }
    }

    call.status = status === "REJECTED" ? "REJECTED" : "ENDED";
    call.endedAt = now;
    call.durationSeconds = finalDuration;
    await call.save();

    return res.status(200).json({
      success: true,
      message: "Call session ended successfully.",
      data: {
        id: call._id.toString(),
        callId: call.providerCallId,
        status: call.status,
        durationSeconds: call.durationSeconds,
      },
    });
  } catch (error) {
    console.error("[Calling] End call session failed:", error);
    return res.status(500).json({
      success: false,
      code: "END_CALL_SESSION_FAILED",
      message: "An error occurred while ending the call session.",
    });
  }
};
