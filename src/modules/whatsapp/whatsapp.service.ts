import WhatsAppAccount from "./whatsapp.model.js";
import { encrypt } from "../../utils/encryption.js";

import type {
  ConnectWhatsAppInput,
  UpdateWhatsAppStatusInput,
} from "./whatsapp.validation.js";
import { AppError } from "../../utils/app-error.js";
import { verifyWhatsAppCredentials } from "../services/whatsapp-api.service.js";

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

  // const encryptedToken = encrypt(input.accessToken);
  // Step 1: Verify credentials with Meta
  const metaAccount = await verifyWhatsAppCredentials(
    input.phoneNumberId,
    input.accessToken,
  );

  // Step 2: Validate Meta response
  if (metaAccount.id !== input.phoneNumberId) {
    throw new AppError("WhatsApp Phone Number ID verification failed", 400);
  }

  // Step 3: Encrypt access token
  const encryptedToken = encrypt(input.accessToken);

  try {
    const account = await WhatsAppAccount.create({
      workspaceId,
      businessName: input.businessName,
      businessAccountId: input.businessAccountId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber,
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
  const account = await WhatsAppAccount.findOneAndUpdate(
    { _id: accountId, workspaceId },
    {
      status: input.status,
      ...(input.status === "CONNECTED" ? { connectedAt: new Date() } : {}),
    },
    { new: true },
  );

  if (!account) {
    throw new AppError("WhatsApp account not found", 404);
  }

  return sanitizeAccount(account);
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnectWhatsAppAccount({
  workspaceId,
  accountId,
}: AccountParams) {
  const account = await WhatsAppAccount.findOneAndDelete({
    _id: accountId,
    workspaceId,
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
  const accounts = await WhatsAppAccount.find({ workspaceId })
    .select(
      "businessName businessAccountId phoneNumberId displayPhoneNumber status webhookVerified connectedAt createdAt",
    )
    .sort({ createdAt: -1 })
    .lean();

  return accounts;
}

export async function getWhatsAppAccountById(
  workspaceId: string,
  accountId: string,
) {
  const account = await WhatsAppAccount.findOne({
    _id: accountId,
    workspaceId,
  })
    .select(
      "businessName businessAccountId phoneNumberId displayPhoneNumber status webhookVerified connectedAt createdAt updatedAt",
    )
    .lean();

  if (!account) {
    throw new AppError("WhatsApp account not found", 404);
  }

  return account;
}