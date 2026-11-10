import { Types, type QueryFilter } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";
import WhatsAppTemplate from "../whatsapp/template.model.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import Campaign, {
  type CampaignStatus,
  type ICampaign,
} from "./campaign.model.js";
import CampaignRecipient, {
  type CampaignRecipientStatus,
  type ICampaignRecipient,
} from "./campaign-recipient.model.js";
import {
  resolveCampaignAudience,
  type CampaignAudienceSummary,
} from "./campaign-audience.service.js";
import { makeWorkspaceWhatsAppRequest } from "../services/whatsapp-api.service.js";
import type {
  CampaignListQuery,
  CampaignRecipientListQuery,
  CreateCampaignInput,
  ScheduleCampaignInput,
  UpdateDraftCampaignInput,
} from "./campaign.validation.js";

const CANCELLABLE_STATUSES: CampaignStatus[] = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "PAUSED",
];

const PAUSABLE_STATUSES: CampaignStatus[] = ["SCHEDULED", "PROCESSING"];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireObjectId(value: string, message: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw new AppError(message, 400);
  }

  return new Types.ObjectId(value);
}

function toIsoString(value?: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function sanitizeProviderError(message?: string): string | null {
  if (!message) {
    return null;
  }

  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(access_token|token)=[^&\s]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

export function serializeCampaign(campaign: ICampaign) {
  return {
    id: campaign._id.toString(),
    workspaceId: campaign.workspaceId.toString(),
    name: campaign.name,
    description: campaign.description ?? "",
    whatsappAccountId: campaign.whatsappAccountId.toString(),
    templateId: campaign.templateId.toString(),
    audience: {
      mode: campaign.audience.mode,
      contactIds: campaign.audience.contactIds.map((contactId) =>
        contactId.toString(),
      ),
    },
    status: campaign.status,
    scheduledAt: toIsoString(campaign.scheduledAt),
    startedAt: toIsoString(campaign.startedAt),
    completedAt: toIsoString(campaign.completedAt),
    createdBy: campaign.createdBy.toString(),
    totalRecipients: campaign.totalRecipients,
    sentCount: campaign.sentCount,
    deliveredCount: campaign.deliveredCount,
    readCount: campaign.readCount,
    failedCount: campaign.failedCount,
    createdAt: toIsoString(campaign.createdAt),
    updatedAt: toIsoString(campaign.updatedAt),
  };
}

function serializeCampaignRecipient(recipient: ICampaignRecipient) {
  return {
    id: recipient._id.toString(),
    campaignId: recipient.campaignId.toString(),
    contactId: recipient.contactId.toString(),
    phoneNumber: recipient.phoneNumber,
    status: recipient.status,
    providerMessageId: recipient.providerMessageId ?? null,
    errorCode: recipient.errorCode ?? null,
    errorMessage: sanitizeProviderError(recipient.errorMessage),
    sentAt: toIsoString(recipient.sentAt),
    deliveredAt: toIsoString(recipient.deliveredAt),
    readAt: toIsoString(recipient.readAt),
    failedAt: toIsoString(recipient.failedAt),
    createdAt: toIsoString(recipient.createdAt),
    updatedAt: toIsoString(recipient.updatedAt),
  };
}

interface ReferenceValidationOptions {
  requireConnected?: boolean;
  requireApproved?: boolean;
}

async function validateCampaignReferences(
  workspaceId: Types.ObjectId,
  whatsappAccountId: string,
  templateId: string,
  options: ReferenceValidationOptions = {},
) {
  const accountObjectId = requireObjectId(
    whatsappAccountId,
    "Invalid WhatsApp account ID",
  );
  const templateObjectId = requireObjectId(templateId, "Invalid template ID");

  const [account, template] = await Promise.all([
    WhatsAppAccount.findOne({
      _id: accountObjectId,
      workspaceId,
    }),
    WhatsAppTemplate.findOne({
      _id: templateObjectId,
      workspaceId,
    }),
  ]);

  if (!account) {
    throw new AppError("WhatsApp account not found in this workspace", 404);
  }

  if (!template) {
    throw new AppError("Template not found in this workspace", 404);
  }

  if (template.whatsappAccountId.toString() !== account._id.toString()) {
    throw new AppError(
      "Template does not belong to the selected WhatsApp account",
      400,
    );
  }

  if (options.requireConnected && account.status !== "CONNECTED") {
    throw new AppError(
      "WhatsApp account is not connected. Reconnect the account before scheduling.",
      400,
    );
  }

  if (options.requireApproved && template.status !== "APPROVED") {
    throw new AppError(
      "WhatsApp template is not approved and cannot be scheduled",
      400,
    );
  }

  return { account, template };
}

function buildRecipientDocuments(
  workspaceId: Types.ObjectId,
  campaignId: Types.ObjectId,
  recipients: Array<{
    contactId: Types.ObjectId;
    phoneNumber: string;
  }>,
) {
  return recipients.map((recipient) => ({
    workspaceId,
    campaignId,
    contactId: recipient.contactId,
    phoneNumber: recipient.phoneNumber,
    status: "PENDING" as CampaignRecipientStatus,
  }));
}

async function replaceCampaignRecipients(
  workspaceId: Types.ObjectId,
  campaignId: Types.ObjectId,
  recipients: Array<{
    contactId: Types.ObjectId;
    phoneNumber: string;
  }>,
) {
  await CampaignRecipient.deleteMany({ workspaceId, campaignId });

  if (recipients.length === 0) {
    return;
  }

  await CampaignRecipient.insertMany(
    buildRecipientDocuments(workspaceId, campaignId, recipients),
  );
}

async function findCampaignOrThrow(
  workspaceId: Types.ObjectId,
  campaignId: Types.ObjectId,
): Promise<ICampaign> {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    workspaceId,
  });

  if (!campaign) {
    throw new AppError("Campaign not found", 404);
  }

  return campaign;
}

