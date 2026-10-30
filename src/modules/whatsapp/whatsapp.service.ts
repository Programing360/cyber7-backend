import WhatsAppAccount from "./whatsapp.model.js";
import { encrypt } from "../../utils/encryption.js";

import type { ConnectWhatsAppInput } from "./whatsapp.validation.js";
import { AppError } from "../../utils/app-error.js";

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

  const encryptedToken = encrypt(input.accessToken);

  try {
    const account = await WhatsAppAccount.create({
      workspaceId,
      businessName: input.businessName,
      businessAccountId: input.businessAccountId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber,
      accessTokenEncrypted: encryptedToken,
      status: "PENDING",
      webhookVerified: false,
    });

    return {
      id: account._id,
      businessName: account.businessName,
      businessAccountId: account.businessAccountId,
      phoneNumberId: account.phoneNumberId,
      displayPhoneNumber: account.displayPhoneNumber,
      status: account.status,
      webhookVerified: account.webhookVerified,
      createdAt: account.createdAt,
    };
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
