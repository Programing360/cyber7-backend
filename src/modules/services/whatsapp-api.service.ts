import { AppError } from "../../utils/app-error.js";
import { decrypt } from "../../utils/encryption.js";
import { whatsappConfig } from "../config/whatsapp.config.js";
import WhatsAppAccount from "../whatsapp/whatsapp.model.js";

export interface WhatsAppApiOptions {
  /**
   * Graph API node ID (Phone Number ID, WABA ID, etc.).
   * phoneNumberId remains supported for backward compatibility.
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

interface MetaPhoneNumberPage {
  data?: Array<{ id?: string }>;
  paging?: {
    cursors?: {
      after?: string;
    };
    next?: string;
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_WABA_PAGES = 100;

const GRAPH_NODE_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const GRAPH_ENDPOINT_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;
const GRAPH_VERSION_REGEX = /^v\d+\.\d+$/;

function normalizeAccessToken(accessToken: string): string {
  if (typeof accessToken !== "string") {
    throw new AppError("WhatsApp access token is required.", 401);
  }

  const normalized = accessToken.trim();

  if (!normalized || normalized.length > 8192) {
    throw new AppError("WhatsApp access token is invalid.", 401);
  }

  return normalized;
}

function validateNodeId(nodeId: string): string {
  const normalized = nodeId.trim();

  if (
    !normalized ||
    normalized.length > 256 ||
    !GRAPH_NODE_ID_REGEX.test(normalized)
  ) {
    throw new AppError("A valid Graph API node ID is required.", 400);
  }

  return normalized;
}

function validateEndpoint(endpoint?: string): string {
  if (endpoint === undefined) {
    return "";
  }

  const normalized = endpoint.trim().replace(/^\/+|\/+$/g, "");

  if (!normalized) {
    return "";
  }

  // Only allow simple Graph API path segments.
  // Reject query strings, fragments, encoded paths and traversal.
  const segments = normalized.split("/");

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !GRAPH_ENDPOINT_SEGMENT_REGEX.test(segment),
    )
  ) {
    throw new AppError("Invalid WhatsApp API endpoint.", 400);
  }

  return segments.join("/");
}

function validateTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new AppError("Invalid WhatsApp API timeout configuration.", 400);
  }

  return timeoutMs;
}

function buildGraphApiBaseUrl(): URL {
  const version = whatsappConfig.graphApiVersion;

  if (!GRAPH_VERSION_REGEX.test(version)) {
    throw new AppError("Invalid Meta Graph API version configuration.", 500);
  }

  const baseUrl = new URL(whatsappConfig.graphApiBaseUrl);

  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== "graph.facebook.com" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new AppError("Invalid Meta Graph API base URL configuration.", 500);
  }

  return baseUrl;
}

function buildGraphApiUrl(
  nodeId: string,
  endpoint?: string,
  queryParams?: WhatsAppApiOptions["queryParams"],
): URL {
  const baseUrl = buildGraphApiBaseUrl();
  const cleanEndpoint = validateEndpoint(endpoint);

  const path = [
    baseUrl.pathname.replace(/\/+$/, ""),
    encodeURIComponent(nodeId),
    cleanEndpoint,
  ]
    .filter(Boolean)
    .join("/");

  const url = new URL(path, baseUrl.origin);

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value === undefined) {
        continue;
      }

      if (
        !/^[A-Za-z0-9_]+$/.test(key) ||
        key.toLowerCase() === "access_token" ||
        key.toLowerCase() === "appsecret_proof"
      ) {
        throw new AppError("Invalid WhatsApp API query parameter.", 400);
      }

      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new AppError("Invalid WhatsApp API query parameter value.", 400);
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

/**
 * Maps Meta Graph API errors into sanitized application errors.
 * Raw Meta error messages and tokens are never returned to clients.
 */
export function mapMetaApiError(
  status: number,
  errorData?: MetaRawErrorPayload | null,
): AppError {
  const code = errorData?.code;
  const subcode = errorData?.error_subcode;
  const message = errorData?.message?.toLowerCase() || "";

  // Invalid, expired or revoked token.
  if (code === 190) {
    if (subcode === 463 || subcode === 467 || message.includes("expire")) {
      return new AppError(
        "WhatsApp access token has expired. Please reconnect your WhatsApp account.",
        401,
        "WHATSAPP_TOKEN_EXPIRED",
      );
    }

    return new AppError(
      "Invalid WhatsApp access token. Please verify your credentials.",
      401,
      "WHATSAPP_TOKEN_INVALID",
    );
  }

  // Customer service window expired.
  if (
    code === 131047 ||
    subcode === 2494010 ||
    message.includes("24 hour") ||
    message.includes("customer service window") ||
    message.includes("re-engagement")
  ) {
    return new AppError(
      "The 24-hour customer service window has expired. Use an approved template message.",
      422,
      "CUSTOMER_SERVICE_WINDOW_EXPIRED",
    );
  }

  // Invalid or undeliverable recipient.
  if (
    code === 131026 ||
    code === 131030 ||
    message.includes("not a valid whatsapp") ||
    message.includes("undeliverable")
  ) {
    return new AppError(
      "The recipient phone number is invalid or cannot receive WhatsApp messages.",
      400,
      "RECIPIENT_UNDELIVERABLE",
    );
  }

  // Template errors.
  if (
    code === 132000 ||
    code === 132001 ||
    code === 132015 ||
    code === 132016 ||
    (code === 100 &&
      (message.includes("template") || message.includes("component")))
  ) {
    return new AppError(
      "WhatsApp template error. Verify the template and its parameters.",
      400,
      "INVALID_TEMPLATE_PARAMETERS",
    );
  }

  // Rate limits.
  if (
    status === 429 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    code === 80004 ||
    code === 80007 ||
    message.includes("rate limit")
  ) {
    return new AppError(
      "WhatsApp API rate limit exceeded. Please try again later.",
      429,
      "WHATSAPP_RATE_LIMIT",
    );
  }

  // Object/node lookup errors.
  if (
    subcode === 33 ||
    message.includes("does not exist") ||
    message.includes("cannot be loaded") ||
    message.includes("unsupported get request") ||
    message.includes("object with id")
  ) {
    if (message.includes("business") || message.includes("waba")) {
      return new AppError(
        "Invalid WhatsApp Business Account ID. Verify your WABA configuration.",
        400,
        "INVALID_WABA_ID",
      );
    }

    return new AppError(
      "Invalid WhatsApp Graph API node ID. Verify your Meta configuration.",
      400,
      "INVALID_GRAPH_NODE_ID",
    );
  }

  // Permission errors.
  if (
    code === 10 ||
    code === 200 ||
    message.includes("permission") ||
    message.includes("privilege")
  ) {
    return new AppError(
      "WhatsApp access token does not have the required permissions.",
      403,
      "WHATSAPP_PERMISSION_DENIED",
    );
  }

  // Invalid recipient parameter.
  if (
    message.includes("parameter to") ||
    message.includes("param to") ||
    message.includes("recipient phone number")
  ) {
    return new AppError(
      "Invalid or missing recipient WhatsApp phone number.",
      400,
      "INVALID_RECIPIENT_PHONE",
    );
  }

  // Generic invalid parameter.
  if (code === 100) {
    return new AppError(
      "Invalid request parameter sent to WhatsApp API.",
      400,
      "WHATSAPP_INVALID_PARAMETER",
    );
  }

  // Temporary Meta failures.
  if (status >= 500 || code === 1 || code === 2) {
    return new AppError(
      "Meta WhatsApp service is temporarily unavailable. Please try again later.",
      502,
      "WHATSAPP_PROVIDER_UNAVAILABLE",
    );
  }

  if (status >= 400 && status < 500) {
    return new AppError(
      "WhatsApp API rejected the request. Verify the request configuration.",
      status,
      "WHATSAPP_REQUEST_REJECTED",
    );
  }

  return new AppError(
    "Unable to communicate with WhatsApp API.",
    502,
    "WHATSAPP_API_ERROR",
  );
}

/**
 * Universal Graph API request client.
 */
export async function makeWhatsAppApiRequest(
  options: WhatsAppApiOptions,
): Promise<WhatsAppApiResponse> {
  const rawNodeId = options.nodeId || options.phoneNumberId;

  if (!rawNodeId || typeof rawNodeId !== "string") {
    throw new AppError(
      "A valid Graph API node ID or phone number ID is required.",
      400,
    );
  }

  const nodeId = validateNodeId(rawNodeId);
  const accessToken = normalizeAccessToken(options.accessToken);
  const timeoutMs = validateTimeout(options.timeoutMs);
  const method = options.method ?? "POST";

  const url = buildGraphApiUrl(nodeId, options.endpoint, options.queryParams);

  let response: globalThis.Response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(method !== "GET" && options.body
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(method !== "GET" && options.body
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: AbortSignal.timeout(timeoutMs),
      // Prevent forwarding credentials through unexpected redirects.
      redirect: "error",
    });
  } catch (error: unknown) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");

