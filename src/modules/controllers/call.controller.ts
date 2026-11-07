import mongoose from "mongoose";
import type { Response } from "express";

import CallLog from "../Calling/CallLog.js";
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

export const getCallLogs = async (
  req: WorkspaceRequest,
  res: Response,
): Promise<Response> => {
  try {
    // 1. Safe workspace ID check (_id or id fallback)
    const rawWorkspaceId = req.workspace?.id;
    const workspaceId = rawWorkspaceId ? String(rawWorkspaceId) : undefined;

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

    // 2. Build Query
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

    // 3. Pagination Support
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
 * Outgoing calls remain disabled until the actual
 * Meta Calling API integration is implemented.
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
 * Call termination endpoint.
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
