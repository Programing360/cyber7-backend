import { Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import { decrypt } from "../../utils/encryption.js";
import { whatsappConfig } from "../config/whatsapp.config.js";
import WhatsAppAccount from "./whatsapp.model.js";
import WhatsAppTemplate, {
  IWhatsAppTemplate,
  MetaTemplateCategory,
  MetaTemplateStatus,
  IWhatsAppTemplateComponent,
} from "./template.model.js";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{\d+\}\}/g);
  if (!matches) return [];
  return Array.from(new Set(matches)).sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ""), 10);
    const numB = parseInt(b.replace(/\D/g, ""), 10);
    return numA - numB;
  });
}

export interface ListTemplatesParams {
  workspaceId: string;
  search?: string;
  category?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface ListTemplatesResult {
  templates: IWhatsAppTemplate[];
  counts: {
    total: number;
    approved: number;
    pending: number;
    rejected: number;
    draft: number;
    paused: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export async function listWorkspaceTemplates({
  workspaceId,
  search,
  category,
  status,
  page = 1,
  limit = 50,
}: ListTemplatesParams): Promise<ListTemplatesResult> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const targetWorkspaceId = new Types.ObjectId(workspaceId);
  const filter: Record<string, unknown> = {
    workspaceId: targetWorkspaceId,
  };

  if (category && category !== "All") {
    filter.category = category.toUpperCase();
  }

  if (status && status !== "All") {
    filter.status = status.toUpperCase();
  } else {
    filter.status = { $ne: "DELETED" };
  }

  if (search && search.trim()) {
    const escaped = escapeRegex(search.trim());
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { body: { $regex: escaped, $options: "i" } },
    ];
  }

  const [
    totalFiltered,
    templates,
    totalAll,
    approvedCount,
    pendingCount,
    rejectedCount,
    draftCount,
    pausedCount,
  ] = await Promise.all([
    WhatsAppTemplate.countDocuments(filter),
    WhatsAppTemplate.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WhatsAppTemplate.countDocuments({
      workspaceId: targetWorkspaceId,
      status: { $ne: "DELETED" },
    }),
    WhatsAppTemplate.countDocuments({
      workspaceId: targetWorkspaceId,
      status: "APPROVED",
    }),
    WhatsAppTemplate.countDocuments({
      workspaceId: targetWorkspaceId,
      status: "PENDING",
    }),
    WhatsAppTemplate.countDocuments({
      workspaceId: targetWorkspaceId,
      status: "REJECTED",
    }),
    WhatsAppTemplate.countDocuments({
      workspaceId: targetWorkspaceId,
      status: "DRAFT",
    }),
    WhatsAppTemplate.countDocuments({
      workspaceId: targetWorkspaceId,
      status: "PAUSED",
    }),
  ]);

  const totalPages = Math.ceil(totalFiltered / limit) || 1;

  return {
    templates: templates as unknown as IWhatsAppTemplate[],
    counts: {
      total: totalAll,
      approved: approvedCount,
      pending: pendingCount,
      rejected: rejectedCount,
      draft: draftCount,
      paused: pausedCount,
    },
    pagination: {
      page,
      limit,
      total: totalFiltered,
      totalPages,
    },
  };
}

interface GetTemplateByIdParams {
  workspaceId: string;
  templateId: string;
}

export async function getWorkspaceTemplateById({
  workspaceId,
  templateId,
}: GetTemplateByIdParams): Promise<IWhatsAppTemplate> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const targetWorkspaceId = new Types.ObjectId(workspaceId);
  const query: Record<string, unknown> = {
    workspaceId: targetWorkspaceId,
  };

  if (Types.ObjectId.isValid(templateId)) {
    query._id = new Types.ObjectId(templateId);
  } else {
    query.metaTemplateId = templateId;
  }

  const template = await WhatsAppTemplate.findOne(query).lean();
  if (!template) {
    throw new AppError("Template not found", 404);
  }

  return template as unknown as IWhatsAppTemplate;
}

export interface MetaRawTemplate {
  id: string;
  name: string;
  category: MetaTemplateCategory;
  language: string;
  status: MetaTemplateStatus;
  components?: IWhatsAppTemplateComponent[];
  quality_score?: {
    score?: string;
  };
  rejected_reason?: string;
}

