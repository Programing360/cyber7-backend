import type { NextFunction, Response } from "express";
import { loadAdminSessionEnv } from "../config/env.js";
import { adminSessionService } from "../modules/admin-auth/admin-session.service.js";
import { parseCookieHeader } from "../modules/admin-auth/admin-cookie.util.js";
import type {
  AdminAuthenticatedRequest,
  AdminRole,
} from "./authenticate-admin-session.js";

/**
 * Middleware: Redirect/Reject if the user already holds an active Admin Session.
 */
export async function redirectIfAdminAuthenticated(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const config = loadAdminSessionEnv();
    const cookieName = config.ADMIN_SESSION_COOKIE_NAME;
    const cookieMap =
      (req as any).cookies || parseCookieHeader(req.headers?.cookie);
    const cookieToken = cookieMap?.[cookieName]?.trim();

    // কোনো কুকি না থাকলে সরাসরি সাধারণ লগইন ফ্লোতে চলে যাবে
    if (!cookieToken) {
      return next();
    }

    // কুকি থাকলে যাচাই করে দেখা হচ্ছে সেশনটি এখনও বৈধ কি না
    const authResult =
      await adminSessionService.authenticateAdminSession(cookieToken);

    if (authResult.success && authResult.user) {
      const role = authResult.user.platformRole as AdminRole;

      // যদি সে SUPER_ADMIN বা FINANCE_ADMIN হয়
      if (role === "SUPER_ADMIN" || role === "FINANCE_ADMIN") {
        res.status(200).json({
          success: true,
          code: "ALREADY_AUTHENTICATED",
          message: "You are already authenticated as platform administrator.",
          data: {
            redirectTo: "/admin",
            user: {
              id: String(authResult.user._id),
              email: authResult.user.email,
              name: authResult.user.name,
              platformRole: role,
            },
          },
        });
        return;
      }
    }

    // সেশন ইনভ্যালিড বা মেয়াদোত্তীর্ণ হলে লগইন প্রসেস চালু থাকবে
    next();
  } catch {
    // এরর হলেও মূল লগইন ফ্লো ব্লক না করে পাস করবে
    next();
  }
}