    if (isTimeout) {
      throw new AppError(
        "WhatsApp API request timed out. Please try again.",
        504,
        "WHATSAPP_API_TIMEOUT",
      );
    }

    throw new AppError(
      "Network error while connecting to Meta WhatsApp API.",
      502,
      "WHATSAPP_NETWORK_ERROR",
    );
  }

  const responseData: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedData =
      responseData && typeof responseData === "object"
        ? (responseData as { error?: MetaRawErrorPayload })
        : null;

    const metaError = parsedData?.error;

    // Only non-secret diagnostic identifiers are logged.
    console.error("[WhatsApp API Error]", {
      status: response.status,
      code: metaError?.code,
      subcode: metaError?.error_subcode,
      type: metaError?.type,
      fbtraceId: metaError?.fbtrace_id,
    });

    throw mapMetaApiError(response.status, metaError);
  }

  if (
    !responseData ||
    typeof responseData !== "object" ||
    Array.isArray(responseData)
  ) {
    throw new AppError(
      "Invalid or empty response from WhatsApp API.",
      502,
      "WHATSAPP_INVALID_RESPONSE",
    );
  }

  return responseData as WhatsAppApiResponse;
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
      "PHONE_NUMBER_ID_MISMATCH",
    );
  }

  return {
    id,
    displayPhoneNumber:
      typeof data.display_phone_number === "string"
        ? data.display_phone_number
        : "",
    verifiedName:
      typeof data.verified_name === "string" ? data.verified_name : undefined,
    qualityRating:
      typeof data.quality_rating === "string" ? data.quality_rating : undefined,
    codeVerificationStatus:
      typeof data.code_verification_status === "string"
        ? data.code_verification_status
        : undefined,
  };
}

