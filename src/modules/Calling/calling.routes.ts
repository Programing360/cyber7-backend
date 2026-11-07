import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";

import { authenticate } from "../../middlewares/authenticate.js";
import { requireWorkspaceMembership } from "../../middlewares/require-workspace-membership.js";
import { requireRole } from "../../middlewares/require-role.js";

import {
  getCallLogs,
  startOutgoingCall,
  endCallSession,
} from "../controllers/call.controller.js";

import { processCallNotificationOutbox } from "./callNotificationOutbox.worker.js";

const callingRoutes = Router();

// ── Authenticated workspace call routes ─────────────────────────────────────

callingRoutes.use("/workspaces/:workspaceId/calls", authenticate);

callingRoutes.get(
  "/workspaces/:workspaceId/calls",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getCallLogs,
);

// ফ্রন্টএন্ড এবং ব্যাকএন্ড উভয়ের সামঞ্জস্যের জন্য দুটি পাথই সক্রিয় রাখা হলো
callingRoutes.post(
  "/workspaces/:workspaceId/calls/start",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  startOutgoingCall,
);

callingRoutes.post(
  "/workspaces/:workspaceId/calls/outgoing",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  startOutgoingCall,
);

callingRoutes.post(
  "/workspaces/:workspaceId/calls/:callId/end",
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  endCallSession,
);

// ── Internal cron route (Vercel Cron / external scheduler) ──────────────────

const internalCronRouter = Router();

internalCronRouter.post(
  "/internal/process-call-notifications",
  async (req: Request, res: Response): Promise<void> => {
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      res.status(503).json({ error: "Cron endpoint is not configured." });
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    // Constant-time comparison to prevent timing attacks.
    const secretBuf = Buffer.from(cronSecret, "utf8");
    const tokenBuf = Buffer.from(token, "utf8");
    const isValid =
      secretBuf.length === tokenBuf.length &&
      crypto.timingSafeEqual(secretBuf, tokenBuf);

    if (!isValid) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    try {
      const result = await processCallNotificationOutbox();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[Cron] processCallNotificationOutbox failed:", err);
      res.status(500).json({ error: "Worker error." });
    }
  },
);

export { internalCronRouter };
export default callingRoutes;
