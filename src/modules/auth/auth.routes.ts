import { Router } from "express";
import { getCurrentUserController, loginController, registerController } from "./auth.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { loginRateLimiter, registerRateLimiter } from "../../middlewares/rate-limiter.js";

const authRouter = Router();

authRouter.post("/register", registerRateLimiter, registerController);
authRouter.post("/login", loginRateLimiter, loginController);
authRouter.get("/me", authenticate, getCurrentUserController);

export default authRouter;
