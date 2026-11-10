import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IBusinessProfile {
  businessName: string;
  businessEmail: string;
  phoneNumber: string;
  website: string;
  industry: string;
  timezone: string;
  country: string;
  description: string;
}

export interface INotificationPreferences {
  emailNotifications: boolean;
  campaignUpdates: boolean;
  messageFailureAlerts: boolean;
  teamActivityAlerts: boolean;
  weeklyReports: boolean;
  productUpdates: boolean;
}

export interface ISecurityPreferences {
  twoFactorEnabled: boolean;
  loginAlerts: boolean;
  sessionTimeout: string;
}

export interface IApiPreferences {
  apiKey: string;
  webhookUrl: string;
  webhookSecret: string;
  webhookEvents: string[];
}

export interface IWorkspaceSettings extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  business: IBusinessProfile;
  notifications: INotificationPreferences;
  security: ISecurityPreferences;
  api: IApiPreferences;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const businessProfileSchema = new Schema<IBusinessProfile>(
  {
    businessName: { type: String, default: "My Business", trim: true },
    businessEmail: { type: String, default: "", trim: true, lowercase: true },
    phoneNumber: { type: String, default: "", trim: true },
    website: { type: String, default: "", trim: true },
    industry: { type: String, default: "Technology", trim: true },
    timezone: { type: String, default: "Asia/Dhaka", trim: true },
    country: { type: String, default: "Bangladesh", trim: true },
    description: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const notificationPreferencesSchema = new Schema<INotificationPreferences>(
  {
    emailNotifications: { type: Boolean, default: true },
    campaignUpdates: { type: Boolean, default: true },
    messageFailureAlerts: { type: Boolean, default: true },
    teamActivityAlerts: { type: Boolean, default: false },
    weeklyReports: { type: Boolean, default: true },
    productUpdates: { type: Boolean, default: false },
  },
  { _id: false },
);

const securityPreferencesSchema = new Schema<ISecurityPreferences>(
  {
    twoFactorEnabled: { type: Boolean, default: false },
    loginAlerts: { type: Boolean, default: true },
    sessionTimeout: { type: String, default: "30", trim: true },
  },
  { _id: false },
);

const apiPreferencesSchema = new Schema<IApiPreferences>(
  {
    apiKey: { type: String, default: "", trim: true },
    webhookUrl: { type: String, default: "", trim: true },
    webhookSecret: { type: String, default: "", trim: true },
    webhookEvents: {
      type: [String],
      default: [
        "message.delivered",
        "message.failed",
        "message.read",
        "message.received",
        "campaign.completed",
      ],
    },
  },
  { _id: false },
);

const workspaceSettingsSchema = new Schema<IWorkspaceSettings>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
    },
    business: {
      type: businessProfileSchema,
      default: () => ({}),
    },
    notifications: {
      type: notificationPreferencesSchema,
      default: () => ({}),
    },
    security: {
      type: securityPreferencesSchema,
      default: () => ({}),
    },
    api: {
      type: apiPreferencesSchema,
      default: () => ({}),
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

const WorkspaceSettings = mongoose.model<IWorkspaceSettings>(
  "WorkspaceSettings",
  workspaceSettingsSchema,
);

export default WorkspaceSettings;