/**
 * Validates a WhatsApp Business Account ID through Meta Graph API.
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
      "WABA_ID_MISMATCH",
    );
  }

  return {
    id,
    name: typeof data.name === "string" ? data.name : undefined,
    timezoneId:
      typeof data.timezone_id === "string" ? data.timezone_id : undefined,
    currency: typeof data.currency === "string" ? data.currency : undefined,
  };
}

/**
 * Verifies whether a Phone Number ID belongs to a WABA.
 *
 * Follows Graph API cursor pagination instead of checking only
 * the first page of phone_numbers.
 */
export async function verifyPhoneNumberInWaba(
  businessAccountId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<boolean> {
  let after: string | undefined;
  const seenCursors = new Set<string>();

  for (let page = 0; page < MAX_WABA_PAGES; page += 1) {
    const queryParams: Record<string, string | number | boolean | undefined> = {
      fields: "id",
      limit: 100,
      after,
    };

    const data = await makeWhatsAppApiRequest({
      nodeId: businessAccountId,
      endpoint: "phone_numbers",
      accessToken,
      method: "GET",
      queryParams,
    });

    const phones = Array.isArray(data.data)
      ? (data.data as Array<{ id?: string }>)
      : [];

    if (phones.some((phone) => phone.id === phoneNumberId)) {
      return true;
    }

    const paging = data.paging as MetaPhoneNumberPage["paging"] | undefined;

    const nextCursor = paging?.cursors?.after;

    if (!paging?.next) {
      return false;
    }

    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new AppError(
        "Unable to safely continue WhatsApp Business Account pagination.",
        502,
        "WABA_PAGINATION_ERROR",
      );
    }

    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  throw new AppError(
    "WhatsApp Business Account contains too many phone-number pages to verify safely.",
    502,
    "WABA_PAGINATION_LIMIT",
  );
}

/**
 * Subscribes the Meta App to a WhatsApp Business Account.
 */
export async function subscribeWabaToMetaApp(
  businessAccountId: string,
  accessToken: string,
): Promise<boolean> {
  const data = await makeWhatsAppApiRequest({
    nodeId: businessAccountId,
    endpoint: "subscribed_apps",
    method: "POST",
    accessToken,
  });

  return data.success === true;
}

/**
 * Executes a workspace-scoped WhatsApp API request.
 *
 * The token is always loaded from the connected account's encrypted
 * database field. Client-provided tokens are never accepted here.
 */
export async function makeWorkspaceWhatsAppRequest(
  workspaceId: string,
  phoneNumberId: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<WhatsAppApiResponse> {
  if (
    typeof workspaceId !== "string" ||
    !workspaceId.trim() ||
    typeof phoneNumberId !== "string" ||
    !phoneNumberId.trim()
  ) {
    throw new AppError(
      "Valid workspace and WhatsApp phone number IDs are required.",
      400,
    );
  }

  const account = await WhatsAppAccount.findOne({
    workspaceId,
    phoneNumberId,
    status: "CONNECTED",
  }).select("+accessTokenEncrypted");

  if (!account || !account.accessTokenEncrypted) {
    throw new AppError(
      "WhatsApp account not found or disconnected.",
      404,
      "WHATSAPP_ACCOUNT_NOT_CONNECTED",
    );
  }

  let accessToken: string;

  try {
    accessToken = decrypt(account.accessTokenEncrypted);
  } catch {
    throw new AppError(
      "Unable to decrypt the connected WhatsApp account credentials.",
      500,
      "WHATSAPP_CREDENTIAL_DECRYPTION_FAILED",
    );
  }

  if (!accessToken?.trim()) {
    throw new AppError(
      "Connected WhatsApp account has invalid credentials.",
      401,
      "WHATSAPP_TOKEN_INVALID",
    );
  }

  return makeWhatsAppApiRequest({
    nodeId: account.phoneNumberId,
    accessToken,
    endpoint,
    body,
    method: "POST",
  });
}
