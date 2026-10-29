import type { Request, Response, NextFunction } from "express";

import { createInvitation, acceptInvitation } from "./invitation.service.js";

import {
  createInvitationSchema,
  acceptInvitationSchema,
} from "./invitation.validation.js";
import { AppError } from "../../../utils/app-error.js";
import { AuthenticatedRequest } from "../../../middlewares/authenticate.js";

export async function createInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = req.params.workspaceId;

    if (!authReq.user || !workspaceId) {
      throw new AppError("Authentication and workspace are required", 401);
    }

    const validation = createInvitationSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const result = await createInvitation(
      workspaceId,
      authReq.user.id,
      validation.data,
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function acceptInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user) {
      throw new AppError("Authentication required", 401);
    }

    const validation = acceptInvitationSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const result = await acceptInvitation(
      validation.data.token,
      authReq.user.id,
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
