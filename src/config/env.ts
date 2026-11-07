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
        (typeof value === "string" &&
          (value.trim() === "" || value.trim().toLowerCase() === "undefined"))
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

/**
 * Redis client hardening configuration (SEC-02).
 *
 * Explicit, bounded timeouts are mandatory so a degraded Redis instance can
 * never leave a sensitive authentication request pending indefinitely.
 */
export const redisClientEnvSchema = z.object({
  REDIS_CONNECT_TIMEOUT_MS: positiveIntegerFromEnv(
    3000,
    "REDIS_CONNECT_TIMEOUT_MS",
  ),
  REDIS_COMMAND_TIMEOUT_MS: positiveIntegerFromEnv(
    2000,
    "REDIS_COMMAND_TIMEOUT_MS",
  ),
  REDIS_MAX_RETRIES_PER_REQUEST: positiveIntegerFromEnv(
    2,
    "REDIS_MAX_RETRIES_PER_REQUEST",
  ),
  REDIS_ENABLE_OFFLINE_QUEUE: booleanFromEnv(
    false,
    "REDIS_ENABLE_OFFLINE_QUEUE",
  ),
  REDIS_RATE_LIMIT_OPERATION_TIMEOUT_MS: positiveIntegerFromEnv(
    2000,
    "REDIS_RATE_LIMIT_OPERATION_TIMEOUT_MS",
  ),
});

export type RedisClientEnvironment = z.infer<typeof redisClientEnvSchema>;

export function loadRedisClientEnv(
  source: NodeJS.ProcessEnv = process.env,
): RedisClientEnvironment {
  const result = redisClientEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentConfigurationError(
      toEnvironmentIssues(result.error.issues),
    );
  }

  return result.data;
}

export const adminSessionEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: positiveIntegerFromEnv(
      15,
      "ADMIN_SESSION_IDLE_TIMEOUT_MINUTES",
    ),
    ADMIN_SESSION_ABSOLUTE_LIFETIME_HOURS: positiveIntegerFromEnv(
      8,
      "ADMIN_SESSION_ABSOLUTE_LIFETIME_HOURS",
    ),
    ADMIN_SESSION_COOKIE_NAME: z
      .string()
      .trim()
      .min(1, "ADMIN_SESSION_COOKIE_NAME must not be empty")
      .default("__Host-vexchat_admin_session"),
    ADMIN_SESSION_HEADER_NAME: z
      .string()
      .trim()
      .min(1, "ADMIN_SESSION_HEADER_NAME must not be empty")
      .default("x-admin-session-token"),
    ADMIN_REQUIRE_EMAIL_VERIFIED: booleanFromEnv(
      false,
      "ADMIN_REQUIRE_EMAIL_VERIFIED",
    ),
  })
  .superRefine((data, ctx) => {
    const isProduction =
      (data.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() === "production";
    if (isProduction && !data.ADMIN_SESSION_COOKIE_NAME.startsWith("__Host-")) {
      ctx.addIssue({
        code: "custom",
        path: ["ADMIN_SESSION_COOKIE_NAME"],
        message:
          "In production, ADMIN_SESSION_COOKIE_NAME must use the __Host- prefix (e.g. __Host-vexchat_admin_session)",
      });
    }

    if (isProduction && data.ADMIN_REQUIRE_EMAIL_VERIFIED !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["ADMIN_REQUIRE_EMAIL_VERIFIED"],
        message:
          "In production, ADMIN_REQUIRE_EMAIL_VERIFIED must be 'true'. Platform administrators must possess verified email addresses.",
      });
    }
  });

export type AdminSessionEnvironment = z.infer<typeof adminSessionEnvSchema>;

export function loadAdminSessionEnv(
  source: NodeJS.ProcessEnv = process.env,
): AdminSessionEnvironment {
  const result = adminSessionEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentConfigurationError(
      toEnvironmentIssues(result.error.issues),
    );
  }

  return result.data;
}

export const adminMfaEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    JWT_ACCESS_SECRET: z.string().optional(),
    WHATSAPP_ENCRYPTION_KEY: z.string().optional(),
    VEXCHAT_INTERNAL_WEBHOOK_SECRET: z.string().optional(),
    ADMIN_MFA_ENCRYPTION_KEY: z.string().trim().optional(),
    ADMIN_MFA_STEP_SECONDS: positiveIntegerFromEnv(30, "ADMIN_MFA_STEP_SECONDS"),
    ADMIN_MFA_DRIFT_WINDOWS: positiveIntegerFromEnv(1, "ADMIN_MFA_DRIFT_WINDOWS"),
    ADMIN_MFA_ENROLLMENT_EXPIRY_SECONDS: positiveIntegerFromEnv(
      900,
      "ADMIN_MFA_ENROLLMENT_EXPIRY_SECONDS",
    ),
    ADMIN_MFA_ISSUER: z
      .string()
      .trim()
      .min(1, "ADMIN_MFA_ISSUER must not be empty")
      .default("VexChat Platform"),
  })
  .superRefine((data, ctx) => {
    const isProduction =
      (data.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() === "production";

    const key = data.ADMIN_MFA_ENCRYPTION_KEY;

    if (isProduction) {
      if (!key || key.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_MFA_ENCRYPTION_KEY"],
          message:
            "In production, ADMIN_MFA_ENCRYPTION_KEY is required and must be exactly 64 hexadecimal characters (32 bytes).",
        });
        return;
      }
    }

    if (key !== undefined && key.length > 0) {
      if (key.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_MFA_ENCRYPTION_KEY"],
          message:
            "ADMIN_MFA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).",
        });
        return;
      }

      if (
        (data.JWT_ACCESS_SECRET && key === data.JWT_ACCESS_SECRET) ||
        (data.WHATSAPP_ENCRYPTION_KEY && key === data.WHATSAPP_ENCRYPTION_KEY) ||
        (data.VEXCHAT_INTERNAL_WEBHOOK_SECRET &&
          key === data.VEXCHAT_INTERNAL_WEBHOOK_SECRET)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_MFA_ENCRYPTION_KEY"],
          message:
            "ADMIN_MFA_ENCRYPTION_KEY must be distinct from JWT secrets, WhatsApp encryption keys, and webhook secrets.",
        });
      }
    }
  });

