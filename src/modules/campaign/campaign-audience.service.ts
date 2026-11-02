import { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import WhatsAppContact from "../whatsapp/contact.model.js";
import type { CampaignAudienceMode } from "./campaign.model.js";

interface ContactRow {
  _id: Types.ObjectId;
  phoneNumber: string;
  waId: string;
  isOptedOut?: boolean;
}

export interface ResolvedCampaignRecipient {
  contactId: Types.ObjectId;
  phoneNumber: string;
  waId: string;
}

export interface CampaignAudienceSummary {
  requested: number;
  eligible: number;
  excluded: number;
  duplicates: number;
}

export interface CampaignAudienceResolution {
  audience: {
    mode: CampaignAudienceMode;
    contactIds: Types.ObjectId[];
  };
  recipients: ResolvedCampaignRecipient[];
  summary: CampaignAudienceSummary;
}

interface ResolveCampaignAudienceParams {
  workspaceId: string;
  mode: CampaignAudienceMode;
  contactIds?: string[];
}

export function normalizePhoneNumber(phoneNumber: string): string | null {
  const waId = phoneNumber.replace(/\D/g, "");
  return waId.length >= 5 ? waId : null;
}

function buildRecipients(contacts: ContactRow[]): {
  recipients: ResolvedCampaignRecipient[];
  excluded: number;
  duplicates: number;
} {
  const recipients: ResolvedCampaignRecipient[] = [];
  const seenContactIds = new Set<string>();
  const seenWaIds = new Set<string>();

  let excluded = 0;
  let duplicates = 0;

  for (const contact of contacts) {
    const contactId = contact._id.toString();

    if (seenContactIds.has(contactId)) {
      duplicates += 1;
      continue;
    }

    seenContactIds.add(contactId);

    const waId = normalizePhoneNumber(contact.phoneNumber);

    if (!waId) {
      excluded += 1;
      continue;
    }

    if (seenWaIds.has(waId)) {
      duplicates += 1;
      continue;
    }

    seenWaIds.add(waId);

    recipients.push({
      contactId: contact._id,
      phoneNumber: contact.phoneNumber.trim(),
      waId,
    });
  }

  return { recipients, excluded, duplicates };
}

export async function resolveCampaignAudience({
  workspaceId,
  mode,
  contactIds = [],
}: ResolveCampaignAudienceParams): Promise<CampaignAudienceResolution> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const workspaceObjectId = new Types.ObjectId(workspaceId);

  if (mode === "ALL_CONTACTS") {
    const contacts = await WhatsAppContact.find({
      workspaceId: workspaceObjectId,
    })
      .select("_id phoneNumber waId isOptedOut")
      .lean<ContactRow[]>();

    const nonOptedOutContacts = contacts.filter((c) => !c.isOptedOut);
    const optedOutCount = contacts.length - nonOptedOutContacts.length;

    const { recipients, excluded, duplicates } = buildRecipients(nonOptedOutContacts);

    return {
      audience: {
        mode,
        contactIds: recipients.map((recipient) => recipient.contactId),
      },
      recipients,
      summary: {
        requested: contacts.length,
        eligible: recipients.length,
        excluded: excluded + optedOutCount,
        duplicates,
      },
    };
  }

  if (contactIds.length === 0) {
    throw new AppError("At least one contact must be selected", 400);
  }

  const uniqueRequestedIds = [
    ...new Set(contactIds.map((contactId) => contactId.toString())),
  ];
  const duplicatedRequestIds = contactIds.length - uniqueRequestedIds.length;

  const contacts = await WhatsAppContact.find({
    workspaceId: workspaceObjectId,
    _id: { $in: uniqueRequestedIds.map((id) => new Types.ObjectId(id)) },
  })
    .select("_id phoneNumber waId isOptedOut")
    .lean<ContactRow[]>();

  const foundIds = new Set(contacts.map((contact) => contact._id.toString()));
  const missingIds = uniqueRequestedIds.filter((id) => !foundIds.has(id));

  if (missingIds.length > 0) {
    throw new AppError(
      "One or more selected contacts do not belong to this workspace",
      400,
    );
  }

  const eligibleContacts = contacts.filter((c) => !c.isOptedOut);
  const optedOutCount = contacts.length - eligibleContacts.length;

  const { recipients, excluded, duplicates } = buildRecipients(eligibleContacts);

  return {
    audience: {
      mode,
      contactIds: recipients.map((recipient) => recipient.contactId),
    },
    recipients,
    summary: {
      requested: contactIds.length,
      eligible: recipients.length,
      excluded: excluded + optedOutCount,
      duplicates: duplicates + duplicatedRequestIds,
    },
  };
}
