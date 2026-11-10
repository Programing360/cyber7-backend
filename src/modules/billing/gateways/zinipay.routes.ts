import { Router } from "express";
import { authenticate } from "../../../middlewares/authenticate.js";
import { requireRole } from "../../../middlewares/require-role.js";
import { requireWorkspaceMembership } from "../../../middlewares/require-workspace-membership.js";
import {
  initiateZinipayPaymentController,
  zinipayCallbackController,
} from "./zinipay.controller.js";

/**
 * Public Gateway Callbacks & Webhook Ingress
 * Mounted at `/api/billing/gateways`
 */
export const zinipayPublicRouter = Router();

zinipayPublicRouter.post("/zinipay/webhook", zinipayCallbackController);
zinipayPublicRouter.get("/zinipay/callback", zinipayCallbackController);

/**
 * Workspace Authenticated ZiniPay Initiation Router
 * Can be mounted at `/api/workspaces/:workspaceId/billing/pay` or directly
 */
export const zinipayWorkspaceRouter = Router({ mergeParams: true });

zinipayWorkspaceRouter.use(authenticate);
zinipayWorkspaceRouter.use(requireWorkspaceMembership);
zinipayWorkspaceRouter.use(requireRole("OWNER", "ADMIN"));

zinipayWorkspaceRouter.post("/zinipay", initiateZinipayPaymentController);

export default zinipayPublicRouter;