interface CreateCampaignParams {
  workspaceId: string;
  createdBy: string;
  input: CreateCampaignInput;
}

export async function createCampaign({
  workspaceId,
  createdBy,
  input,
}: CreateCampaignParams): Promise<{
  campaign: ReturnType<typeof serializeCampaign>;
  audienceSummary: CampaignAudienceSummary;
}> {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const creatorObjectId = requireObjectId(createdBy, "Invalid creator ID");

  await validateCampaignReferences(
    workspaceObjectId,
    input.whatsappAccountId,
    input.templateId,
  );

  const resolution = await resolveCampaignAudience({
    workspaceId,
    mode: input.audience.mode,
    contactIds: input.audience.contactIds ?? [],
  });

  const campaign = await Campaign.create({
    workspaceId: workspaceObjectId,
    name: input.name,
    description: input.description ?? "",
    whatsappAccountId: new Types.ObjectId(input.whatsappAccountId),
    templateId: new Types.ObjectId(input.templateId),
    audience: {
      mode: input.audience.mode,
      contactIds:
        input.audience.mode === "ALL_CONTACTS"
          ? []
          : resolution.audience.contactIds,
    },
    status: "DRAFT",
    createdBy: creatorObjectId,
    totalRecipients: resolution.recipients.length,
  });

  try {
    await replaceCampaignRecipients(
      workspaceObjectId,
      campaign._id,
      resolution.recipients,
    );
  } catch (error) {
    await CampaignRecipient.deleteMany({
      workspaceId: workspaceObjectId,
      campaignId: campaign._id,
    });
    await Campaign.deleteOne({
      _id: campaign._id,
      workspaceId: workspaceObjectId,
    });
    throw error;
  }

  return {
    campaign: serializeCampaign(campaign),
    audienceSummary: resolution.summary,
  };
}

interface GetCampaignsParams {
  workspaceId: string;
  query: CampaignListQuery;
}

export async function getCampaigns({ workspaceId, query }: GetCampaignsParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );

  const filter: QueryFilter<ICampaign> = {
    workspaceId: workspaceObjectId,
  };

  if (query.status) {
    filter.status = query.status;
  }

  if (query.search) {
    const escaped = escapeRegex(query.search);
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
    ];
  }

  const total = await Campaign.countDocuments(filter);
  const totalPages = Math.ceil(total / query.limit) || 1;

  const campaigns = await Campaign.find(filter)
    .sort({ createdAt: -1 })
    .skip((query.page - 1) * query.limit)
    .limit(query.limit);

  return {
    campaigns: campaigns.map(serializeCampaign),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
  };
}

interface CampaignIdParams {
  workspaceId: string;
  campaignId: string;
}

