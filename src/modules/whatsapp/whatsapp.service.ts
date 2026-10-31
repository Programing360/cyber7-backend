import { Types } from "mongoose";

import WhatsAppAccount from "./whatsapp.model.js";
import { encrypt, decrypt } from "../../utils/encryption.js";
import { whatsappConfig } from "../config/whatsapp.config.js";
import { getPlatformWebhookVerificationStatus } from "./meta-platform-config.model.js";

import type {
  ConnectWhatsAppInput,
  UpdateWhatsAppStatusInput,
} from "./whatsapp.validation.js";
import { AppError } from "../../utils/app-error.js";
import {
  verifyWhatsAppCredentials,
  verifyWhatsAppBusinessAccount,
  verifyPhoneNumberInWaba,
} from "../services/whatsapp-api.service.js";

// ─── Connect ─────────────────────────────────────────────────────────────────

interface ConnectWhatsAppParams {
  workspaceId: string;
  input: ConnectWhatsAppInput;
}

export async function connectWhatsAppAccount({
  workspaceId,
  input,
}: ConnectWhatsAppParams) {
  const existingAccount = await WhatsAppAccount.findOne({
    $or: [
      { phoneNumberId: input.phoneNumberId },
      {
        workspaceId,
        businessAccountId: input.businessAccountId,
      },
    ],
  });

  if (existingAccount) {
    throw new AppError(
      "This WhatsApp account is already connected or registered",
      409,
    );
  }

  // Step 1: Verify Phone Number credentials with Meta
  const phoneDetails = await verifyWhatsAppCredentials(
    input.phoneNumberId,
    input.accessToken,
  );

  // Step 2: Validate Meta Phone Number ID response
  if (phoneDetails.id !== input.phoneNumberId) {
    throw new AppError("WhatsApp Phone Number ID verification failed", 400);
  }

  // Step 3: Verify WABA ID through Meta Graph API
  const wabaDetails = await verifyWhatsAppBusinessAccount(
    input.businessAccountId,
    input.accessToken,
  );

  if (wabaDetails.id !== input.businessAccountId) {
    throw new AppError("WhatsApp Business Account ID verification failed", 400);
  }

  // Step 4: Verify that the Phone Number belongs to the supplied WABA
  const belongsToWaba = await verifyPhoneNumberInWaba(
    input.businessAccountId,
    input.phoneNumberId,
    input.accessToken,
  );

  if (!belongsToWaba) {
    throw new AppError(
      `The Phone Number ID (${input.phoneNumberId}) does not belong to the provided WABA ID (${input.businessAccountId}).`,
      400,
    );
  }

  // Step 5: Validate display phone number matches Meta registered record
  const verifiedDisplayNumber =
    phoneDetails.displayPhoneNumber || input.displayPhoneNumber;
  const cleanInputNumber = input.displayPhoneNumber.replace(/\D/g, "");
  const cleanMetaNumber = verifiedDisplayNumber.replace(/\D/g, "");

  if (
    cleanInputNumber &&
    cleanMetaNumber &&
    cleanInputNumber !== cleanMetaNumber
  ) {
    throw new AppError(
      `The provided display phone number (${input.displayPhoneNumber}) does not match Meta's registered phone number (${verifiedDisplayNumber}).`,
      400,
    );
  }

  // Step 6: Encrypt access token
  const encryptedToken = encrypt(input.accessToken);

  try {
    const account = await WhatsAppAccount.create({
      workspaceId,
      businessName: input.businessName,
      businessAccountId: input.businessAccountId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: verifiedDisplayNumber,
      accessTokenEncrypted: encryptedToken,
      status: "CONNECTED",
      connectedAt: new Date(),
      webhookVerified: false,
    });

    return sanitizeAccount(account);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      throw new AppError("WhatsApp account already exists", 409);
    }

    throw error;
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listWhatsAppAccounts(workspaceId: string) {
  const accounts = await WhatsAppAccount.find({ workspaceId }).sort({
    createdAt: -1,
  });

  return accounts.map(sanitizeAccount);
}

// ─── Get one ──────────────────────────────────────────────────────────────────

interface AccountParams {
  workspaceId: string;
  accountId: string;
}

export async function getWhatsAppAccount({
  workspaceId,
  accountId,
}: AccountParams) {
  const account = await WhatsAppAccount.findOne({
    _id: accountId,
    workspaceId,
  });

  if (!account) {
    throw new AppError("WhatsApp account not found", 404);
  }

  return sanitizeAccount(account);
}

// ─── Update status ────────────────────────────────────────────────────────────

interface UpdateStatusParams extends AccountParams {
  input: UpdateWhatsAppStatusInput;
}

export async function updateWhatsAppAccountStatus({
  workspaceId,
  accountId,
  input,
}: UpdateStatusParams) {
  if (!Types.ObjectId.isValid(accountId)) {
    throw new AppError("Invalid account ID format", 400);
  }

  const targetWorkspaceId = Types.ObjectId.isValid(workspaceId)
    ? new Types.ObjectId(workspaceId)
    : workspaceId;

  const existing = await WhatsAppAccount.findOne({
    _id: accountId,
    workspaceId: targetWorkspaceId,
  }).select("+accessTokenEncrypted");

  if (!existing) {
    throw new AppError("WhatsApp account not found", 404);
  }

  // Do not mark an account CONNECTED without successful verification.
  if (input.status === "CONNECTED") {
    if (!existing.accessTokenEncrypted) {
      throw new AppError(
        "Cannot activate WhatsApp account: stored credentials are missing. Please reconnect the account.",
        400,
      );
    }

    let token: string;
    try {
      token = decrypt(existing.accessTokenEncrypted);
    } catch {
      throw new AppError(
        "Failed to decrypt stored credentials. Please reconnect the account.",
        500,
      );
    }

    // Verify token validity and phone accessibility against Meta Graph API
    const phoneDetails = await verifyWhatsAppCredentials(
      existing.phoneNumberId,
      token,
    );

    if (phoneDetails.id !== existing.phoneNumberId) {
      throw new AppError(
        "WhatsApp Phone Number ID verification failed with Meta.",
        400,
      );
    }
  }

  existing.status = input.status;
  if (input.status === "CONNECTED") {
    existing.connectedAt = new Date();
  }

  await existing.save();

  return sanitizeAccount(existing);
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnectWhatsAppAccount({
  workspaceId,
  accountId,
}: AccountParams) {
  const targetWorkspaceId = Types.ObjectId.isValid(workspaceId)
    ? new Types.ObjectId(workspaceId)
    : workspaceId;

  const account = await WhatsAppAccount.findOneAndDelete({
    _id: accountId,
    workspaceId: targetWorkspaceId,
  });

  if (!account) {
    throw new AppError("WhatsApp account not found", 404);
  }

  return { id: account._id.toString() };
}

// ─── Webhook verification ─────────────────────────────────────────────────────

export async function markWebhookVerified(phoneNumberId: string) {
  const account = await WhatsAppAccount.findOneAndUpdate(
    { phoneNumberId },
    { webhookVerified: true, status: "CONNECTED", connectedAt: new Date() },
    { new: true },
  );

  return account ? sanitizeAccount(account) : null;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function sanitizeAccount(account: InstanceType<typeof WhatsAppAccount>) {
  return {
    id: account._id.toString(),
    _id: account._id.toString(),
    businessName: account.businessName,
    businessAccountId: account.businessAccountId,
    phoneNumberId: account.phoneNumberId,
    displayPhoneNumber: account.displayPhoneNumber,
    status: account.status,
    webhookVerified: account.webhookVerified,
    connectedAt: account.connectedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function getWhatsAppAccounts(workspaceId: string) {
  const targetWorkspaceId = Types.ObjectId.isValid(workspaceId)
    ? new Types.ObjectId(workspaceId)
    : workspaceId;

  const accounts = await WhatsAppAccount.find({ workspaceId: targetWorkspaceId })
    .select(
      "businessName businessAccountId phoneNumberId displayPhoneNumber status webhookVerified connectedAt createdAt updatedAt",
    )
    .sort({ createdAt: -1 })
    .lean();

  return accounts.map((acc) => ({
    ...acc,
    id: acc._id.toString(),
    _id: acc._id.toString(),
  }));
}

export async function getWhatsAppAccountById(
  workspaceId: string,
  accountId: string,
) {
  if (!Types.ObjectId.isValid(accountId)) {
    throw new AppError("Invalid account ID format", 400);
  }

  const targetWorkspaceId = Types.ObjectId.isValid(workspaceId)
    ? new Types.ObjectId(workspaceId)
    : workspaceId;

  const account = await WhatsAppAccount.findOne({
    _id: accountId,
    workspaceId: targetWorkspaceId,
  })
    .select(
      "businessName businessAccountId phoneNumberId displayPhoneNumber status webhookVerified connectedAt createdAt updatedAt",
    )
    .lean();

  if (!account) {
    throw new AppError("WhatsApp account not found", 404);
  }

  return {
    ...account,
    id: account._id.toString(),
    _id: account._id.toString(),
  };
}

export interface WhatsAppConfigStatusResult {
  metaApp: {
    configured: boolean;
  };
  webhook: {
    configured: boolean;
    verified: boolean;
    callbackUrl: string | null;
  };
  workspaceAccount: {
    totalAccounts: number;
    connectedAccounts: number;
  };
}

export async function getWhatsAppConfigStatus(
  workspaceId: string,
): Promise<WhatsAppConfigStatusResult> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("A valid workspace ID is required", 400);
  }

  const targetWorkspaceId = new Types.ObjectId(workspaceId);

  const [totalAccounts, connectedAccounts, webhookVerified] =
    await Promise.all([
      WhatsAppAccount.countDocuments({ workspaceId: targetWorkspaceId }),
      WhatsAppAccount.countDocuments({
        workspaceId: targetWorkspaceId,
        status: "CONNECTED",
      }),
      getPlatformWebhookVerificationStatus(),
    ]);

  return {
    metaApp: {
      configured: whatsappConfig.isMetaAppConfigured,
    },
    webhook: {
      configured: whatsappConfig.isWebhookConfigured,
      verified: webhookVerified,
      callbackUrl: whatsappConfig.publicWebhookUrl,
    },
    workspaceAccount: {
      totalAccounts,
      connectedAccounts,
    },
  };
}