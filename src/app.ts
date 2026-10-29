import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import authRouter from "./modules/auth/auth.routes.js";
import workspaceRouter from "./modules/workspace/workspace.routes.js";
import { errorHandler } from "./middlewares/error-handler.js";
import invitationRouter from "./modules/workspace/invitation/invitation.routes.js";

const app = express();

app.use(helmet());

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// Authentication routes
app.use("/api/auth", authRouter);

app.use("/api/workspaces", workspaceRouter);
app.use("/api/invitations", invitationRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Cyber7 API is running successfully!",
    timestamp: new Date().toISOString(),
  });
});

// Unknown routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
  });
});

// Central error handler — keep this last
app.use(errorHandler);

export default app;