export async function getCampaignById({
  workspaceId,
  campaignId,
}: CampaignIdParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const campaign = await findCampaignOrThrow(
    workspaceObjectId,
    campaignObjectId,
  );

  return serializeCampaign(campaign);
}

interface UpdateDraftCampaignParams extends CampaignIdParams {
  input: UpdateDraftCampaignInput;
}

export async function updateDraftCampaign({
  workspaceId,
  campaignId,
  input,
}: UpdateDraftCampaignParams): Promise<{
  campaign: ReturnType<typeof serializeCampaign>;
  audienceSummary: CampaignAudienceSummary | null;
}> {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const existing = await findCampaignOrThrow(
    workspaceObjectId,
    campaignObjectId,
  );

  if (existing.status !== "DRAFT") {
    throw new AppError("Only draft campaigns can be edited", 409);
  }

  const accountId =
    input.whatsappAccountId ?? existing.whatsappAccountId.toString();
  const templateId = input.templateId ?? existing.templateId.toString();

  if (input.whatsappAccountId !== undefined || input.templateId !== undefined) {
    await validateCampaignReferences(workspaceObjectId, accountId, templateId);
  }

  const resolution = input.audience
    ? await resolveCampaignAudience({
        workspaceId,
        mode: input.audience.mode,
        contactIds: input.audience.contactIds ?? [],
      })
    : null;

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) {
    updates.description = input.description;
  }
  if (input.whatsappAccountId !== undefined) {
    updates.whatsappAccountId = new Types.ObjectId(input.whatsappAccountId);
  }
  if (input.templateId !== undefined) {
    updates.templateId = new Types.ObjectId(input.templateId);
  }
  if (resolution) {
    updates.audience = {
      mode: resolution.audience.mode,
      contactIds:
        resolution.audience.mode === "ALL_CONTACTS"
          ? []
          : resolution.audience.contactIds,
    };
    updates.totalRecipients = resolution.recipients.length;
  }

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
      status: "DRAFT",
    },
    { $set: updates },
    { returnDocument: "after", runValidators: true },
  );

  if (!campaign) {
    const stillExists = await Campaign.findOne({
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
    });

    if (!stillExists) {
      throw new AppError("Campaign not found", 404);
    }

    throw new AppError("Only draft campaigns can be edited", 409);
  }

  if (resolution) {
    await replaceCampaignRecipients(
      workspaceObjectId,
      campaignObjectId,
      resolution.recipients,
    );
  }

  return {
    campaign: serializeCampaign(campaign),
    audienceSummary: resolution?.summary ?? null,
  };
}

export async function deleteDraftCampaign({
  workspaceId,
  campaignId,
}: CampaignIdParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const existing = await findCampaignOrThrow(
    workspaceObjectId,
    campaignObjectId,
  );

  if (existing.status !== "DRAFT") {
    throw new AppError("Only draft campaigns can be deleted", 409);
  }

  const deleted = await Campaign.findOneAndDelete({
    _id: campaignObjectId,
    workspaceId: workspaceObjectId,
    status: "DRAFT",
  });

  if (!deleted) {
    throw new AppError("Only draft campaigns can be deleted", 409);
  }

  await CampaignRecipient.deleteMany({
    workspaceId: workspaceObjectId,
    campaignId: campaignObjectId,
  });

  return { id: campaignObjectId.toString() };
}

interface ScheduleCampaignParams extends CampaignIdParams {
  input: ScheduleCampaignInput;
}

export async function scheduleCampaign({
  workspaceId,
  campaignId,
  input,
}: ScheduleCampaignParams): Promise<{
  campaign: ReturnType<typeof serializeCampaign>;
  audienceSummary: CampaignAudienceSummary;
}> {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const existing = await findCampaignOrThrow(
    workspaceObjectId,
    campaignObjectId,
  );

  if (existing.status !== "DRAFT") {
    throw new AppError("Only draft campaigns can be scheduled", 409);
  }

  const scheduledAt = new Date(input.scheduledAt);

  if (
    Number.isNaN(scheduledAt.getTime()) ||
    scheduledAt.getTime() <= Date.now()
  ) {
    throw new AppError("scheduledAt must be a future date", 400);
  }

  await validateCampaignReferences(
    workspaceObjectId,
    existing.whatsappAccountId.toString(),
    existing.templateId.toString(),
    { requireConnected: true, requireApproved: true },
  );

  const resolution = await resolveCampaignAudience({
    workspaceId,
    mode: existing.audience.mode,
    contactIds: existing.audience.contactIds.map((contactId) =>
      contactId.toString(),
    ),
  });

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
      status: "DRAFT",
    },
    {
      $set: {
        status: "SCHEDULED",
        scheduledAt,
        totalRecipients: resolution.recipients.length,
      },
    },
    { returnDocument: "after", runValidators: true },
  );

  if (!campaign) {
    throw new AppError("Only draft campaigns can be scheduled", 409);
  }

  await replaceCampaignRecipients(
    workspaceObjectId,
    campaignObjectId,
    resolution.recipients,
  );

  return {
    campaign: serializeCampaign(campaign),
    audienceSummary: resolution.summary,
  };
}

