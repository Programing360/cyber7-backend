import type { Request, Response } from "express";
import { Types } from "mongoose";
import AutomationRule from "../whatsapp/automation-rule.model.js";


// Get all automation rules for a workspace
export async function getAutomationRules(req: Request, res: Response) {
  try {
    const { workspaceId } = req.params;
    const rules = await AutomationRule.find({ workspaceId }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      data: rules,
    });
  } catch (error) {
    console.error("[Automation Controller] Get rules error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch automation rules",
    });
  }
}

// Create a new automation rule
export async function createAutomationRule(req: Request, res: Response) {
  try {
    const { workspaceId } = req.params;
    const {
      name,
      description,
      trigger,
      keywords,
      matchType,
      action,
      actionConfig,
      isActive,
    } = req.body;

    if (!name || !trigger || !action) {
      return res.status(400).json({
        success: false,
        message: "Name, trigger, and action are required fields.",
      });
    }

    const newRule = await AutomationRule.create({
      workspaceId: new Types.ObjectId(workspaceId as string),
      name,
      description,
      trigger,
      keywords: keywords || [],
      matchType: matchType || "CONTAINS",
      action,
      actionConfig: actionConfig || {},
      isActive: isActive !== undefined ? isActive : true,
    });

    return res.status(201).json({
      success: true,
      message: "Automation rule created successfully",
      data: newRule,
    });
  } catch (error) {
    console.error("[Automation Controller] Create rule error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create automation rule",
    });
  }
}

// Update an automation rule
export async function updateAutomationRule(req: Request, res: Response) {
  try {
    const { workspaceId, ruleId } = req.params;
    const updates = req.body;

    const updatedRule = await AutomationRule.findOneAndUpdate(
      { _id: ruleId, workspaceId },
      { $set: updates },
      { new: true, runValidators: true },
    );

    if (!updatedRule) {
      return res.status(404).json({
        success: false,
        message: "Automation rule not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Automation rule updated successfully",
      data: updatedRule,
    });
  } catch (error) {
    console.error("[Automation Controller] Update rule error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update automation rule",
    });
  }
}

// Delete an automation rule
export async function deleteAutomationRule(req: Request, res: Response) {
  try {
    const { workspaceId, ruleId } = req.params;

    const deletedRule = await AutomationRule.findOneAndDelete({
      _id: ruleId,
      workspaceId,
    });

    if (!deletedRule) {
      return res.status(404).json({
        success: false,
        message: "Automation rule not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Automation rule deleted successfully",
    });
  } catch (error) {
    console.error("[Automation Controller] Delete rule error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete automation rule",
    });
  }
}
