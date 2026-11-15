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
  makeWhatsAppApiRequest,
  subscribeWabaToMetaApp,
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
  const subscriptionResult = await makeWhatsAppApiRequest({
    nodeId: input.businessAccountId,
    endpoint: "subscribed_apps",
    method: "POST",
    accessToken: input.accessToken,
  });

  if (subscriptionResult.success !== true) {
    throw new AppError(
      "Failed to subscribe WhatsApp Business Account to Meta App.",
      502,
    );
  }

  // Step 6: Subscribe WABA to Meta App
  const isSubscribed = await subscribeWabaToMetaApp(
    input.businessAccountId,
    input.accessToken,
  );

  if (!isSubscribed) {
    throw new AppError(
      "Meta did not confirm WhatsApp Business Account subscription.",
      502,
    );
  }

  // Step 7: Encrypt access token
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
      webhookVerified: true,
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

// ─── Embedded Signup ──────────────────────────────────────────────────────────

export interface CompleteEmbeddedSignupInput {
  workspaceId: string;
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
}

export async function completeEmbeddedSignup({
  workspaceId,
  code,
  wabaId: inputWabaId,
  phoneNumberId: inputPhoneNumberId,
}: CompleteEmbeddedSignupInput) {
  if (!code || typeof code !== "string" || code.trim().length === 0) {
    throw new AppError(
      "Authorization code is required to complete WhatsApp Embedded Signup.",
      400,
      "MISSING_AUTH_CODE",
    );
  }

  const appId = whatsappConfig.appId;
  const appSecret = whatsappConfig.appSecret;
  const graphVersion = whatsappConfig.graphApiVersion;

  if (!appId || !appSecret) {
    throw new AppError(
      "Meta App ID or App Secret is not configured on the server. Please verify META_APP_ID and META_APP_SECRET.",
      500,
      "META_APP_NOT_CONFIGURED",
    );
  }

  // ── Step A: Exchange temporary authorization code for long-lived access token ─
  const tokenUrl = new URL(
    `https://graph.facebook.com/${graphVersion}/oauth/access_token`,
  );
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("code", code.trim());

  let tokenData: any;
  try {
    const tokenRes = await fetch(tokenUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    tokenData = (await tokenRes.json().catch(() => ({}))) as any;

    if (!tokenRes.ok || !tokenData?.access_token) {
      const errMsg =
        tokenData?.error?.message ||
        "Failed to exchange authorization code for access token with Meta.";
      console.error("[Embedded Signup] Token exchange error:", tokenData?.error);
      throw new AppError(errMsg, 400, "TOKEN_EXCHANGE_FAILED");
    }
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    console.error("[Embedded Signup] Network error during token exchange:", err);
    throw new AppError(
      "Failed to communicate with Meta Graph API for token exchange.",
      502,
      "META_NETWORK_ERROR",
    );
  }

  const accessToken: string = tokenData.access_token;

  // ── Resolve WABA ID and Phone Number ID (from input or fallback discovery) ───
  let resolvedWabaId = inputWabaId?.trim();
  let resolvedPhoneNumberId = inputPhoneNumberId?.trim();

  // Fallback 1: Resolve WABA ID via /me/whatsapp_business_accounts
  if (!resolvedWabaId) {
    try {
      const wabaQueryUrl = `https://graph.facebook.com/${graphVersion}/me/whatsapp_business_accounts?fields=id,name`;
      const wabaRes = await fetch(wabaQueryUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      const wabaResult = (await wabaRes.json().catch(() => ({}))) as any;
      if (Array.isArray(wabaResult?.data) && wabaResult.data.length > 0) {
        resolvedWabaId = wabaResult.data[0].id;
      }
    } catch (resolveErr) {
      console.warn(
        "[Embedded Signup] Fallback WABA resolution error:",
        resolveErr,
      );
    }
  }

  if (!resolvedWabaId) {
    throw new AppError(
      "Could not identify WhatsApp Business Account (WABA ID). Please ensure Embedded Signup finished successfully.",
      400,
      "MISSING_WABA_ID",
    );
  }

  // Fallback 2: Resolve Phone Number ID via WABA phone_numbers
  if (!resolvedPhoneNumberId) {
    try {
      const phoneQueryUrl = `https://graph.facebook.com/${graphVersion}/${resolvedWabaId}/phone_numbers?fields=id,display_phone_number,verified_name`;
      const phoneRes = await fetch(phoneQueryUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      const phoneResult = (await phoneRes.json().catch(() => ({}))) as any;
      if (Array.isArray(phoneResult?.data) && phoneResult.data.length > 0) {
        resolvedPhoneNumberId = phoneResult.data[0].id;
      }
    } catch (resolveErr) {
      console.warn(
        "[Embedded Signup] Fallback Phone Number resolution error:",
        resolveErr,
      );
    }
  }

  if (!resolvedPhoneNumberId) {
    throw new AppError(
      "Could not identify WhatsApp Phone Number ID. Please ensure a phone number was selected during Embedded Signup.",
      400,
      "MISSING_PHONE_NUMBER_ID",
    );
  }

  // ── Step B: Subscribe Webhook to WABA (subscribed_apps) ──────────────────────
  try {
    const subscribeUrl = `https://graph.facebook.com/${graphVersion}/${resolvedWabaId}/subscribed_apps`;
    const subscribeRes = await fetch(subscribeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    const subscribeData = (await subscribeRes.json().catch(() => ({}))) as any;
    if (!subscribeRes.ok && !subscribeData?.success) {
      console.warn(
        `[Embedded Signup] WABA webhook subscription notice:`,
        subscribeData?.error?.message || subscribeData,
      );
    } else {
      console.info(
        `[Embedded Signup] Successfully subscribed webhook to WABA: ${resolvedWabaId}`,
      );
    }
  } catch (subErr) {
    console.warn("[Embedded Signup] Error subscribing WABA to app:", subErr);
  }

  // ── Step C: Register Phone Number for Cloud API messaging ────────────────────
  try {
    const registerUrl = `https://graph.facebook.com/${graphVersion}/${resolvedPhoneNumberId}/register`;
    const registerRes = await fetch(registerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin: "123456",
      }),
    });
    const registerData = (await registerRes.json().catch(() => ({}))) as any;
    const isAlreadyRegistered =
      registerData?.error?.error_subcode === 133010 ||
      registerData?.error?.message?.toLowerCase().includes("already registered");

    if (!registerRes.ok && !registerData?.success && !isAlreadyRegistered) {
      console.warn(
        `[Embedded Signup] Phone number register notice:`,
        registerData?.error?.message || registerData,
      );
    } else {
      console.info(
        `[Embedded Signup] Phone number ${resolvedPhoneNumberId} registered successfully for Cloud API.`,
      );
    }
  } catch (regErr) {
    console.warn("[Embedded Signup] Error registering phone number:", regErr);
  }

  // ── Step D: Fetch Phone Details & Save in MongoDB ────────────────────────────
  let displayPhoneNumber = "Unknown";
  let verifiedName = "WhatsApp Business";

  try {
    const detailsUrl = `https://graph.facebook.com/${graphVersion}/${resolvedPhoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`;
    const detailsRes = await fetch(detailsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const detailsData = (await detailsRes.json().catch(() => ({}))) as any;
    if (detailsData?.display_phone_number) {
      displayPhoneNumber = detailsData.display_phone_number;
    }
    if (detailsData?.verified_name) {
      verifiedName = detailsData.verified_name;
    }
  } catch (detailErr) {
    console.warn("[Embedded Signup] Error fetching phone details:", detailErr);
  }

  // If verifiedName is still generic, attempt to fetch WABA name
  if (verifiedName === "WhatsApp Business") {
    try {
      const wabaUrl = `https://graph.facebook.com/${graphVersion}/${resolvedWabaId}?fields=id,name`;
      const wabaRes = await fetch(wabaUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      const wabaData = (await wabaRes.json().catch(() => ({}))) as any;
      if (wabaData?.name) {
        verifiedName = wabaData.name;
      }
    } catch {
      // ignore
    }
  }

  const encryptedToken = encrypt(accessToken);
  const targetWorkspaceId = new Types.ObjectId(workspaceId);

  // Check if account already exists for this phone number or WABA
  let account = await WhatsAppAccount.findOne({
    $or: [
      { phoneNumberId: resolvedPhoneNumberId },
      {
        workspaceId: targetWorkspaceId,
        businessAccountId: resolvedWabaId,
      },
    ],
  });

  if (account) {
    account.workspaceId = targetWorkspaceId;
    account.businessName = verifiedName;
    account.businessAccountId = resolvedWabaId;
    account.phoneNumberId = resolvedPhoneNumberId;
    account.displayPhoneNumber =
      displayPhoneNumber !== "Unknown"
        ? displayPhoneNumber
        : account.displayPhoneNumber;
    account.accessTokenEncrypted = encryptedToken;
    account.status = "CONNECTED";
    account.webhookVerified = true;
    account.connectedAt = new Date();
    await account.save();
  } else {
    account = await WhatsAppAccount.create({
      workspaceId: targetWorkspaceId,
      businessName: verifiedName,
      businessAccountId: resolvedWabaId,
      phoneNumberId: resolvedPhoneNumberId,
      displayPhoneNumber,
      accessTokenEncrypted: encryptedToken,
      status: "CONNECTED",
      webhookVerified: true,
      connectedAt: new Date(),
    });
  }

  console.info(
    `[Embedded Signup] Successfully connected WABA ${resolvedWabaId} (${displayPhoneNumber}) to workspace ${workspaceId}`,
  );

  return sanitizeAccount(account);
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

export async function getWhatsAppAccountByPhoneNumberId(phoneNumberId: string) {
  if (!phoneNumberId?.trim()) {
    return null;
  }

  const account = await WhatsAppAccount.findOne({
    phoneNumberId: phoneNumberId.trim(),
    status: "CONNECTED",
  })
    .select("_id workspaceId phoneNumberId businessAccountId status")
    .lean();

  if (!account) {
    return null;
  }

  return {
    accountId: account._id.toString(),
    workspaceId: account.workspaceId.toString(),
    phoneNumberId: account.phoneNumberId,
    businessAccountId: account.businessAccountId,
  };
}

// ─── Webhook verification ─────────────────────────────────────────────────────

// export async function markWebhookVerified(phoneNumberId: string) {
//   const account = await WhatsAppAccount.findOneAndUpdate(
//     { phoneNumberId },
//     { webhookVerified: true, status: "CONNECTED", connectedAt: new Date() },
//     { new: true },
//   );

//   console.log("Marking webhook as verified for phone number:", account);

//   return account ? sanitizeAccount(account) : null;
// }

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

  const accounts = await WhatsAppAccount.find({
    workspaceId: targetWorkspaceId,
  })
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

  const [totalAccounts, connectedAccounts, webhookVerified] = await Promise.all(
    [
      WhatsAppAccount.countDocuments({ workspaceId: targetWorkspaceId }),
      WhatsAppAccount.countDocuments({
        workspaceId: targetWorkspaceId,
        status: "CONNECTED",
      }),
      getPlatformWebhookVerificationStatus(),
    ],
  );

  // ✅ প্ল্যাটফর্ম রেকর্ডে true থাকলে true, অথবা কোনো অ্যাকাউন্ট সক্রিয়ভাবে কানেক্টেড থাকলে true
  const isVerified = webhookVerified || connectedAccounts > 0;

  // console.log('webhookVerified', webhookVerified);

  return {
    metaApp: {
      configured: whatsappConfig.isMetaAppConfigured,
    },
    webhook: {
      configured: whatsappConfig.isWebhookConfigured,
      verified: isVerified,
      callbackUrl: whatsappConfig.publicWebhookUrl,
    },
    workspaceAccount: {
      totalAccounts,
      connectedAccounts,
    },
  };
}
