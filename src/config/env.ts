import { z } from "zod";

interface EnvironmentIssue {
  path: string;
  message: string;
}

export class EnvironmentConfigurationError extends Error {
  public readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[]) {
    const details = issues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n");

    super(`Invalid environment configuration:\n${details}`);

    this.name = "EnvironmentConfigurationError";
    this.issues = issues;
  }
}

function booleanFromEnv(defaultValue: boolean, name: string) {
  return z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value, ctx) => {
      if (
        value === undefined ||
        (typeof value === "string" && value.trim() === "")
      ) {
        return defaultValue;
      }

      if (typeof value === "boolean") {
        return value;
      }

      const normalized = value.trim().toLowerCase();

      if (normalized === "true") {
        return true;
      }

      if (normalized === "false") {
        return false;
      }

      ctx.addIssue({
        code: "custom",
        message: `${name} must be either "true" or "false"`,
      });

      return z.NEVER;
    });
}

function positiveIntegerFromEnv(defaultValue: number, name: string) {
  return z
    .union([z.string(), z.number()])
    .optional()
    .transform((value, ctx) => {
      if (
        value === undefined ||
        (typeof value === "string" && value.trim() === "")
      ) {
        return defaultValue;
      }

      const candidate =
        typeof value === "number" ? value : Number(value.trim());

      if (
        !Number.isInteger(candidate) ||
        candidate <= 0 ||
        (typeof value === "string" && !/^\d+$/.test(value.trim()))
      ) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a positive integer`,
        });

        return z.NEVER;
      }

      return candidate;
    });
}

export const campaignEnvSchema = z.object({
  CAMPAIGN_EXECUTION_ENABLED: booleanFromEnv(
    false,
    "CAMPAIGN_EXECUTION_ENABLED",
  ),
  CAMPAIGN_SCHEDULER_INTERVAL_MS: positiveIntegerFromEnv(
    15000,
    "CAMPAIGN_SCHEDULER_INTERVAL_MS",
  ),
  CAMPAIGN_PAGE_SIZE: positiveIntegerFromEnv(100, "CAMPAIGN_PAGE_SIZE"),
  CAMPAIGN_SEND_CONCURRENCY: positiveIntegerFromEnv(
    5,
    "CAMPAIGN_SEND_CONCURRENCY",
  ),
  CAMPAIGN_DISPATCH_CONCURRENCY: positiveIntegerFromEnv(
    2,
    "CAMPAIGN_DISPATCH_CONCURRENCY",
  ),
  CAMPAIGN_MAX_ATTEMPTS: positiveIntegerFromEnv(3, "CAMPAIGN_MAX_ATTEMPTS"),
  CAMPAIGN_RETRY_DELAY_MS: positiveIntegerFromEnv(
    5000,
    "CAMPAIGN_RETRY_DELAY_MS",
  ),
  CAMPAIGN_LEASE_DURATION_MS: positiveIntegerFromEnv(
    60000,
    "CAMPAIGN_LEASE_DURATION_MS",
  ),
  CAMPAIGN_HEARTBEAT_INTERVAL_MS: positiveIntegerFromEnv(
    15000,
    "CAMPAIGN_HEARTBEAT_INTERVAL_MS",
  ),
  CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS: positiveIntegerFromEnv(
    30000,
    "CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS",
  ),
});

export type CampaignEnvironment = z.infer<typeof campaignEnvSchema>;

function toEnvironmentIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): EnvironmentIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "environment",
    message: issue.message,
  }));
}

export function loadCampaignEnv(
  source: NodeJS.ProcessEnv = process.env,
): CampaignEnvironment {
  const result = campaignEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentConfigurationError(
      toEnvironmentIssues(result.error.issues),
    );
  }

  return result.data;
}

const redisUrlSchema = z
  .string()
  .trim()
  .min(1, "REDIS_URL is required to initialize Redis")
  .superRefine((value, ctx) => {
    let parsed: URL;

    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "REDIS_URL must be a valid redis:// or rediss:// URL",
      });
      return;
    }

    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      ctx.addIssue({
        code: "custom",
        message: "REDIS_URL must use the redis:// or rediss:// protocol",
      });
    }
  });

export function loadRedisUrl(
  source: NodeJS.ProcessEnv = process.env,
): string {
  const rawValue = source.REDIS_URL;

  if (rawValue === undefined || rawValue.trim() === "") {
    throw new EnvironmentConfigurationError([
      {
        path: "REDIS_URL",
        message: "REDIS_URL is required to initialize Redis",
      },
    ]);
  }

  const result = redisUrlSchema.safeParse(rawValue);

  if (!result.success) {
    throw new EnvironmentConfigurationError(
      toEnvironmentIssues(result.error.issues).map((issue) => ({
        path: "REDIS_URL",
        message: issue.message,
      })),
    );
  }

  return result.data;
}
