import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import {
  initiateRegisterSchema,
  verifyRegistrationOtpSchema,
  resendOtpSchema,
  loginSchema,
  updateProfileSchema,
  changePasswordSchema,
} from "./auth.validation.js";
import {
  AuthError,
  initiateRegistration,
  verifyRegistrationOtp,
  resendRegistrationOtp,
  loginUser,
  getUserProfile,
  updateUserProfile,
  changeUserPassword,
} from "./auth.service.js";
import type { AuthenticatedRequest } from "../../middlewares/authenticate.js";
import { adminAuthService } from "../admin-auth/admin-auth.service.js";

export const initiateRegisterController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    console.log(req.body);
    const validation = initiateRegisterSchema.safeParse(req.body);
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

    const result = await initiateRegistration(validation.data);
    res.status(200).json({ success: true, message: result.message });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

export const verifyRegistrationOtpController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const validation = verifyRegistrationOtpSchema.safeParse(req.body);
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

    const result = await verifyRegistrationOtp(validation.data);
    res.status(201).json({
      success: true,
      message:
        "Account created and verified successfully. 7-Day Free Trial activated!",
      data: result,
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message, code: error.code });
      return;
    }
    next(error);
  }
};

export const resendRegistrationOtpController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const validation = resendOtpSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ success: false, message: "Invalid email" });
      return;
    }

    const result = await resendRegistrationOtp(validation.data);
    res.status(200).json(result);
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

export const loginController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const validation = loginSchema.safeParse(req.body);
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

    const result = await loginUser(validation.data);

    // If platform admin, automatically establish admin session cookie
    if (
      result.user &&
      (result.user.platformRole === "SUPER_ADMIN" ||
        result.user.platformRole === "FINANCE_ADMIN")
    ) {
      try {
        const forwarded = req.headers["x-forwarded-for"];
        const clientIp =
          typeof forwarded === "string"
            ? forwarded.split(",")[0].trim()
            : req.ip || undefined;
        const userAgent =
          typeof req.headers["user-agent"] === "string"
            ? req.headers["user-agent"]
            : undefined;

        const authResult = await adminAuthService.completeChallengeSession({
          userId: result.user.id,
          ipAddress: clientIp,
          userAgent,
        });

        if (
          authResult.success &&
          authResult.cookieOptions &&
          authResult.rawToken
        ) {
          res.cookie(
            authResult.cookieOptions.name,
            authResult.rawToken,
            authResult.cookieOptions.options,
          );
        }

        res.cookie("user_role", result.user.platformRole, {
          path: "/",
          httpOnly: false,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });
      } catch (adminErr) {
        console.error(
          "[Login] Failed to create admin session for platform admin:",
          adminErr,
        );
      }
    }

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: result,
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code, // SUBSCRIPTION_EXPIRED আসলে ফ্রন্টএন্ড /pricing এ রিডাইরেক্ট করবে
      });
      return;
    }
    next(error);
  }
};

export const getCurrentUserController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const profile = await getUserProfile(req.user.id);
    res.status(200).json({
      success: true,
      message: "User profile retrieved successfully",
      data: { user: profile },
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

export const getProfileController = getCurrentUserController;

export const updateProfileController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
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

    const updatedUser = await updateUserProfile(req.user.id, validation.data);
    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: { user: updatedUser },
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

export const changePasswordController = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
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
    res.status(200).json({ success: true, message: result.message });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};