export async function cancelCampaign({
  workspaceId,
  campaignId,
}: CampaignIdParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
      status: { $in: CANCELLABLE_STATUSES },
    },
    { $set: { status: "CANCELLED" } },
    { returnDocument: "after", runValidators: true },
  );

  if (!campaign) {
    const existing = await Campaign.findOne({
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
    });

    if (!existing) {
      throw new AppError("Campaign not found", 404);
    }

    throw new AppError(
      `Campaign cannot be cancelled from status ${existing.status}`,
      409,
    );
  }

  return serializeCampaign(campaign);
}

export async function pauseCampaign({
  workspaceId,
  campaignId,
}: CampaignIdParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
      status: { $in: PAUSABLE_STATUSES },
    },
    { $set: { status: "PAUSED" } },
    { returnDocument: "after", runValidators: true },
  );

  if (!campaign) {
    const existing = await Campaign.findOne({
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
    });

    if (!existing) {
      throw new AppError("Campaign not found", 404);
    }

    throw new AppError(
      `Campaign cannot be paused from status ${existing.status}`,
      409,
    );
  }

  return serializeCampaign(campaign);
}

export async function resumeCampaign({
  workspaceId,
  campaignId,
}: CampaignIdParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  const existing = await findCampaignOrThrow(
    workspaceObjectId,
    campaignObjectId,
  );

  if (existing.status !== "PAUSED") {
    throw new AppError("Only paused campaigns can be resumed", 409);
  }

  await validateCampaignReferences(
    workspaceObjectId,
    existing.whatsappAccountId.toString(),
    existing.templateId.toString(),
    { requireConnected: true, requireApproved: true },
  );

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignObjectId,
      workspaceId: workspaceObjectId,
      status: "PAUSED",
    },
    { $set: { status: "SCHEDULED" } },
    { returnDocument: "after", runValidators: true },
  );

  if (!campaign) {
    throw new AppError("Only paused campaigns can be resumed", 409);
  }

  return serializeCampaign(campaign);
}

interface GetCampaignRecipientsParams extends CampaignIdParams {
  query: CampaignRecipientListQuery;
}

