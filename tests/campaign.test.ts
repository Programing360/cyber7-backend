import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";

import Campaign from "../src/modules/campaign/campaign.model.js";
import CampaignRecipient from "../src/modules/campaign/campaign-recipient.model.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import WhatsAppTemplate from "../src/modules/whatsapp/template.model.js";
import { requireRole } from "../src/middlewares/require-role.js";
import { resolveCampaignAudience } from "../src/modules/campaign/campaign-audience.service.js";
import {
  cancelCampaign,
  createCampaign,
  deleteDraftCampaign,
  getCampaignById,
  getCampaignRecipients,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
  updateDraftCampaign,
} from "../src/modules/campaign/campaign.service.js";
import {
  campaignListQuerySchema,
  createCampaignSchema,
  scheduleCampaignSchema,
  updateDraftCampaignSchema,
} from "../src/modules/campaign/campaign.validation.js";

const WORKSPACE_ID = "507f1f77bcf86cd799439011";
const OTHER_WORKSPACE_ID = "507f1f77bcf86cd799439012";
const CAMPAIGN_ID = "507f1f77bcf86cd799439031";
const CONTACT_ID = "507f1f77bcf86cd799439041";
const CONTACT_ID_2 = "507f1f77bcf86cd799439042";
const ACCOUNT_ID = "507f1f77bcf86cd799439051";
const TEMPLATE_ID = "507f1f77bcf86cd799439061";
const USER_ID = "507f1f77bcf86cd799439071";

const objectId = (value: string) => new Types.ObjectId(value);
const FUTURE_DATE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function expectStatus(error: unknown, status: number, pattern?: RegExp) {
  assert.ok(error instanceof Error);
  assert.equal((error as { statusCode?: number }).statusCode, status);
  if (pattern) {
    assert.match(error.message, pattern);
  }
}

function createQueryChain(result: unknown) {
  const chain: Record<string, unknown> = {
    sort() {
      return chain;
    },
    skip() {
      return chain;
    },
    limit() {
      return chain;
    },
    select() {
      return chain;
    },
    lean: async () => result,
    then(onFulfilled: unknown, onRejected: unknown) {
      return Promise.resolve(result).then(
        onFulfilled as never,
        onRejected as never,
      );
    },
    catch(onRejected: unknown) {
      return Promise.resolve(result).catch(onRejected as never);
    },
  };

  return chain;
}

function makeContact(id: string, phoneNumber = "+8801700000000") {
  return {
    _id: objectId(id),
    phoneNumber,
    waId: phoneNumber.replace(/\D/g, ""),
  };
}

