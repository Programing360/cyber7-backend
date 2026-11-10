import { Router } from "express";
import {
  createAutomationRule,
  deleteAutomationRule,
  getAutomationRules,
  updateAutomationRule,
} from "../modules/controllers/automation.controller.js";

const router = Router({ mergeParams: true });

// Base path: /api/workspaces/:workspaceId/automations
router.route("/").get(getAutomationRules).post(createAutomationRule);

router
  .route("/:ruleId")
  .patch(updateAutomationRule)
  .delete(deleteAutomationRule);

const automationRoutes = router;

export default automationRoutes;
