import { Router } from "express";
import { getCurrentUserController, loginController, registerController } from "./auth.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const authRouter = Router();

authRouter.post("/register", registerController);
authRouter.post("/login", loginController);
authRouter.get("/me", authenticate, getCurrentUserController);

export default authRouter;
