import mongoose from "mongoose";
import type { Response } from "express";

import CallLog from "../Calling/CallLog.js";
import type { WorkspaceRequest } from "../../middlewares/require-workspace-membership.js";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const formatDuration = (seconds: number): string | undefined => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  const safeSeconds = Math.floor(seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
};

export const getCallLogs = async (
  req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  try {
    const workspaceId = req.workspace?.id;

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(403).json({
        success: false,
        code: "WORKSPACE_CONTEXT_REQUIRED",
        message: "Valid workspace authorization is required.",
      });
    }

    const rawFilter = req.query.filter;
    const rawSearch = req.query.search;

    if (
      rawFilter !== undefined &&
      rawFilter !== "ALL" &&
      rawFilter !== "MISSED"
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CALL_FILTER",
        message: "Invalid call filter.",
      });
    }

    if (rawSearch !== undefined && typeof rawSearch !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_CALL_SEARCH",
        message: "Search must be a string.",
      });
    }

    const query: Record<string, unknown> = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    };

    if (rawFilter === "MISSED") {
      query.callType = "MISSED";
    }

    if (typeof rawSearch === "string" && rawSearch.trim()) {
      const safeSearch = escapeRegex(rawSearch.trim().slice(0, 80));

      query.$or = [
        {
          callerName: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          phoneNumber: {
            $regex: safeSearch,
            $options: "i",
          },
        },
      ];
    }

    const logs = await CallLog.find(query)
      .sort({
        startedAt: -1,
        _id: -1,
      })
      .limit(50)
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
      .lean();

    return res.status(200).json({
      success: true,
      data: logs.map((log) => ({
        id: log._id.toString(),
        name: log.callerName,
        phone: log.phoneNumber,
        type: log.callType,
        status: log.status,

        providerCallId: log.providerCallId ?? null,

        // Legacy compatibility only.
        callSid: log.callSid ?? null,

        startedAt: log.startedAt,
        endedAt: log.endedAt,
        timestamp: log.startedAt?.toISOString(),
        duration: formatDuration(log.durationSeconds),
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
 * Outgoing calls remain disabled until the actual
 * Meta Calling API integration is implemented.
 *
 * This endpoint intentionally does not create a fake
 * CallLog or emit a fake call event.
 */
export const startOutgoingCall = async (
  _req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  return res.status(501).json({
    success: false,
    code: "META_CALLING_NOT_IMPLEMENTED",
    message:
      "Outgoing WhatsApp calling is not configured yet. No call was started.",
  });
};

/**
 * Call termination must be handled through the actual
 * provider call lifecycle.
 *
 * Client-supplied status and duration are never trusted.
 */
export const endCallSession = async (
  _req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  return res.status(501).json({
    success: false,
    code: "META_CALL_TERMINATION_NOT_IMPLEMENTED",
    message:
      "Call termination is not configured yet. The call state was not changed.",
  });
};