function makeCampaign(overrides: Record<string, unknown> = {}) {
  const now = new Date();

  return {
    _id: objectId(CAMPAIGN_ID),
    workspaceId: objectId(WORKSPACE_ID),
    name: "Ramadan launch",
    description: "Seasonal promotion",
    whatsappAccountId: objectId(ACCOUNT_ID),
    templateId: objectId(TEMPLATE_ID),
    audience: {
      mode: "SELECTED_CONTACTS",
      contactIds: [objectId(CONTACT_ID)],
    },
    status: "DRAFT",
    scheduledAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
    createdBy: objectId(USER_ID),
    totalRecipients: 1,
    sentCount: 0,
    deliveredCount: 0,
    readCount: 0,
    failedCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function stubAccount(status = "CONNECTED", found = true) {
  return mock.method(WhatsAppAccount, "findOne", async () =>
    found
      ? {
          _id: objectId(ACCOUNT_ID),
          workspaceId: objectId(WORKSPACE_ID),
          status,
        }
      : null,
  );
}

function stubTemplate(
  status = "APPROVED",
  found = true,
  accountId = ACCOUNT_ID,
) {
  return mock.method(WhatsAppTemplate, "findOne", async () =>
    found
      ? {
          _id: objectId(TEMPLATE_ID),
          workspaceId: objectId(WORKSPACE_ID),
          whatsappAccountId: objectId(accountId),
          status,
        }
      : null,
  );
}

function stubCampaignLookup(campaign: unknown) {
  return mock.method(Campaign, "findOne", async () => campaign);
}

function stubCampaignUpdate(campaign: Record<string, unknown>) {
  return mock.method(
    Campaign,
    "findOneAndUpdate",
    async (_filter: unknown, update: { $set?: Record<string, unknown> }) => ({
      ...campaign,
      ...(update.$set ?? {}),
    }),
  );
}

beforeEach(() => {
  mock.method(CampaignRecipient, "deleteMany", async () => ({
    deletedCount: 0,
  }));
});

afterEach(() => {
  mock.restoreAll();
});

describe("Campaign creation", () => {
  it("creates a draft and persists recipient snapshots", async () => {
    stubAccount();
    stubTemplate();
    mock.method(WhatsAppContact, "find", () =>
      createQueryChain([makeContact(CONTACT_ID, "+880 171-111-2222")]),
    );

    const create = mock.method(Campaign, "create", async (data: unknown) =>
      makeCampaign({ ...(data as Record<string, unknown>) }),
    );
    const insert = mock.method(CampaignRecipient, "insertMany", async () => []);

    const result = await createCampaign({
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
      input: {
        name: "Ramadan launch",
        description: "Seasonal promotion",
        whatsappAccountId: ACCOUNT_ID,
        templateId: TEMPLATE_ID,
        audience: { mode: "SELECTED_CONTACTS", contactIds: [CONTACT_ID] },
      },
    });

    assert.equal(result.campaign.status, "DRAFT");
    assert.equal(result.campaign.totalRecipients, 1);
    assert.equal(result.campaign.createdBy, USER_ID);
    assert.equal(result.audienceSummary.eligible, 1);

    const createArgs = create.mock.calls[0].arguments[0] as unknown as {
      status: string;
      audience: { contactIds: Types.ObjectId[] };
    };
    assert.equal(createArgs.status, "DRAFT");
    assert.equal(createArgs.audience.contactIds[0].toString(), CONTACT_ID);

    const inserted = insert.mock.calls[0].arguments[0] as unknown as Array<{
      workspaceId: Types.ObjectId;
      campaignId: Types.ObjectId;
      contactId: Types.ObjectId;
      phoneNumber: string;
      status: string;
    }>;

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].workspaceId.toString(), WORKSPACE_ID);
    assert.equal(inserted[0].campaignId.toString(), CAMPAIGN_ID);
    assert.equal(inserted[0].contactId.toString(), CONTACT_ID);
    assert.equal(inserted[0].phoneNumber, "+880 171-111-2222");
    assert.equal(inserted[0].status, "PENDING");
  });

  it("rejects a template that belongs to another WhatsApp account", async () => {
    stubAccount();
    stubTemplate("APPROVED", true, CONTACT_ID);

    await assert.rejects(
      () =>
        createCampaign({
          workspaceId: WORKSPACE_ID,
          createdBy: USER_ID,
          input: {
            name: "Ramadan launch",
            whatsappAccountId: ACCOUNT_ID,
            templateId: TEMPLATE_ID,
            audience: { mode: "ALL_CONTACTS" },
          },
        }),
      (error: unknown) => {
        expectStatus(error, 400, /does not belong/i);
        return true;
      },
    );
  });
});