export type AdminMfaEnvironment = z.infer<typeof adminMfaEnvSchema> & {
  ADMIN_MFA_ENCRYPTION_KEY: string;
};

export const DEFAULT_DEV_MFA_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function loadAdminMfaEnv(
  source: NodeJS.ProcessEnv = process.env,
): AdminMfaEnvironment {
  const result = adminMfaEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentConfigurationError(
      toEnvironmentIssues(result.error.issues),
    );
  }

  const isProduction =
    (result.data.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() ===
    "production";

  let key = result.data.ADMIN_MFA_ENCRYPTION_KEY;
  if (!key) {
    if (isProduction) {
      throw new EnvironmentConfigurationError([
        {
          path: "ADMIN_MFA_ENCRYPTION_KEY",
          message:
            "In production, ADMIN_MFA_ENCRYPTION_KEY is required and cannot be omitted.",
        },
      ]);
    }
    key = DEFAULT_DEV_MFA_KEY;
  }

  return {
    ...result.data,
    ADMIN_MFA_ENCRYPTION_KEY: key,
  };
}

export const adminBffEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    JWT_ACCESS_SECRET: z.string().optional(),
    WHATSAPP_ENCRYPTION_KEY: z.string().optional(),
    VEXCHAT_INTERNAL_WEBHOOK_SECRET: z.string().optional(),
    ADMIN_MFA_ENCRYPTION_KEY: z.string().optional(),
    ADMIN_BFF_SECRET: z.string().trim().optional(),
    ADMIN_BFF_ISSUER: z.string().trim().min(1).default("vexchat-bff"),
    ADMIN_BFF_AUDIENCE: z.string().trim().min(1).default("vexchat-backend"),
    ADMIN_BFF_MAX_AGE_SECONDS: positiveIntegerFromEnv(60, "ADMIN_BFF_MAX_AGE_SECONDS"),
    PLATFORM_ADMIN_BOOTSTRAP_ENABLED: booleanFromEnv(false, "PLATFORM_ADMIN_BOOTSTRAP_ENABLED"),
    PLATFORM_ADMIN_BOOTSTRAP_SECRET: z.string().trim().optional(),
    PLATFORM_ADMIN_BOOTSTRAP_LEASE_MS: positiveIntegerFromEnv(
      60000,
      "PLATFORM_ADMIN_BOOTSTRAP_LEASE_MS",
    ),
  })
  .superRefine((data, ctx) => {
    const isProduction =
      (data.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() === "production";

    const bffSecret = data.ADMIN_BFF_SECRET;

    if (isProduction) {
      if (!bffSecret || bffSecret.length < 32) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_BFF_SECRET"],
          message:
            "In production, ADMIN_BFF_SECRET is required and must be at least 32 characters long.",
        });
        return;
      }
    }

    if (bffSecret !== undefined && bffSecret.length > 0) {
      if (
        (data.JWT_ACCESS_SECRET && bffSecret === data.JWT_ACCESS_SECRET) ||
        (data.WHATSAPP_ENCRYPTION_KEY && bffSecret === data.WHATSAPP_ENCRYPTION_KEY) ||
        (data.VEXCHAT_INTERNAL_WEBHOOK_SECRET &&
          bffSecret === data.VEXCHAT_INTERNAL_WEBHOOK_SECRET) ||
        (data.ADMIN_MFA_ENCRYPTION_KEY &&
          bffSecret === data.ADMIN_MFA_ENCRYPTION_KEY)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_BFF_SECRET"],
          message:
            "ADMIN_BFF_SECRET must be strictly isolated and distinct from JWT secrets, webhook secrets, and MFA encryption keys.",
        });
      }
    }

    if (data.PLATFORM_ADMIN_BOOTSTRAP_ENABLED && isProduction) {
      if (
        !data.PLATFORM_ADMIN_BOOTSTRAP_SECRET ||
        data.PLATFORM_ADMIN_BOOTSTRAP_SECRET.length < 32
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["PLATFORM_ADMIN_BOOTSTRAP_SECRET"],
          message:
            "When bootstrap is enabled in production, PLATFORM_ADMIN_BOOTSTRAP_SECRET must be at least 32 characters.",
        });
      }
    }
  });

export type AdminBffEnvironment = z.infer<typeof adminBffEnvSchema> & {
  ADMIN_BFF_SECRET: string;
};

export const DEFAULT_DEV_BFF_SECRET =
  "bff0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function loadAdminBffEnv(
  source: NodeJS.ProcessEnv = process.env,
): AdminBffEnvironment {
  const result = adminBffEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentConfigurationError(
      toEnvironmentIssues(result.error.issues),
    );
  }

  const isProduction =
    (result.data.NODE_ENV || process.env.NODE_ENV)?.toLowerCase() ===
    "production";

  let secret = result.data.ADMIN_BFF_SECRET;
  if (!secret) {
    if (isProduction) {
      throw new EnvironmentConfigurationError([
        {
          path: "ADMIN_BFF_SECRET",
          message:
            "In production, ADMIN_BFF_SECRET is required and cannot be omitted.",
        },
      ]);
    }
    secret = DEFAULT_DEV_BFF_SECRET;
  }

  return {
    ...result.data,
    ADMIN_BFF_SECRET: secret,
  };
}


