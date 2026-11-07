import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import {
  getSettingsProfileController,
  updateSettingsProfileController,
  changeSettingsPasswordController,
} from "./setting.controller.js";

const settingRouter = Router();

settingRouter.get("/profile", authenticate, getSettingsProfileController);
settingRouter.patch("/profile", authenticate, updateSettingsProfileController);
settingRouter.put("/profile", authenticate, updateSettingsProfileController);
settingRouter.post("/change-password", authenticate, changeSettingsPasswordController);

export default settingRouter;

