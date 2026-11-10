import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
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
import platformAdminGovernanceRouter from "./modules/platform-admin-dashboard/governance.routes.js";
import supportTicketRouter from "./modules/support/support-ticket.routes.js";
import customerSupportRouter from "./modules/support/customer-support.routes.js";
import platformSettingsRouter from "./modules/settings/platform-settings.routes.js";

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
import {
  getWhatsAppMediaStreamController,
  sendWhatsAppMediaMessageController,
} from "./modules/whatsapp/whatsapp.controller.js";
import { authenticate } from "./middlewares/authenticate.js";
import { requireWorkspaceMembership } from "./middlewares/require-workspace-membership.js";
import { requireRole } from "./middlewares/require-role.js";
import automationRoutes from "./router/automation.routes.js";
import bikashRouter from "./modules/billing/gateways/bikash.router.js";
import { zinipayPublicRouter } from "./modules/billing/gateways/zinipay.routes.js";

const app = express();
const server = http.createServer(app);

// 1. Trust proxy for Render / Cloudflare / Load Balancers
app.set("trust proxy", 1);

// 2. Disable ETag to prevent unwanted 304 caching on API routes
app.set("etag", false);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// 3. Multi-origin CORS setup (www, non-www and local)
const allowedOrigins = [
  "https://www.vexchat.io",
  "https://vexchat.io",
  "http://localhost:3000",
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server requests or matching origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Admin BFF Assertion এবং সেশন হেডার অ্যালাউ করা হলো
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "x-workspace-id",
    "x-bff-assertion",
    "x-admin-bff-assertion",
    "x-admin-session-token",
    "x-vercel-protection-bypass",
  ],
};

app.use(cors(corsOptions));

// 4. Cookie Parser Middleware (অ্যাডমিন HttpOnly সেশন কুকি পার্স করার জন্য আবশ্যক)
app.use(cookieParser());

// 5. Disable browser caching for all dynamic API responses
app.use("/api", (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  next();
});

// 6. Socket.IO initialization with robust CORS & transports
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  CallSocketData
>(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
});

// Preserve exact request bytes for Meta webhook signature verification.
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

// ========================================================
// 1. PUBLIC WEBHOOKS (সবার উপরে রাখতে হবে)
// ========================================================
app.use("/api/whatsapp", whatsappRoutes);
// Payment Gateways (bKash & ZiniPay)
app.use("/api/billing/gateways", bikashRouter);
app.use("/api/billing/gateways", zinipayPublicRouter);

// ========================================================
// 2. Authentication and Settings
// ========================================================
app.use("/api/auth", authRouter);
app.use("/api/settings", settingRouter);

// ========================================================
// 3. Other APIs
// ========================================================
app.use("/api", callingRoutes);
app.use("/api", internalCronRouter);

// Workspace and billing.
app.use("/api/workspaces", workspaceRouter);

// Workspace WhatsApp Media and Messaging Routes (drop-in aliases for frontend convenience)
app.get(
  "/api/workspaces/:workspaceId/whatsapp/media/:mediaId",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  getWhatsAppMediaStreamController,
);
app.post(
  "/api/workspaces/:workspaceId/whatsapp/messages/media",
  authenticate,
  requireWorkspaceMembership,
  requireRole("OWNER", "ADMIN", "AGENT"),
  sendWhatsAppMediaMessageController,
);
// Register router with workspace prefix
app.use("/api/workspaces/:workspaceId/automations", automationRoutes);

app.use("/api/workspaces/:workspaceId/billing", workspaceBillingRouter);
app.use("/api/billing/:workspaceId", workspaceBillingRouter);
app.use("/api/admin/billing", platformAdminBillingRouter);
app.use("/api/platform-admin/billing", platformAdminBillingRouter);

// Platform administrator.
app.use("/api/platform-admin/auth", adminAuthRouter);
app.use("/api/platform-admin/dashboard", platformAdminDashboardRouter);
app.use("/api/platform-admin", platformAdminGovernanceRouter);
app.use("/api/admin", platformAdminGovernanceRouter);

// Platform Support Desk.
app.use("/api/platform-admin/support", supportTicketRouter);
app.use("/api/admin/support", supportTicketRouter);

// Workspace Customer Support.
app.use("/api/support", customerSupportRouter);
app.use("/api/workspaces/:workspaceId/support", customerSupportRouter);

// Platform Dynamic System Settings.
app.use("/api/platform-admin/settings", platformSettingsRouter);
app.use("/api/admin/settings", platformSettingsRouter);

// Invitations.
app.use("/api/invitations", invitationRouter);

// Other application modules.
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/campaigns", campaignRoutes);

// Root health & status endpoints
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to VexChat API Server",
    status: "Running",
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "VexChat API is running successfully!",
    timestamp: new Date().toISOString(),
  });
});

// Unknown routes handler
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
