/**
 * Resolves the public HTTPS callback URL for Meta webhooks.
 *
 * Rules:
 * 1. Prefer explicit WEBHOOK_PUBLIC_URL.
 * 2. Otherwise construct from PUBLIC_API_URL.
 * 3. Never return localhost, 127.0.0.1, ::1, or plain http as a valid public callback URL.
 * 4. Return null if no valid public HTTPS URL is configured.
 * 5. Webhook callback path must match actual registered backend route (/api/whatsapp/webhook).
 */
export function resolvePublicWebhookUrl(): string | null {
  const explicitWebhook = process.env.WEBHOOK_PUBLIC_URL?.trim();
  const publicApi = process.env.PUBLIC_API_URL?.trim();

  let candidateUrl: string | null = null;

  if (explicitWebhook) {
    candidateUrl = explicitWebhook;
  } else if (publicApi) {
    const cleanBase = publicApi.replace(/\/+$/, "");
    if (cleanBase.endsWith("/api")) {
      candidateUrl = `${cleanBase}/whatsapp/webhook`;
    } else {
      candidateUrl = `${cleanBase}/api/whatsapp/webhook`;
    }
  }

  if (!candidateUrl) {
    return null;
  }

  try {
    const parsed = new URL(candidateUrl);
    const isHttps = parsed.protocol === "https:";
    const hostname = parsed.hostname.toLowerCase();
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost");

    if (!isHttps || isLocalhost) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export const whatsappConfig = {
  get appId(): string {
    return process.env.META_APP_ID?.trim() || "";
  },

  get appSecret(): string {
    return process.env.META_APP_SECRET?.trim() || "";
  },

  get graphApiVersion(): string {
    return process.env.META_GRAPH_API_VERSION?.trim() || "v26.0";
  },

  get webhookVerifyToken(): string {
    return process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || "";
  },

  get graphApiBaseUrl(): string {
    return `https://graph.facebook.com/${this.graphApiVersion}`;
  },

  get isMetaAppConfigured(): boolean {
    return Boolean(
      process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim(),
    );
  },

  get isWebhookConfigured(): boolean {
    return Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN?.trim());
  },

  get publicWebhookUrl(): string | null {
    return resolvePublicWebhookUrl();
  },
};