describe("Campaign update", () => {
  it("updates a draft and replaces its recipient snapshot", async () => {
    stubCampaignLookup(makeCampaign());
    mock.method(WhatsAppContact, "find", () =>
      createQueryChain([
        makeContact(CONTACT_ID),
        makeContact(CONTACT_ID_2, "+8801800000000"),
      ]),
    );

    const update = mock.method(
      Campaign,
      "findOneAndUpdate",
      async (_filter: unknown, changes: { $set: Record<string, unknown> }) =>
        makeCampaign(changes.$set),
    );
    const insert = mock.method(CampaignRecipient, "insertMany", async () => []);

    const result = await updateDraftCampaign({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      input: { name: "Updated name", audience: { mode: "ALL_CONTACTS" } },
    });

    assert.equal(result.campaign.name, "Updated name");
    assert.equal(result.campaign.audience.mode, "ALL_CONTACTS");
    assert.equal(result.campaign.totalRecipients, 2);
    assert.equal(result.audienceSummary?.eligible, 2);

    const [filter, changes] = update.mock.calls[0].arguments as unknown as [
      { _id: Types.ObjectId; workspaceId: Types.ObjectId; status: string },
      { $set: Record<string, unknown> },
    ];

    assert.equal(filter._id.toString(), CAMPAIGN_ID);
    assert.equal(filter.workspaceId.toString(), WORKSPACE_ID);
    assert.equal(filter.status, "DRAFT");
    assert.equal(changes.$set.name, "Updated name");
    assert.deepEqual(
      (changes.$set.audience as { contactIds: Types.ObjectId[] }).contactIds,
      [],
    );
    assert.equal(insert.mock.callCount(), 1);
  });

  it("rejects editing a campaign that is not a draft", async () => {
    stubCampaignLookup(makeCampaign({ status: "SCHEDULED" }));
    const update = mock.method(Campaign, "findOneAndUpdate", async () => null);

    await assert.rejects(
      () =>
        updateDraftCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          input: { name: "Nope" },
        }),
      (error: unknown) => {
        expectStatus(error, 409, /only draft campaigns can be edited/i);
        return true;
      },
    );

    assert.equal(update.mock.callCount(), 0);
  });

  it("returns 404 when the campaign is outside the workspace", async () => {
    const lookup = stubCampaignLookup(null);

    await assert.rejects(
      () =>
        updateDraftCampaign({
          workspaceId: OTHER_WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          input: { name: "Nope" },
        }),
      (error: unknown) => {
        expectStatus(error, 404, /campaign not found/i);
        return true;
      },
    );

    const filter = lookup.mock.calls[0].arguments[0] as unknown as {
      workspaceId: Types.ObjectId;
    };
    assert.equal(filter.workspaceId.toString(), OTHER_WORKSPACE_ID);
  });
});

describe("Campaign deletion", () => {
  it("deletes only a draft campaign and its recipients", async () => {
    stubCampaignLookup(makeCampaign());
    mock.method(Campaign, "findOneAndDelete", async () => makeCampaign());

    const result = await deleteDraftCampaign({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.id, CAMPAIGN_ID);
  });

  it("refuses to delete a scheduled campaign", async () => {
    stubCampaignLookup(makeCampaign({ status: "SCHEDULED" }));
    const deletion = mock.method(Campaign, "findOneAndDelete", async () => null);

    await assert.rejects(
      () =>
        deleteDraftCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
        }),
      (error: unknown) => {
        expectStatus(error, 409, /only draft campaigns can be deleted/i);
        return true;
      },
    );

    assert.equal(deletion.mock.callCount(), 0);
  });
});

describe("Campaign scheduling", () => {
  it("schedules a valid draft with a connected account and approved template", async () => {
    stubCampaignLookup(makeCampaign());
    stubAccount();
    stubTemplate();
    mock.method(WhatsAppContact, "find", () =>
      createQueryChain([makeContact(CONTACT_ID)]),
    );
    const insert = mock.method(CampaignRecipient, "insertMany", async () => []);

    const update = stubCampaignUpdate(makeCampaign());

    const result = await scheduleCampaign({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      input: { scheduledAt: FUTURE_DATE },
    });

    assert.equal(result.campaign.status, "SCHEDULED");
    assert.equal(result.campaign.scheduledAt, FUTURE_DATE);
    assert.equal(insert.mock.callCount(), 1);

    const [filter, changes] = update.mock.calls[0].arguments as unknown as [
      { status: string; workspaceId: Types.ObjectId },
      { $set: { scheduledAt: Date; status: string } },
    ];

    assert.equal(filter.status, "DRAFT");
    assert.equal(filter.workspaceId.toString(), WORKSPACE_ID);
    assert.equal(changes.$set.status, "SCHEDULED");
    assert.ok(changes.$set.scheduledAt instanceof Date);
  });

  it("rejects scheduling a disconnected WhatsApp account", async () => {
    stubCampaignLookup(makeCampaign());
    stubAccount("DISCONNECTED");
    stubTemplate();

    await assert.rejects(
      () =>
        scheduleCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          input: { scheduledAt: FUTURE_DATE },
        }),
      (error: unknown) => {
        expectStatus(error, 400, /not connected/i);
        return true;
      },
    );
  });

  it("rejects scheduling a non-approved template", async () => {
    stubCampaignLookup(makeCampaign());
    stubAccount();
    stubTemplate("PENDING");

    await assert.rejects(
      () =>
        scheduleCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          input: { scheduledAt: FUTURE_DATE },
        }),
      (error: unknown) => {
        expectStatus(error, 400, /not approved/i);
        return true;
      },
    );
  });

  it("rejects scheduling a campaign that is not a draft", async () => {
    stubCampaignLookup(makeCampaign({ status: "CANCELLED" }));

    await assert.rejects(
      () =>
        scheduleCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          input: { scheduledAt: FUTURE_DATE },
        }),
      (error: unknown) => {
        expectStatus(error, 409, /only draft campaigns can be scheduled/i);
        return true;
      },
    );
  });
});

