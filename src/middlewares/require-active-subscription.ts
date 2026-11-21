import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./authenticate.js";
import User from "../modules/auth/user.model.js";

export const requireActiveSubscription = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const fullPath = `${req.baseUrl || ""}${req.path || ""}`.toLowerCase();

        // 1. অ্যাডমিন রাউট, বিলিং, পেমেন্ট এবং ইউজার প্রোফাইল সবসময় খোলা থাকবে
        if (
            fullPath.includes("/admin") ||
            fullPath.includes("/platform-admin") ||
            fullPath.includes("/billing") ||
            fullPath.includes("/auth/me") ||
            (req.method === "GET" && fullPath === "/api/workspaces")
        ) {
            next();
            return;
        }

        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json({
                success: false,
                message: "Authentication required",
            });
            return;
        }

        const user = await User.findById(userId);
        if (!user || !user.isActive) {
            res.status(401).json({
                success: false,
                message: "User not found or inactive",
            });
            return;
        }

        // 2. অ্যাডমিন ইউজার হলে ফ্রি-ট্রায়াল চেক প্রযোজ্য নয়
        const isPlatformAdmin =
            user.platformRole === "SUPER_ADMIN" ||
            user.platformRole === "FINANCE_ADMIN" ||
            user.role === "ADMIN"


        if (isPlatformAdmin || user.isPaid || user.subscriptionStatus === "active") {
            next();
            return;
        }

        const now = new Date();
        const trialExpired = Boolean(
            user.trialEndDate && now > new Date(user.trialEndDate),
        );

        if (trialExpired || user.subscriptionStatus === "expired") {
            if (user.subscriptionStatus !== "expired") {
                user.subscriptionStatus = "expired";
                await user.save();
            }

            res.status(403).json({
                success: false,
                message:
                    "Your 7-day free trial has expired. Please subscribe to a plan to continue using VexChat.",
                code: "SUBSCRIPTION_EXPIRED",
                trialExpired: true,
            });
            return;
        }

        next();
    } catch (error) {
        next(error);
    }
};