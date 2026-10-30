import { AppError } from "../../utils/app-error.js";
import { decrypt } from "../../utils/encryption.js";
import { whatsappConfig } from "../config/whatsapp.config.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";

interface WhatsAppApiOptions {
  phoneNumberId: string;
  accessToken: string;
  endpoint: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

interface WhatsAppApiResponse {
  [key: string]: unknown;
}

export async function makeWhatsAppApiRequest({
  phoneNumberId,
  accessToken,
  endpoint,
  method = "POST",
  body,
}: WhatsAppApiOptions): Promise<WhatsAppApiResponse> {
  const url = `${whatsappConfig.graphApiBaseUrl}/${phoneNumberId}/${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AppError("Unable to communicate with WhatsApp API", 502);
  }

  if (!data || typeof data !== "object") {
    throw new AppError("Invalid WhatsApp API response", 502);
  }

  return data as WhatsAppApiResponse;
}

export async function verifyWhatsAppCredentials(
  phoneNumberId: string,
  accessToken: string,
): Promise<WhatsAppApiResponse> {
  return makeWhatsAppApiRequest({
    phoneNumberId,
    accessToken,
    endpoint: "",
    method: "GET",
  });
}

export async function makeWorkspaceWhatsAppRequest(
  workspaceId: string,
  phoneNumberId: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<WhatsAppApiResponse> {
  const account = await WhatsAppAccount.findOne({
    workspaceId,
    phoneNumberId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (!account) {
    throw new AppError("WhatsApp account not found or disconnected", 404);
  }

  const accessToken = decrypt(account.accessTokenEncrypted);

  return makeWhatsAppApiRequest({
    phoneNumberId: account.phoneNumberId,
    accessToken,
    endpoint,
    body,
  });
}
