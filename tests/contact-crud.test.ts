/**
 * Contacts CRUD tests.
 *
 * Run with:
 *   npx tsx --test tests/contact-crud.test.ts
 */

import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import {
  createOrUpsertWorkspaceContact,
  updateWorkspaceContact,
  deleteWorkspaceContact,
} from "../src/modules/whatsapp/whatsapp-chat.service.js";
import {
  createContactSchema,
  updateContactSchema,
} from "../src/modules/whatsapp/whatsapp.validation.js";
import { requireRole } from "../src/middlewares/require-role.js";

const WORKSPACE_ID = "507f1f77bcf86cd799439011";
const OTHER_WORKSPACE_ID = "507f1f77bcf86cd799439012";
const CONTACT_ID = "507f1f77bcf86cd799439021";

function expectStatus(error: unknown, status: number, pattern?: RegExp) {
  assert.ok(error instanceof Error);
  assert.equal((error as { statusCode?: number }).statusCode, status);
  if (pattern) {
    assert.match(error.message, pattern);
  }
}

function stubDuplicateLookup(match: boolean) {
  return mock.method(WhatsAppContact, "findOne", () => ({
    select: async () => (match ? { _id: CONTACT_ID } : null),
  }));
}

afterEach(() => {
  mock.restoreAll();
});

describe("Create contact", () => {
  it("normalizes the phone number into a waId and trims values", async () => {
    const upsert = mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async () => ({ _id: CONTACT_ID }),
    );

    await createOrUpsertWorkspaceContact({
      workspaceId: WORKSPACE_ID,
      input: { phoneNumber: " +880 (170) 000-0000 ", profileName: " Alice " },
    });

    const [filter, update, options] = upsert.mock.calls[0]
      .arguments as unknown as [
      { workspaceId: { toString(): string }; waId: string },
      { $set: { phoneNumber: string; profileName?: string } },
      { upsert: boolean },
    ];

    assert.equal(filter.workspaceId.toString(), WORKSPACE_ID);
    assert.equal(filter.waId, "8801700000000");
    assert.equal(update.$set.phoneNumber, "+880 (170) 000-0000");
    assert.equal(update.$set.profileName, "Alice");
    assert.equal(options.upsert, true);
  });

  it("rejects a phone number without enough digits", async () => {
    await assert.rejects(
      () =>
        createOrUpsertWorkspaceContact({
          workspaceId: WORKSPACE_ID,
          input: { phoneNumber: "+1 2" },
        }),
      (error: unknown) => {
        expectStatus(error, 400, /invalid phone number/i);
        return true;
      },
    );
  });

  it("maps a duplicate key error to a 409 conflict", async () => {
    mock.method(WhatsAppContact, "findOneAndUpdate", async () => {
      throw Object.assign(new Error("duplicate key"), { code: 11000 });
    });

    await assert.rejects(
      () =>
        createOrUpsertWorkspaceContact({
          workspaceId: WORKSPACE_ID,
          input: { phoneNumber: "+8801700000000" },
        }),
      (error: unknown) => {
        expectStatus(error, 409, /already exists/i);
        return true;
      },
    );
  });
});

