import type { Request, Response, NextFunction } from "express";

import User from "../modules/auth/user.model.js";
import { verifyAccessToken } from "../utils/jwt.js";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    name: string;
    email: string;
    role: string;
    platformRole: "USER" | "FINANCE_ADMIN" | "SUPER_ADMIN" | string;
  };
}

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {

    // console.log('click');

    let token: string | undefined;
    const authorization = req.headers.authorization;
    console.log(authorization);
    if (authorization?.startsWith("Bearer ")) {
      token = authorization.slice("Bearer ".length).trim();
    } else if (typeof req.query?.token === "string" && req.query.token.trim()) {
      token = req.query.token.trim();
    } else if (req.cookies && (req.cookies.accessToken || req.cookies.token)) {
      token = (req.cookies.accessToken || req.cookies.token) as string;
    }

    if (!token) {
      res.status(401).json({
        success: false,
        message: "Authentication token is required",
      });

      return;
    }

    const payload = verifyAccessToken(token);
    console.log(payload);

    const user = await User.findById(payload.sub).select(
      "_id name email role platformRole isActive tokenInvalidBefore",
    );

    if (!user || !user.isActive) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication credentials",
      });

      return;
    }

    if (
      user.tokenInvalidBefore &&
      payload.iat &&
      payload.iat * 1000 < new Date(user.tokenInvalidBefore).getTime()
    ) {
      res.status(401).json({
        success: false,
        message: "Session has been invalidated. Please sign in again.",
      });

      return;
    }

    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      platformRole: (user as any).platformRole || "USER",
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
};
