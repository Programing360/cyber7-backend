import { AppError } from "../../utils/app-error.js";
import { decrypt } from "../../utils/encryption.js";
import { whatsappConfig } from "../config/whatsapp.config.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";

export interface WhatsAppApiOptions {
  /**
   * The Graph API node ID (e.g. Phone Number ID, WABA ID, Message ID).
   * Supports phoneNumberId as an alias for backward compatibility.
   */
  nodeId?: string;
  phoneNumberId?: string;
  endpoint?: string;
  method?: "GET" | "POST" | "DELETE";
  queryParams?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  accessToken: string;
  timeoutMs?: number;
}

export interface WhatsAppApiResponse {
  [key: string]: unknown;
}

export interface WhatsAppPhoneNumberDetails {
  id: string;
  displayPhoneNumber: string;
  verifiedName?: string;
  qualityRating?: string;
  codeVerificationStatus?: string;
  whatsappBusinessAccountId?: string;
}

export interface WhatsAppBusinessAccountDetails {
  id: string;
  name?: string;
  timezoneId?: string;
  currency?: string;
}

interface MetaRawErrorPayload {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

/**
 * Maps Meta Graph API error codes into safe, sanitized client-facing AppErrors.
 * Internal Meta details, tokens, and trace parameters are never exposed.
 */
export function mapMetaApiError(
  status: number,
  errorData?: MetaRawErrorPayload | null,
): AppError {
  const code = errorData?.code;
  const subcode = errorData?.error_subcode;
  const msg = errorData?.message?.toLowerCase() || "";

  // 1. Expired token (code 190 with expiry subcodes 463, 467 or message indicator)
  if (
    code === 190 &&
    (subcode === 463 || subcode === 467 || msg.includes("expire"))
  ) {
    return new AppError(
      "WhatsApp access token has expired. Please generate a new token or re-authenticate.",
      401,
    );
  }

  // 2. Invalid or revoked token (code 190)
  if (code === 190 || msg.includes("oauth") || msg.includes("access token")) {
    return new AppError(
      "Invalid WhatsApp access token. Please verify your credentials.",
      401,
    );
  }

  // 3. Insufficient permissions (code 10, 200, or permission subcodes)
  if (
    code === 10 ||
    code === 200 ||
    msg.includes("permission") ||
    msg.includes("privilege")
  ) {
    return new AppError(
      "WhatsApp access token does not have the required permissions for this action.",
      403,
    );
  }

  // 4. Rate limit (codes 4, 17, 32, 613, 80004)
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    code === 80004 ||
    msg.includes("rate limit") ||
    status === 429
  ) {
    return new AppError(
      "WhatsApp API rate limit exceeded. Please try again later.",
      429,
    );
  }

  // 5. Unsupported / Non-existent node (code 100, 80007, or object does not exist)
  if (
    code === 100 ||
    code === 80007 ||
    msg.includes("does not exist") ||
    msg.includes("cannot be loaded") ||
    msg.includes("unsupported")
  ) {
    if (msg.includes("business") || msg.includes("waba")) {
      return new AppError(
        "Invalid WhatsApp Business Account ID. Please verify the WABA ID in your Meta Business Manager.",
        400,
      );
    }
    return new AppError(
      "Invalid WhatsApp Phone Number ID or identifier. Please verify your configuration in Meta Developer Console.",
      400,
    );
  }

  // 6. Temporary Meta server failure (5xx or codes 1, 2)
  if (status >= 500 || code === 1 || code === 2) {
    return new AppError(
      "Meta WhatsApp service is temporarily unavailable. Please try again shortly.",
      502,
    );
  }

  // 7. General fallback
  return new AppError(
    "Unable to communicate with WhatsApp API. Please verify your configuration.",
    502,
  );
}

/**
 * Universal Graph API Request Client.
 *
 * Supports arbitrary Graph API resources (Phone Number IDs, WABA IDs, Node IDs),
 * clean URL pathing without trailing slashes, structured query parameters,
 * and sanitized diagnostic logging that never leaks access tokens.
 */
