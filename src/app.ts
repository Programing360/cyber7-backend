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
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));

// 4. Disable browser caching for all dynamic API responses
app.use("/api", (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  next();
});

// 5. Socket.IO initialization with robust CORS & transports
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  CallSocketData
>(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
});

console.log("[Socket.IO] Initialized:", io.engine !== undefined);
console.log("[Socket.IO] Path:", io.engine.opts.path);


console.log("[SOCKET DEBUG]", {
  path: io.engine.opts.path,
  attached: server.listeners("request").length,
});

io.engine.on("connection", (connection) => {
  console.log("[Socket.IO] Engine connected:", connection.id);
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

// Authentication and settings.
app.use("/api/auth", authRouter);
app.use("/api/settings", settingRouter);

// Calling APIs: authentication and workspace membership
app.use("/api", callingRoutes);

// Internal cron endpoint (CRON_SECRET protected).
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

// WhatsApp Webhook & APIs
app.use("/api/whatsapp", whatsappRoutes);

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
