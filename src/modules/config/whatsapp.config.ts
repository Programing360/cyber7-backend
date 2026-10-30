function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} environment variable is missing`);
  }

  return value;
}

export const whatsappConfig = {
  appId: getRequiredEnv("META_APP_ID"),

  appSecret: getRequiredEnv("META_APP_SECRET"),

  graphApiVersion: getRequiredEnv("META_GRAPH_API_VERSION"),

  webhookVerifyToken: getRequiredEnv("META_WEBHOOK_VERIFY_TOKEN"),

  get graphApiBaseUrl(): string {
    return `https://graph.facebook.com/${this.graphApiVersion}`;
  },
};
