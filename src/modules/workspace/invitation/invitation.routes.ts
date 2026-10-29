import { Router } from "express";

import { acceptInvitationController } from "./invitation.controller.js";
import { authenticate } from "../../../middlewares/authenticate.js";

const invitationRouter = Router();

invitationRouter.post(
  "/accept",
  authenticate,
  acceptInvitationController
);

export default invitationRouter;