describe("Update contact", () => {
  it("updates the profile name scoped to the workspace", async () => {
    const update = mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async () => ({ _id: CONTACT_ID, profileName: "Bob" }),
    );

    await updateWorkspaceContact({
      workspaceId: WORKSPACE_ID,
      contactId: CONTACT_ID,
      input: { profileName: " Bob " },
    });

    const [filter, changes] = update.mock.calls[0].arguments as unknown as [
      { _id: { toString(): string }; workspaceId: { toString(): string } },
      { $set: { profileName: string } },
    ];

    assert.equal(filter._id.toString(), CONTACT_ID);
    assert.equal(filter.workspaceId.toString(), WORKSPACE_ID);
    assert.equal(changes.$set.profileName, "Bob");
  });

  it("normalizes a new phone number and updates the waId", async () => {
    stubDuplicateLookup(false);
    const update = mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async () => ({ _id: CONTACT_ID }),
    );

    await updateWorkspaceContact({
      workspaceId: WORKSPACE_ID,
      contactId: CONTACT_ID,
      input: { phoneNumber: "+880 171-111-2222" },
    });

    const changes = update.mock.calls[0].arguments[1] as unknown as {
      $set: { phoneNumber: string; waId: string };
    };

    assert.equal(changes.$set.phoneNumber, "+880 171-111-2222");
    assert.equal(changes.$set.waId, "8801711112222");
  });

  it("clears the profile name when an empty value is supplied", async () => {
    const update = mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async () => ({ _id: CONTACT_ID }),
    );

    await updateWorkspaceContact({
      workspaceId: WORKSPACE_ID,
      contactId: CONTACT_ID,
      input: { profileName: "   " },
    });

    const changes = update.mock.calls[0].arguments[1] as unknown as {
      $unset: { profileName: "" };
    };

    assert.equal(changes.$unset.profileName, "");
  });

  it("rejects a phone number that belongs to another contact", async () => {
    stubDuplicateLookup(true);
    const update = mock.method(
      WhatsAppContact,
      "findOneAndUpdate",
      async () => ({ _id: CONTACT_ID }),
    );

    await assert.rejects(
      () =>
        updateWorkspaceContact({
          workspaceId: WORKSPACE_ID,
          contactId: CONTACT_ID,
          input: { phoneNumber: "+8801700000000" },
        }),
      (error: unknown) => {
        expectStatus(error, 409, /already exists/i);
        return true;
      },
    );

    assert.equal(update.mock.callCount(), 0);
  });

  it("returns 404 when the contact is not in the workspace", async () => {
    stubDuplicateLookup(false);
    mock.method(WhatsAppContact, "findOneAndUpdate", async () => null);

    await assert.rejects(
      () =>
        updateWorkspaceContact({
          workspaceId: OTHER_WORKSPACE_ID,
          contactId: CONTACT_ID,
          input: { profileName: "Bob" },
        }),
      (error: unknown) => {
        expectStatus(error, 404, /contact not found/i);
        return true;
      },
    );
  });

  it("returns 404 for an invalid contact id", async () => {
    await assert.rejects(
      () =>
        updateWorkspaceContact({
          workspaceId: WORKSPACE_ID,
          contactId: "not-an-object-id",
          input: { profileName: "Bob" },
        }),
      (error: unknown) => {
        expectStatus(error, 404, /contact not found/i);
        return true;
      },
    );
  });
});

describe("Update contact validation", () => {
  it("rejects an empty update payload", () => {
    const parsed = updateContactSchema.safeParse({});
    assert.equal(parsed.success, false);
  });

  it("rejects unknown fields", () => {
    const parsed = updateContactSchema.safeParse({ phoneNumber: "+8801700000000", email: "a@b.c" });
    assert.equal(parsed.success, false);
  });

  it("accepts a partial update", () => {
    const parsed = updateContactSchema.safeParse({ profileName: "Bob" });
    assert.equal(parsed.success, true);
  });

  it("keeps create validation strict about required fields", () => {
    const parsed = createContactSchema.safeParse({ profileName: "Bob" });
    assert.equal(parsed.success, false);
  });
});

describe("Delete contact", () => {
  it("deletes only within the workspace and returns a message", async () => {
    const deletion = mock.method(
      WhatsAppContact,
      "findOneAndDelete",
      async () => ({ _id: CONTACT_ID }),
    );

    const result = await deleteWorkspaceContact({
      workspaceId: WORKSPACE_ID,
      contactId: CONTACT_ID,
    });

    const filter = deletion.mock.calls[0].arguments[0] as unknown as {
      _id: { toString(): string };
      workspaceId: { toString(): string };
    };

    assert.equal(filter._id.toString(), CONTACT_ID);
    assert.equal(filter.workspaceId.toString(), WORKSPACE_ID);
    assert.match(result.message, /deleted successfully/i);
  });

  it("returns 404 when there is nothing to delete", async () => {
    mock.method(WhatsAppContact, "findOneAndDelete", async () => null);

    await assert.rejects(
      () =>
        deleteWorkspaceContact({
          workspaceId: WORKSPACE_ID,
          contactId: CONTACT_ID,
        }),
      (error: unknown) => {
        expectStatus(error, 404, /contact not found/i);
        return true;
      },
    );
  });

  it("returns 404 for an invalid contact id", async () => {
    await assert.rejects(
      () =>
        deleteWorkspaceContact({
          workspaceId: WORKSPACE_ID,
          contactId: "not-an-object-id",
        }),
      (error: unknown) => {
        expectStatus(error, 404, /contact not found/i);
        return true;
      },
    );
  });
});

describe("Role protection", () => {
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

  it("blocks an AGENT from deleting contacts", () => {
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

  it("allows an AGENT to update contacts", () => {
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
