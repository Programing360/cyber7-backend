import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { Server } from "socket.io";

import authRouter from "./modules/auth/auth.routes.js";
import workspaceRouter from "./modules/workspace/workspace.routes.js";
import invitationRouter from "./modules/workspace/invitation/invitation.routes.js";
import whatsappRoutes from "./modules/whatsapp/whatsapp.routes.js";
import dashboardRoutes from "./modules/dashboard/dashboard.routes.js";
import campaignRoutes from "./modules/campaign/campaign.routes.js";
import settingRouter from "./modules/setting/setting.routes.js";

import {
  workspaceBillingRouter,
  platformAdminBillingRouter,
} from "./modules/billing/billing.routes.js";

import adminAuthRouter from "./modules/admin-auth/admin-auth.routes.js";
import platformAdminDashboardRouter from "./modules/platform-admin-dashboard/dashboard.routes.js";

import { errorHandler } from "./middlewares/error-handler.js";

import {
  initCallSocket,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type CallSocketData,
} from "./sockets/callSocket.js";
import callingRoutes, {
  internalCronRouter,
} from "./modules/Calling/calling.routes.js";

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

app.use(helmet());

const clientUrl =
  process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:3000";

app.use(
  cors({
    origin: clientUrl,
    credentials: true,
  }),
);

// Socket.IO with authenticated handshake middleware.
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  CallSocketData
>(server, {
  cors: {
    origin: clientUrl,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Preserve exact request bytes for Meta signature verification.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);

app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// Authenticated Socket.IO calling/signaling.
initCallSocket(io);

// Authentication and settings.
app.use("/api/auth", authRouter);
app.use("/api/settings", settingRouter);

// Calling APIs: authentication and workspace membership are enforced
// inside callingRoutes.
app.use("/api", callingRoutes);

// Internal cron endpoint for Vercel Cron scheduler (CRON_SECRET protected).
app.use("/api", internalCronRouter);

// Workspace and billing.
app.use("/api/workspaces", workspaceRouter);

app.use("/api/workspaces/:workspaceId/billing", workspaceBillingRouter);

app.use("/api/billing/:workspaceId", workspaceBillingRouter);

app.use("/api/admin/billing", platformAdminBillingRouter);

// Platform administrator.
app.use("/api/platform-admin/auth", adminAuthRouter);
app.use("/api/platform-admin/dashboard", platformAdminDashboardRouter);

// Invitations.
app.use("/api/invitations", invitationRouter);

// WhatsApp: mount only once.
// Includes existing GET verification and signed POST webhook.
app.use("/api/whatsapp", whatsappRoutes);

// Other application modules.
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/campaigns", campaignRoutes);

// Root.
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to VexChat API Server",
    status: "Running",
  });
});

// Health check.
app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "VexChat API is running successfully!",
    timestamp: new Date().toISOString(),
  });
});

// Unknown routes.
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
  });
});

// Central error handler must remain last.
app.use(errorHandler);

export { app, server, io };
export default app;