describe("Campaign state transitions", () => {
  it("cancels a scheduled campaign", async () => {
    stubCampaignUpdate(makeCampaign({ status: "CANCELLED" }));

    const result = await cancelCampaign({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.status, "CANCELLED");
  });

  it("pauses a scheduled campaign", async () => {
    stubCampaignUpdate(makeCampaign({ status: "PAUSED" }));

    const result = await pauseCampaign({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.status, "PAUSED");
  });

  it("resumes a paused campaign after revalidating the account and template", async () => {
    stubCampaignLookup(makeCampaign({ status: "PAUSED" }));
    stubAccount();
    stubTemplate();
    stubCampaignUpdate(makeCampaign({ status: "SCHEDULED" }));

    const result = await resumeCampaign({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.status, "SCHEDULED");
  });

  it("rejects resuming a campaign that is not paused", async () => {
    stubCampaignLookup(makeCampaign({ status: "SCHEDULED" }));

    await assert.rejects(
      () =>
        resumeCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
        }),
      (error: unknown) => {
        expectStatus(error, 409, /only paused campaigns can be resumed/i);
        return true;
      },
    );
  });

  it("rejects an invalid cancel transition", async () => {
    mock.method(Campaign, "findOneAndUpdate", async () => null);
    stubCampaignLookup(makeCampaign({ status: "COMPLETED" }));

    await assert.rejects(
      () =>
        cancelCampaign({
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
        }),
      (error: unknown) => {
        expectStatus(error, 409, /cannot be cancelled/i);
        return true;
      },
    );
  });
});

describe("Campaign identifiers and tenant isolation", () => {
  it("rejects an invalid campaign id", async () => {
    await assert.rejects(
      () =>
        getCampaignById({
          workspaceId: WORKSPACE_ID,
          campaignId: "not-an-object-id",
        }),
      (error: unknown) => {
        expectStatus(error, 400, /valid campaign id/i);
        return true;
      },
    );
  });

  it("returns 404 for a campaign in another workspace", async () => {
    const lookup = stubCampaignLookup(null);

    await assert.rejects(
      () =>
        getCampaignById({
          workspaceId: OTHER_WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
        }),
      (error: unknown) => {
        expectStatus(error, 404, /campaign not found/i);
        return true;
      },
    );

    const filter = lookup.mock.calls[0].arguments[0] as unknown as {
      _id: Types.ObjectId;
      workspaceId: Types.ObjectId;
    };

    assert.equal(filter._id.toString(), CAMPAIGN_ID);
    assert.equal(filter.workspaceId.toString(), OTHER_WORKSPACE_ID);
  });
});

describe("Audience resolution", () => {
  it("rejects selected contacts from another workspace", async () => {
    mock.method(WhatsAppContact, "find", () =>
      createQueryChain([makeContact(CONTACT_ID)]),
    );

    await assert.rejects(
      () =>
        resolveCampaignAudience({
          workspaceId: WORKSPACE_ID,
          mode: "SELECTED_CONTACTS",
          contactIds: [CONTACT_ID, CONTACT_ID_2],
        }),
      (error: unknown) => {
        expectStatus(error, 400, /do not belong to this workspace/i);
        return true;
      },
    );
  });

  it("de-duplicates repeated contact ids", async () => {
    mock.method(WhatsAppContact, "find", () =>
      createQueryChain([makeContact(CONTACT_ID)]),
    );

    const result = await resolveCampaignAudience({
      workspaceId: WORKSPACE_ID,
      mode: "SELECTED_CONTACTS",
      contactIds: [CONTACT_ID, CONTACT_ID],
    });

    assert.equal(result.recipients.length, 1);
    assert.equal(result.summary.duplicates, 1);
    assert.equal(result.summary.eligible, 1);
    assert.equal(result.summary.requested, 2);
  });

  it("excludes contacts with invalid phone numbers", async () => {
    mock.method(WhatsAppContact, "find", () =>
      createQueryChain([makeContact(CONTACT_ID, "+1 2")]),
    );

    const result = await resolveCampaignAudience({
      workspaceId: WORKSPACE_ID,
      mode: "ALL_CONTACTS",
    });

    assert.equal(result.recipients.length, 0);
    assert.equal(result.summary.excluded, 1);
  });

  it("rejects an empty selected audience", async () => {
    await assert.rejects(
      () =>
        resolveCampaignAudience({
          workspaceId: WORKSPACE_ID,
          mode: "SELECTED_CONTACTS",
          contactIds: [],
        }),
      (error: unknown) => {
        expectStatus(error, 400, /at least one contact/i);
        return true;
      },
    );
  });

  it("declares a unique index preventing duplicate campaign recipients", () => {
    const indexes = CampaignRecipient.schema.indexes();
    const uniqueIndex = indexes.find(
      ([keys, options]) =>
        keys.campaignId === 1 &&
        keys.contactId === 1 &&
        options?.unique === true,
    );

    assert.ok(uniqueIndex);
  });
});

describe("Campaign reference validation", () => {
  it("rejects a WhatsApp account outside the workspace", async () => {
    stubAccount("CONNECTED", false);
    stubTemplate();

    await assert.rejects(
      () =>
        createCampaign({
          workspaceId: WORKSPACE_ID,
          createdBy: USER_ID,
          input: {
            name: "Launch",
            whatsappAccountId: ACCOUNT_ID,
            templateId: TEMPLATE_ID,
            audience: { mode: "ALL_CONTACTS" },
          },
        }),
      (error: unknown) => {
        expectStatus(error, 404, /account not found in this workspace/i);
        return true;
      },
    );
  });

  it("rejects a template outside the workspace", async () => {
    stubAccount();
    stubTemplate("APPROVED", false);

    await assert.rejects(
      () =>
        createCampaign({
          workspaceId: WORKSPACE_ID,
          createdBy: USER_ID,
          input: {
            name: "Launch",
            whatsappAccountId: ACCOUNT_ID,
            templateId: TEMPLATE_ID,
            audience: { mode: "ALL_CONTACTS" },
          },
        }),
      (error: unknown) => {
        expectStatus(error, 404, /template not found in this workspace/i);
        return true;
      },
    );
  });
});

describe("Campaign recipients", () => {
  it("returns recipients scoped to the workspace and campaign", async () => {
    stubCampaignLookup(makeCampaign());
    mock.method(CampaignRecipient, "countDocuments", async () => 1);
    const find = mock.method(CampaignRecipient, "find", () =>
      createQueryChain([
        {
          _id: objectId("507f1f77bcf86cd799439081"),
          workspaceId: objectId(WORKSPACE_ID),
          campaignId: objectId(CAMPAIGN_ID),
          contactId: objectId(CONTACT_ID),
          phoneNumber: "+8801700000000",
          status: "PENDING",
          errorCode: "100",
          errorMessage: "Bearer secret-token rejected, access_token=abc",
          sentAt: undefined,
          deliveredAt: undefined,
          readAt: undefined,
          failedAt: undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    const aggregate = mock.method(CampaignRecipient, "aggregate", async () => [
      { _id: "PENDING", count: 1 },
    ]);

    const result = await getCampaignRecipients({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      query: { page: 1, limit: 20 },
    });

    assert.equal(result.recipients.length, 1);
    assert.equal(result.summary.total, 1);
    assert.equal(result.summary.pending, 1);
    assert.doesNotMatch(
      result.recipients[0].errorMessage ?? "",
      /secret-token|abc/,
    );

    const findFilter = find.mock.calls[0].arguments[0] as unknown as {
      workspaceId: Types.ObjectId;
      campaignId: Types.ObjectId;
    };
    assert.equal(findFilter.workspaceId.toString(), WORKSPACE_ID);
    assert.equal(findFilter.campaignId.toString(), CAMPAIGN_ID);

    const pipeline = aggregate.mock.calls[0].arguments[0] as unknown as Array<{
      $match?: { workspaceId: Types.ObjectId; campaignId: Types.ObjectId };
    }>;
    assert.equal(
      pipeline[0].$match?.workspaceId.toString(),
      WORKSPACE_ID,
    );
    assert.equal(pipeline[0].$match?.campaignId.toString(), CAMPAIGN_ID);
  });

  it("returns 404 when recipients are requested for another workspace", async () => {
    stubCampaignLookup(null);

    await assert.rejects(
      () =>
        getCampaignRecipients({
          workspaceId: OTHER_WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          query: { page: 1, limit: 20 },
        }),
      (error: unknown) => {
        expectStatus(error, 404, /campaign not found/i);
        return true;
      },
    );
  });
});

describe("Campaign validation schemas", () => {
  it("rejects unknown create fields", () => {
    const parsed = createCampaignSchema.safeParse({
      name: "Launch",
      whatsappAccountId: ACCOUNT_ID,
      templateId: TEMPLATE_ID,
      audience: { mode: "ALL_CONTACTS" },
      status: "DRAFT",
    });

    assert.equal(parsed.success, false);
  });

  it("rejects missing create fields", () => {
    assert.equal(createCampaignSchema.safeParse({ name: "Launch" }).success, false);
  });

  it("rejects an invalid ObjectId", () => {
    const parsed = createCampaignSchema.safeParse({
      name: "Launch",
      whatsappAccountId: "bad-id",
      templateId: TEMPLATE_ID,
      audience: { mode: "ALL_CONTACTS" },
    });

    assert.equal(parsed.success, false);
  });

  it("rejects a selected audience without contacts", () => {
    const parsed = createCampaignSchema.safeParse({
      name: "Launch",
      whatsappAccountId: ACCOUNT_ID,
      templateId: TEMPLATE_ID,
      audience: { mode: "SELECTED_CONTACTS", contactIds: [] },
    });

    assert.equal(parsed.success, false);
  });

  it("rejects an all-contacts audience that includes contacts", () => {
    const parsed = createCampaignSchema.safeParse({
      name: "Launch",
      whatsappAccountId: ACCOUNT_ID,
      templateId: TEMPLATE_ID,
      audience: { mode: "ALL_CONTACTS", contactIds: [CONTACT_ID] },
    });

    assert.equal(parsed.success, false);
  });

  it("rejects an empty draft update", () => {
    assert.equal(updateDraftCampaignSchema.safeParse({}).success, false);
  });

  it("rejects unknown draft update fields", () => {
    const parsed = updateDraftCampaignSchema.safeParse({ status: "SCHEDULED" });
    assert.equal(parsed.success, false);
  });

  it("rejects a past scheduling date", () => {
    const parsed = scheduleCampaignSchema.safeParse({
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });

    assert.equal(parsed.success, false);
  });

  it("accepts a future scheduling date", () => {
    assert.equal(
      scheduleCampaignSchema.safeParse({ scheduledAt: FUTURE_DATE }).success,
      true,
    );
  });

  it("rejects an invalid list status and oversized limit", () => {
    assert.equal(
      campaignListQuerySchema.safeParse({ status: "RUNNING" }).success,
      false,
    );
    assert.equal(campaignListQuerySchema.safeParse({ limit: "101" }).success, false);
  });
});

describe("Campaign role protection", () => {
  function createResponse() {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
    };
    return res;
  }

  it("blocks an AGENT from creating a campaign", () => {
    const req = { workspace: { role: "AGENT" } };
    const res = createResponse();
    let nextCalled = false;

    requireRole("OWNER", "ADMIN")(
      req as never,
      res as never,
      (() => {
        nextCalled = true;
      }) as never,
    );

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it("allows an AGENT to read campaigns", () => {
    const req = { workspace: { role: "AGENT" } };
    const res = createResponse();
    let nextCalled = false;

    requireRole("OWNER", "ADMIN", "AGENT")(
      req as never,
      res as never,
      (() => {
        nextCalled = true;
      }) as never,
    );

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
  });
});