export async function fetchMetaTemplatesForWaba(
  businessAccountId: string,
  accessToken: string,
): Promise<MetaRawTemplate[]> {
  const allTemplates: MetaRawTemplate[] = [];
  let nextUrl: string | null =
    `${whatsappConfig.graphApiBaseUrl}/${businessAccountId}/message_templates?fields=id,name,status,category,language,components,quality_score,rejected_reason&limit=100`;

  while (nextUrl) {
    let response: globalThis.Response;
    try {
      response = await fetch(nextUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Network error";
      throw new AppError(`Failed to reach Meta Graph API: ${msg}`, 502);
    }

    const data = (await response.json().catch(() => null)) as {
      data?: MetaRawTemplate[];
      paging?: { next?: string };
      error?: {
        message?: string;
        code?: number;
        error_subcode?: number;
      };
    } | null;

    if (!response.ok) {
      const errorCode = data?.error?.code;

      if (errorCode === 190) {
        throw new AppError(
          "WhatsApp access token is invalid or expired. Please re-authenticate your WhatsApp account.",
          401,
        );
      }

      // Never expose raw Meta internal errors to the client
      throw new AppError(
        "Failed to fetch templates from Meta. Please check your WhatsApp Business account credentials and permissions.",
        502,
      );
    }

    if (data?.data && Array.isArray(data.data)) {
      allTemplates.push(...data.data);
    }

    nextUrl = data?.paging?.next || null;
  }

  return allTemplates;
}

export async function syncWorkspaceTemplates(
  workspaceId: string,
): Promise<{ syncedCount: number; templates: IWhatsAppTemplate[] }> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const targetWorkspaceId = new Types.ObjectId(workspaceId);

  // 1. Locate all CONNECTED accounts for this workspace
  const connectedAccounts = await WhatsAppAccount.find({
    workspaceId: targetWorkspaceId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (connectedAccounts.length === 0) {
    throw new AppError(
      "No connected WhatsApp Business account found in this workspace. Please connect an account first.",
      400,
    );
  }

  // Deduplicate by businessAccountId so we don't query the same WABA repeatedly
  const processedWabaIds = new Set<string>();
  const syncedTemplates: IWhatsAppTemplate[] = [];
  const errors: Array<{ message: string; statusCode: number }> = [];

  for (const account of connectedAccounts) {
    if (processedWabaIds.has(account.businessAccountId)) {
      continue;
    }
    processedWabaIds.add(account.businessAccountId);

    let accessToken: string;
    try {
      accessToken = decrypt(account.accessTokenEncrypted);
    } catch {
      errors.push({
        message: `Failed to decrypt WhatsApp access token for account ${account.businessName}`,
        statusCode: 500,
      });
      continue;
    }

    let metaTemplates: MetaRawTemplate[];
    try {
      metaTemplates = await fetchMetaTemplatesForWaba(
        account.businessAccountId,
        accessToken,
      );
    } catch (err: unknown) {
      if (err instanceof AppError) {
        errors.push({ message: err.message, statusCode: err.statusCode });
      } else {
        errors.push({
          message: `Failed to fetch templates from Meta for account ${account.businessName}`,
          statusCode: 502,
        });
      }
      continue;
    }

    const syncedMetaIds: string[] = [];

    for (const item of metaTemplates) {
      let header: { format?: string; text?: string } | undefined;
      let bodyText = "";
      let footerText = "";
      const buttons: Array<{
        type: string;
        text?: string;
        url?: string;
        phoneNumber?: string;
      }> = [];

      if (item.components && Array.isArray(item.components)) {
        for (const comp of item.components) {
          if (comp.type === "HEADER") {
            header = {
              format: comp.format,
              text: comp.text,
            };
          } else if (comp.type === "BODY") {
            bodyText = comp.text || "";
          } else if (comp.type === "FOOTER") {
            footerText = comp.text || "";
          } else if (comp.type === "BUTTONS" && Array.isArray(comp.buttons)) {
            for (const btn of comp.buttons) {
              const rawBtn = btn as Record<string, unknown>;
              buttons.push({
                type: (rawBtn.type as string) || "QUICK_REPLY",
                text: (rawBtn.text as string) || undefined,
                url: (rawBtn.url as string) || undefined,
                phoneNumber:
                  (rawBtn.phoneNumber as string) ||
                  (rawBtn.phone_number as string) ||
                  undefined,
              });
            }
          }
        }
      }

      const variables = extractVariables(bodyText);

      const updated = await WhatsAppTemplate.findOneAndUpdate(
        {
          workspaceId: targetWorkspaceId,
          metaTemplateId: item.id,
        },
        {
          $set: {
            whatsappAccountId: account._id,
            name: item.name,
            category: item.category,
            language: item.language,
            status: item.status,
            header,
            body: bodyText,
            footer: footerText,
            buttons,
            variables,
            components: item.components || [],
            qualityScore: item.quality_score?.score,
            rejectedReason: item.rejected_reason,
            syncedAt: new Date(),
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );

      syncedTemplates.push(updated);
      syncedMetaIds.push(item.id);
    }

    // Mark any templates for this account not returned in the current sync as DELETED
    await WhatsAppTemplate.updateMany(
      {
        workspaceId: targetWorkspaceId,
        whatsappAccountId: account._id,
        metaTemplateId: { $nin: syncedMetaIds },
      },
      {
        $set: { status: "DELETED", syncedAt: new Date() },
      },
    );
  }

  // If all accounts failed and no templates were synced, throw the error
  if (syncedTemplates.length === 0 && errors.length > 0) {
    const primaryError = errors[0];
    throw new AppError(primaryError.message, primaryError.statusCode);
  }

  return {
    syncedCount: syncedTemplates.length,
    templates: syncedTemplates,
  };
}
