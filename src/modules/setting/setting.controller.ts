import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/authenticate.js";
import {
  getUserProfile,
  updateUserProfile,
  changeUserPassword,
  AuthError,
} from "../auth/auth.service.js";
import {
  updateProfileSchema,
  changePasswordSchema,
} from "../auth/auth.validation.js";

export const getSettingsProfileController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const profile = await getUserProfile(req.user.id);

    res.status(200).json({
      success: true,
      message: "Settings profile retrieved successfully",
      data: {
        profile,
      },
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
};

export const updateSettingsProfileController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const validation = updateProfileSchema.safeParse(req.body);

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

    const updatedProfile = await updateUserProfile(req.user.id, validation.data);

    res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      data: {
        profile: updatedProfile,
      },
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
};

export const changeSettingsPasswordController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const validation = changePasswordSchema.safeParse(req.body);

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

    const result = await changeUserPassword(req.user.id, validation.data);

    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
};

