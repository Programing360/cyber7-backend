import mongoose, { Schema, Document, Types } from "mongoose";

export type AutomationTriggerType =
  | "NEW_CONTACT"
  | "INCOMING_MESSAGE"
  | "KEYWORD_MATCH"
  | "AWAY_HOURS"
  | "NO_REPLY";

export type AutomationActionType =
  | "SEND_MESSAGE"
  | "SEND_TEMPLATE"
  | "ASSIGN_AGENT"
  | "ADD_TAGS"
  | "CREATE_TICKET";

export interface IAutomationRule extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  trigger: AutomationTriggerType;
  keywords?: string[];
  matchType?: "EXACT" | "CONTAINS" | "STARTS_WITH";
  action: AutomationActionType;
  actionConfig: {
    messageBody?: string;
    templateName?: string;
    templateLanguage?: string;
    assignedUserId?: Types.ObjectId;
    tags?: string[];
    ticketPriority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  };
  isActive: boolean;
  executionsCount: number;
  lastExecutedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const automationRuleSchema = new Schema<IAutomationRule>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    trigger: {
      type: String,
      enum: ["NEW_CONTACT", "INCOMING_MESSAGE", "KEYWORD_MATCH", "AWAY_HOURS", "NO_REPLY"],
      required: true,
      index: true,
    },
    keywords: [{ type: String, lowercase: true, trim: true }],
    matchType: { type: String, enum: ["EXACT", "CONTAINS", "STARTS_WITH"], default: "CONTAINS" },
    action: {
      type: String,
      enum: ["SEND_MESSAGE", "SEND_TEMPLATE", "ASSIGN_AGENT", "ADD_TAGS", "CREATE_TICKET"],
      required: true,
    },
    actionConfig: {
      messageBody: { type: String },
      templateName: { type: String },
      templateLanguage: { type: String, default: "en" },
      assignedUserId: { type: Schema.Types.ObjectId, ref: "User" },
      tags: [{ type: String, trim: true }],
      ticketPriority: { type: String, enum: ["LOW", "MEDIUM", "HIGH", "URGENT"], default: "MEDIUM" },
    },
    isActive: { type: Boolean, default: true, index: true },
    executionsCount: { type: Number, default: 0 },
    lastExecutedAt: { type: Date },
  },
  { timestamps: true }
);

automationRuleSchema.index({ workspaceId: 1, isActive: 1, trigger: 1 });

export const AutomationRule = mongoose.model<IAutomationRule>("AutomationRule", automationRuleSchema);
export default AutomationRule;