export async function makeWhatsAppApiRequest(
  options: WhatsAppApiOptions,
): Promise<WhatsAppApiResponse> {
  const targetNodeId = options.nodeId || options.phoneNumberId;

  if (!targetNodeId || !targetNodeId.trim()) {
    throw new AppError("A valid Graph API node ID or phone number ID is required", 400);
  }

  // Clean path resolution without trailing or double slashes
  let path = `${whatsappConfig.graphApiBaseUrl}/${targetNodeId.trim()}`;
  if (options.endpoint && options.endpoint.trim()) {
    const cleanEndpoint = options.endpoint.trim().replace(/^\/+/, "");
    path = `${path}/${cleanEndpoint}`;
  }

  // Append query parameters cleanly
  if (options.queryParams && typeof options.queryParams === "object") {
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(options.queryParams)) {
      if (val !== undefined && val !== null) {
        params.append(key, String(val));
      }
    }
    const qs = params.toString();
    if (qs) {
      path = `${path}?${qs}`;
    }
  }

  const method = options.method ?? "POST";
  let response: Response;

  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
      ...(method !== "GET" && options.body
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    if (isTimeout) {
      throw new AppError(
        "WhatsApp API request timed out. Please try again.",
        504,
      );
    }
    throw new AppError(
      "Network error while connecting to Meta WhatsApp API. Please verify connectivity.",
      502,
    );
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errorData = data as { error?: MetaRawErrorPayload } | null;

    // Safe diagnostic logging: NEVER log authorization headers, tokens, or body payloads
    console.error("[WhatsApp API Error]", {
      status: response.status,
      code: errorData?.error?.code,
      subcode: errorData?.error?.error_subcode,
      type: errorData?.error?.type,
      fbtrace_id: errorData?.error?.fbtrace_id,
    });

    throw mapMetaApiError(response.status, errorData?.error);
  }

  if (!data || typeof data !== "object") {
    throw new AppError("Invalid or empty response from WhatsApp API", 502);
  }

  return data as WhatsAppApiResponse;
}

/**
 * Retrieves and validates WhatsApp Phone Number details from Meta.
 */
export async function verifyWhatsAppCredentials(
  phoneNumberId: string,
  accessToken: string,
): Promise<WhatsAppPhoneNumberDetails> {
  const data = await makeWhatsAppApiRequest({
    nodeId: phoneNumberId,
    accessToken,
    method: "GET",
    queryParams: {
      fields:
        "id,display_phone_number,verified_name,quality_rating,code_verification_status",
    },
  });

  const id = typeof data.id === "string" ? data.id : undefined;
  if (!id || id !== phoneNumberId) {
    throw new AppError(
      "WhatsApp Phone Number ID verification failed. ID does not match.",
      400,
    );
  }

  const displayPhoneNumber =
    typeof data.display_phone_number === "string" ? data.display_phone_number : "";

  const verifiedName =
    typeof data.verified_name === "string" ? data.verified_name : undefined;

  const qualityRating =
    typeof data.quality_rating === "string" ? data.quality_rating : undefined;

  const codeVerificationStatus =
    typeof data.code_verification_status === "string"
      ? data.code_verification_status
      : undefined;

  return {
    id,
    displayPhoneNumber,
    verifiedName,
    qualityRating,
    codeVerificationStatus,
  };
}

/**
 * Validates a WhatsApp Business Account ID (WABA) through Meta Graph API.
 */
export async function verifyWhatsAppBusinessAccount(
  businessAccountId: string,
  accessToken: string,
): Promise<WhatsAppBusinessAccountDetails> {
  const data = await makeWhatsAppApiRequest({
    nodeId: businessAccountId,
    accessToken,
    method: "GET",
    queryParams: {
      fields: "id,name,timezone_id,currency",
    },
  });

  const id = typeof data.id === "string" ? data.id : undefined;
  if (!id || id !== businessAccountId) {
    throw new AppError(
      "WhatsApp Business Account ID verification failed. ID does not match.",
      400,
    );
  }

  return {
    id,
    name: typeof data.name === "string" ? data.name : undefined,
    timezoneId: typeof data.timezone_id === "string" ? data.timezone_id : undefined,
    currency: typeof data.currency === "string" ? data.currency : undefined,
  };
}

/**
 * Verifies whether a given Phone Number ID belongs to a WABA by inspecting the WABA's phone_numbers edge.
 */
export async function verifyPhoneNumberInWaba(
  businessAccountId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<boolean> {
  const data = await makeWhatsAppApiRequest({
    nodeId: businessAccountId,
    endpoint: "phone_numbers",
    accessToken,
    method: "GET",
    queryParams: {
      fields: "id",
    },
  });

  const phones = (data.data as Array<{ id?: string }>) || [];
  return phones.some((p) => p.id === phoneNumberId);
}

/**
 * Helper to execute a workspace-scoped WhatsApp API request by phone number ID.
 */
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
    nodeId: account.phoneNumberId,
    accessToken,
    endpoint,
    body,
    method: "POST",
  });
}
