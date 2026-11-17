import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  normalizeWhatsAppPhoneNumber,
  findExistingContactByPhone,
  resolveOrCreateWorkspaceContact,
  resolveOrCreateWorkspaceConversation,
} from "../src/modules/whatsapp/whatsapp-contact-resolver.service.js";
import WhatsAppContact from "../src/modules/whatsapp/contact.model.js";
import WhatsAppConversation, {
  isCustomerServiceWindowOpen,
  getCustomerServiceWindowExpiry,
} from "../src/modules/whatsapp/conversation.model.js";

describe("WhatsApp Contact & Conversation Deduplication Suite", () => {
  const workspaceId = new mongoose.Types.ObjectId();
  const whatsappAccountId = new mongoose.Types.ObjectId();

  it("1. should normalize different phone number formats to canonical waId and search variants", () => {
    // Local Bangladesh format starting with 0
    const local = normalizeWhatsAppPhoneNumber("01712345678");
    assert.equal(local.waId, "8801712345678");
    assert.equal(local.phoneNumber, "+8801712345678");
    assert.ok(local.searchVariants.includes("01712345678"));
    assert.ok(local.searchVariants.includes("8801712345678"));

    // International format with +
    const intl = normalizeWhatsAppPhoneNumber("+8801712345678");
    assert.equal(intl.waId, "8801712345678");
    assert.equal(intl.phoneNumber, "+8801712345678");

    // Pure digits
    const pure = normalizeWhatsAppPhoneNumber("8801712345678");
    assert.equal(pure.waId, "8801712345678");
    assert.equal(pure.phoneNumber, "+8801712345678");

    // Punctuation and spaces
    const spaced = normalizeWhatsAppPhoneNumber("+880 1712-345678");
    assert.equal(spaced.waId, "8801712345678");
    assert.equal(spaced.phoneNumber, "+8801712345678");
  });

  it("2. should find existing contact when webhook arrives with international format and contact was saved with local format", async () => {
    const existingContactId = new mongoose.Types.ObjectId();
    const mockContactDoc = {
      _id: existingContactId,
      workspaceId,
      waId: "8801712345678",
      phoneNumber: "+8801712345678",
      profileName: "MD Limon",
      save: async () => mockContactDoc,
    };

    const originalFindOne = WhatsAppContact.findOne;

    try {
      WhatsAppContact.findOne = ((query: any) => {
        // Verify query matches workspace and phone variants
        assert.ok(query.workspaceId);
        assert.ok(query.$or);
        return Promise.resolve(mockContactDoc);
      }) as any;

      const found = await findExistingContactByPhone(workspaceId, "8801712345678");
      assert.ok(found);
      assert.equal(found._id, existingContactId);
      assert.equal(found.profileName, "MD Limon");
    } finally {
      WhatsAppContact.findOne = originalFindOne;
    }
  });

  it("3. should update profile name and return existing contact without inserting duplicate", async () => {
    const existingContactId = new mongoose.Types.ObjectId();
    let savedProfileName = "MD Limon";

    const mockContactDoc: any = {
      _id: existingContactId,
      workspaceId,
      waId: "8801712345678",
      phoneNumber: "+8801712345678",
      get profileName() {
        return savedProfileName;
      },
      set profileName(val: string) {
        savedProfileName = val;
      },
      save: async () => mockContactDoc,
    };

    const originalFindOne = WhatsAppContact.findOne;
    const originalCreate = WhatsAppContact.create;
    let createCalled = false;

    try {
      WhatsAppContact.findOne = (() => Promise.resolve(mockContactDoc)) as any;
      WhatsAppContact.create = (() => {
        createCalled = true;
        return Promise.resolve(mockContactDoc);
      }) as any;

      // Webhook arrives with name 'md' for same number
      const contact = await resolveOrCreateWorkspaceContact({
        workspaceId,
        phoneNumber: "8801712345678",
        profileName: "md",
      });

      assert.equal(createCalled, false, "Should not insert duplicate contact document");
      assert.equal(contact._id, existingContactId);
      assert.equal(contact.profileName, "md");
    } finally {
      WhatsAppContact.findOne = originalFindOne;
      WhatsAppContact.create = originalCreate;
    }
  });

  it("4. should reuse existing conversation and activate 24-hour customer service window on incoming message", async () => {
    const contactId = new mongoose.Types.ObjectId();
    const existingConvId = new mongoose.Types.ObjectId();
    const incomingTimestamp = new Date();

    const mockConvDoc: any = {
      _id: existingConvId,
      workspaceId,
      whatsappAccountId,
      contactId,
      status: "OPEN",
      lastMessageAt: new Date(Date.now() - 3600000), // 1 hour ago
      lastCustomerMessageAt: null,
      isCustomerServiceWindowActive: false,
      save: async () => mockConvDoc,
    };

    const originalConvFindOne = WhatsAppConversation.findOne;
    const originalConvCreate = WhatsAppConversation.create;
    let createConvCalled = false;

    try {
      WhatsAppConversation.findOne = (() => Promise.resolve(mockConvDoc)) as any;
      WhatsAppConversation.create = (() => {
        createConvCalled = true;
        return Promise.resolve(mockConvDoc);
      }) as any;

      const conv = await resolveOrCreateWorkspaceConversation({
        workspaceId,
        whatsappAccountId,
        contactId,
        isCustomerMessage: true,
        messageTimestamp: incomingTimestamp,
      });

      assert.equal(createConvCalled, false, "Should not create duplicate conversation");
      assert.equal(conv._id, existingConvId);
      assert.equal(conv.isCustomerServiceWindowActive, true);
      assert.ok(conv.customerServiceWindowExpiresAt);
      assert.equal(
        conv.customerServiceWindowExpiresAt.getTime(),
        incomingTimestamp.getTime() + 24 * 60 * 60 * 1000,
      );
    } finally {
      WhatsAppConversation.findOne = originalConvFindOne;
      WhatsAppConversation.create = originalConvCreate;
    }
  });

  it("5. should accurately verify 24h window helper calculation", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000);
    const twentyFiveHoursAgo = new Date(now - 25 * 60 * 60 * 1000);

    assert.equal(isCustomerServiceWindowOpen(fiveHoursAgo, now), true);
    assert.equal(isCustomerServiceWindowOpen(twentyFiveHoursAgo, now), false);
    assert.equal(isCustomerServiceWindowOpen(null, now), false);

    const expiry = getCustomerServiceWindowExpiry(fiveHoursAgo, now);
    assert.ok(expiry);
    assert.equal(expiry.getTime(), fiveHoursAgo.getTime() + 24 * 60 * 60 * 1000);
  });
});