export async function getCampaignRecipients({
  workspaceId,
  campaignId,
  query,
}: GetCampaignRecipientsParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );

  await findCampaignOrThrow(workspaceObjectId, campaignObjectId);

  const filter: QueryFilter<ICampaignRecipient> = {
    workspaceId: workspaceObjectId,
    campaignId: campaignObjectId,
  };

  if (query.status) {
    filter.status = query.status;
  }

  const [total, recipients, statusCounts] = await Promise.all([
    CampaignRecipient.countDocuments(filter),
    CampaignRecipient.find(filter)
      .sort({ createdAt: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    CampaignRecipient.aggregate<{
      _id: CampaignRecipientStatus;
      count: number;
    }>([
      {
        $match: {
          workspaceId: workspaceObjectId,
          campaignId: campaignObjectId,
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const summary: Record<string, number> = {
    total: 0,
    pending: 0,
    processing: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
  };

  for (const entry of statusCounts) {
    summary[entry._id.toLowerCase()] = entry.count;
    summary.total += entry.count;
  }

  return {
    recipients: recipients.map(serializeCampaignRecipient),
    summary,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

export interface DispatchCampaignRecipientParams {
  workspaceId: string;
  campaignId: string;
  recipientId: string;
}

/**
 * Production-ready dispatcher for individual campaign recipients.
 * Atomically claims recipient, checks opt-out status, resolves Meta account & template,
 * executes real Meta Cloud API request, and updates campaign statistics.
 */
export async function dispatchCampaignRecipient({
  workspaceId,
  campaignId,
  recipientId,
}: DispatchCampaignRecipientParams) {
  const workspaceObjectId = requireObjectId(
    workspaceId,
    "A valid workspace ID is required",
  );
  const campaignObjectId = requireObjectId(
    campaignId,
    "A valid campaign ID is required",
  );
  const recipientObjectId = requireObjectId(
    recipientId,
    "A valid recipient ID is required",
  );

  // Atomically claim recipient to prevent double processing in worker threads
  const recipient = await CampaignRecipient.findOneAndUpdate(
    {
      _id: recipientObjectId,
      workspaceId: workspaceObjectId,
      campaignId: campaignObjectId,
      status: { $in: ["PENDING", "FAILED"] },
    },
    { $set: { status: "PROCESSING" } },
    { returnDocument: "after" },
  );

  if (!recipient) {
    return { success: false, skipped: true, reason: "ALREADY_PROCESSED" };
  }

  // Re-check recipient contact opt-out status
  const contact = await WhatsAppContact.findOne({
    _id: recipient.contactId,
    workspaceId: workspaceObjectId,
  });

  if (!contact || contact.isOptedOut) {
    recipient.status = "FAILED";
    recipient.errorCode = "CONTACT_OPTED_OUT";
    recipient.errorMessage =
      "Cannot send message: Contact has opted out of WhatsApp communications";
    recipient.failedAt = new Date();
    await recipient.save();

    await Campaign.findByIdAndUpdate(campaignObjectId, {
      $inc: { failedCount: 1 },
    });

    return {
      success: false,
      skipped: true,
      reason: "CONTACT_OPTED_OUT",
      recipient: serializeCampaignRecipient(recipient),
    };
  }

  // Fetch Campaign details
  const campaign = await findCampaignOrThrow(
    workspaceObjectId,
    campaignObjectId,
  );

  // Fetch Connected WhatsApp Account
  const account = await WhatsAppAccount.findOne({
    _id: campaign.whatsappAccountId,
    workspaceId: workspaceObjectId,
    status: "CONNECTED",
  });

  if (!account) {
    recipient.status = "FAILED";
    recipient.errorCode = "ACCOUNT_NOT_CONNECTED";
    recipient.errorMessage = "WhatsApp account is not connected";
    recipient.failedAt = new Date();
    await recipient.save();
    await Campaign.findByIdAndUpdate(campaignObjectId, {
      $inc: { failedCount: 1 },
    });
    throw new AppError("WhatsApp account is not connected", 400);
  }

  // Fetch Approved Template
  const template = await WhatsAppTemplate.findOne({
    _id: campaign.templateId,
    workspaceId: workspaceObjectId,
    status: "APPROVED",
  });

  if (!template) {
    recipient.status = "FAILED";
    recipient.errorCode = "TEMPLATE_NOT_APPROVED";
    recipient.errorMessage = "WhatsApp template is not approved";
    recipient.failedAt = new Date();
    await recipient.save();
    await Campaign.findByIdAndUpdate(campaignObjectId, {
      $inc: { failedCount: 1 },
    });
    throw new AppError("Template is not approved", 422);
  }

  const recipientPhone = (recipient.phoneNumber || contact.waId || "").replace(
    /\D/g,
    "",
  );

  if (recipientPhone.length < 5) {
    recipient.status = "FAILED";
    recipient.errorCode = "INVALID_PHONE";
    recipient.errorMessage = "Invalid recipient phone number";
    recipient.failedAt = new Date();
    await recipient.save();
    await Campaign.findByIdAndUpdate(campaignObjectId, {
      $inc: { failedCount: 1 },
    });
    throw new AppError("Invalid recipient phone number", 400);
  }

  // Execute Real Meta Cloud API Request
  try {
    const response = await makeWorkspaceWhatsAppRequest(
      workspaceId,
      account.phoneNumberId,
      "messages",
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: (campaign as any).templateComponents || [],
        },
      },
    );

    const providerMessageId = (
      response.messages as Array<{ id?: string }> | undefined
    )?.[0]?.id;

    if (!providerMessageId) {
      throw new Error("Meta API did not return a message ID");
    }

    recipient.status = "SENT";
    recipient.providerMessageId = providerMessageId;
    recipient.sentAt = new Date();
    recipient.errorCode = undefined;
    recipient.errorMessage = undefined;
    await recipient.save();

    await Campaign.findByIdAndUpdate(campaignObjectId, {
      $inc: { sentCount: 1 },
    });

    return {
      success: true,
      providerMessageId,
      recipient: serializeCampaignRecipient(recipient),
    };
  } catch (error: any) {
    recipient.status = "FAILED";
    recipient.errorCode = error.code || "META_API_ERROR";
    recipient.errorMessage = sanitizeProviderError(error.message) ?? undefined;
    recipient.failedAt = new Date();
    await recipient.save();

    await Campaign.findByIdAndUpdate(campaignObjectId, {
      $inc: { failedCount: 1 },
    });

    throw error;
  }
}

export interface UpdateCampaignRecipientStatusWebhookParams {
  providerMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  timestamp: string | number | Date;
  errorCode?: string;
  errorMessage?: string;
}

const RECIPIENT_STATUS_PRECEDENCE: Record<CampaignRecipientStatus, number> = {
  PENDING: 1,
  PROCESSING: 2,
  SENT: 3,
  DELIVERED: 4,
  READ: 5,
  FAILED: 6,
};

/**
 * Synchronize Meta Webhook status updates with CampaignRecipient and Campaign metrics.
 * Supports idempotency, status rank precedence, delivery backfilling, and failure capturing.
 */
export async function updateCampaignRecipientStatusFromWebhook({
  providerMessageId,
  status,
  timestamp,
  errorCode,
  errorMessage,
}: UpdateCampaignRecipientStatusWebhookParams): Promise<{
  updated: boolean;
  recipient?: ICampaignRecipient | null;
  reason?: string;
}> {
  if (!providerMessageId) {
    return { updated: false, reason: "MISSING_PROVIDER_MESSAGE_ID" };
  }

  const incomingDate =
    timestamp instanceof Date
      ? timestamp
      : typeof timestamp === "number"
        ? new Date(timestamp * 1000)
        : /^\d+$/.test(String(timestamp))
          ? new Date(Number(timestamp) * 1000)
          : new Date(timestamp);

  const recipient = await CampaignRecipient.findOne({
    providerMessageId,
  });

  if (!recipient) {
    return { updated: false, reason: "RECIPIENT_NOT_FOUND" };
  }

  // Idempotency: Ignore duplicate same-status webhooks to prevent duplicate count increments
  if (recipient.status === status) {
    return { updated: false, recipient, reason: "DUPLICATE_STATUS" };
  }

  // Terminal state protection: FAILED cannot be overwritten by non-failed statuses
  if (recipient.status === "FAILED" && status !== "FAILED") {
    return { updated: false, recipient, reason: "TERMINAL_STATE" };
  }

  // Precedence protection: Do not allow a lower status rank to overwrite higher status rank
  const currentRank = RECIPIENT_STATUS_PRECEDENCE[recipient.status] ?? 0;
  const newRank = RECIPIENT_STATUS_PRECEDENCE[status] ?? 0;
  if (status !== "FAILED" && newRank < currentRank) {
    return { updated: false, recipient, reason: "LOWER_RANK" };
  }

  const campaignUpdates: Record<string, number> = {};

  if (status === "DELIVERED") {
    recipient.status = "DELIVERED";
    recipient.deliveredAt = recipient.deliveredAt || incomingDate;
    campaignUpdates.deliveredCount = 1;
  } else if (status === "READ") {
    recipient.status = "READ";
    recipient.readAt = recipient.readAt || incomingDate;
    campaignUpdates.readCount = 1;

    // If marked read without a prior delivered event, backfill delivery
    if (!recipient.deliveredAt) {
      recipient.deliveredAt = incomingDate;
      campaignUpdates.deliveredCount = 1;
    }
  } else if (status === "FAILED") {
    recipient.status = "FAILED";
    recipient.failedAt = incomingDate;
    recipient.errorCode = errorCode || "DELIVERY_FAILED";
    recipient.errorMessage = sanitizeProviderError(errorMessage) ?? undefined;
    campaignUpdates.failedCount = 1;
  }

  await recipient.save();

  if (Object.keys(campaignUpdates).length > 0) {
    await Campaign.findByIdAndUpdate(recipient.campaignId, {
      $inc: campaignUpdates,
    });
  }

  return { updated: true, recipient };
}

