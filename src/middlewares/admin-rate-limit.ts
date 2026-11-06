import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";
import { getRedisConnection } from "../config/redis.js";
import { verifyMfaChallengeToken } from "../modules/admin-auth/admin-auth.service.js";

export interface RateLimitStatus {
  count: number;
  resetAt: number;
}

export interface IAdminRateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitStatus>;
  decrement(key: string): Promise<void>;
  get(key: string): Promise<RateLimitStatus | null>;
  reset(key?: string): Promise<void>;
  isAvailable(): boolean;
}

const LUA_INCR_SCRIPT = `
  local key = KEYS[1]
  local windowMs = tonumber(ARGV[1])
  local count = redis.call('INCR', key)
  if count == 1 then
    redis.call('PEXPIRE', key, windowMs)
  end
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then
    redis.call('PEXPIRE', key, windowMs)
    ttl = windowMs
  end
  return { count, ttl }
`;

const LUA_DECR_SCRIPT = `
  local key = KEYS[1]
  local count = redis.call('GET', key)
  if count and tonumber(count) > 0 then
    redis.call('DECR', key)
  end
`;

/**
 * Distributed Redis Rate Limit Store.
 * Uses atomic Lua script execution to guarantee atomic INCR and PEXPIRE
 * across multi-replica deployments without race conditions or orphaned TTL-less keys.
 */
export class RedisRateLimitStore implements IAdminRateLimitStore {
  constructor(private readonly redis: Redis) {}

  isAvailable(): boolean {
    // SEC-02: Require "ready" state only; "connect" or "reconnecting" may hang commands
    return this.redis.status === "ready";
  }

  async increment(key: string, windowMs: number): Promise<RateLimitStatus> {
    const prefixedKey = `ratelimit:admin:${key}`;
    const result = (await this.redis.eval(
      LUA_INCR_SCRIPT,
      1,
      prefixedKey,
      windowMs,
    )) as [number, number];

    const count = Number(result[0]);
    const ttlMs = Number(result[1]);

    return {
      count,
      resetAt: Date.now() + Math.max(0, ttlMs),
    };
  }

  async decrement(key: string): Promise<void> {
    const prefixedKey = `ratelimit:admin:${key}`;
    await this.redis.eval(LUA_DECR_SCRIPT, 1, prefixedKey);
  }

  async get(key: string): Promise<RateLimitStatus | null> {
    const prefixedKey = `ratelimit:admin:${key}`;
    const pipeline = this.redis.pipeline();
    pipeline.get(prefixedKey);
    pipeline.pttl(prefixedKey);

    const results = await pipeline.exec();
    if (!results) return null;

    const [getErr, val] = results[0];
    const [ttlErr, ttlResult] = results[1];

    if (getErr || !val) return null;
    const count = Number(val);
    const ttlMs = Number(ttlResult);

    if (ttlMs <= 0) return null;

    return {
      count,
      resetAt: Date.now() + ttlMs,
    };
  }

  async reset(key?: string): Promise<void> {
    if (key) {
      await this.redis.del(`ratelimit:admin:${key}`);
    } else {
      const keys = await this.redis.keys("ratelimit:admin:*");
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    }
  }
}

/**
 * In-Memory Rate Limit Store.
 * Used strictly for unit tests and local development environments.
 */
export class MemoryRateLimitStore implements IAdminRateLimitStore {
  private store = new Map<string, RateLimitStatus>();

  isAvailable(): boolean {
    return true;
  }

  incrementSync(key: string, windowMs: number): RateLimitStatus {
    const now = Date.now();
    const existing = this.store.get(key);

    if (!existing || now > existing.resetAt) {
      const record = { count: 1, resetAt: now + windowMs };
      this.store.set(key, record);
      return record;
    }

    existing.count += 1;
    return existing;
  }

  decrementSync(key: string): void {
    const existing = this.store.get(key);
    if (existing && existing.count > 0) {
      existing.count -= 1;
    }
  }

  getSync(key: string): RateLimitStatus | null {
    const now = Date.now();
    const existing = this.store.get(key);

    if (!existing || now > existing.resetAt) {
      if (existing) this.store.delete(key);
      return null;
    }

    return existing;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitStatus> {
    return this.incrementSync(key, windowMs);
  }

  async decrement(key: string): Promise<void> {
    this.decrementSync(key);
  }

  async get(key: string): Promise<RateLimitStatus | null> {
    return this.getSync(key);
  }

  async reset(key?: string): Promise<void> {
    if (key) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }
}

const defaultMemoryStore = new MemoryRateLimitStore();
let customStore: IAdminRateLimitStore | null = null;

export function setAdminRateLimitStore(store: IAdminRateLimitStore | null): void {
  customStore = store;
}

export function getAdminRateLimitStore(): IAdminRateLimitStore {
  if (customStore) {
    return customStore;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      const redis = getRedisConnection();
      return new RedisRateLimitStore(redis);
    } catch (err) {
      if (isProduction) {
        throw new Error(
          "Distributed rate limiter store unavailable in production: Redis connection failed",
        );
      }
    }
  }

  if (isProduction) {
    throw new Error(
      "REDIS_URL must be configured for distributed rate limiting in production",
    );
  }

  return defaultMemoryStore;
}

export interface AdminRateLimitOptions {
  windowMs?: number;
  maxAttempts?: number;
  maxAccountAttempts?: number;
  maxIpAttempts?: number;
  maxChallengeAttempts?: number;
  message?: string;
}

interface KeyConfig {
  key: string;
  limit: number;
  isAccount: boolean;
}

/**
 * Distributed Platform Admin Rate Limiting Middleware.
 *
 * SEC-02 Hardening:
 * 1. Synchronously pre-increments atomic counter to eliminate concurrent burst race conditions.
 * 2. Authenticates challenge tokens before extracting identity: cryptographically verified subjects
 *    bind to account-level limits; unverified challenge tokens isolate strictly to challenge hash & source IP.
 * 3. On response finish:
 *    - 2xx (Success): Resets account failure quota and rolls back IP attempt.
 *    - 400 (Schema Validation Failure): Rolls back attempt counter to prevent per-email DoS.
 *    - 401/403 (Authentication Failure): Retains increment to enforce strict threshold.
 *    - 5xx (Internal Error): Rolls back attempt counter.
 * 4. Fails closed in production with HTTP 503 if distributed store is unavailable or disconnects.
 */
export function createAdminRateLimiter(options: AdminRateLimitOptions = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const maxAccountAttempts = options.maxAccountAttempts || options.maxAttempts || 5;
  const maxChallengeAttempts = options.maxChallengeAttempts || options.maxAttempts || 5;
  const maxIpAttempts = options.maxIpAttempts || 25;
  const message =
    options.message ||
    "Too many failed administrator authentication attempts. Please try again later.";

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let store: IAdminRateLimitStore;

    try {
      store = getAdminRateLimitStore();
      if (!store.isAvailable()) {
        throw new Error("Rate limit store reported unavailable status");
      }
    } catch (err: unknown) {
      if (process.env.NODE_ENV === "production") {
        res.status(503).json({
          success: false,
          code: "RATE_LIMITER_UNAVAILABLE",
          message:
            "Distributed rate limiting service is unavailable. Sensitive administrative actions fail closed.",
        });
        return;
      }
      store = defaultMemoryStore;
    }

    const clientIp = req.ip || req.socket?.remoteAddress || "unknown_ip";
    const bodyEmail =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    const challengeToken =
      typeof req.body?.challengeToken === "string" ? req.body.challengeToken.trim() : "";

    const keysToCheck: KeyConfig[] = [];

    // 1. Password login: Normalized account key
    if (bodyEmail) {
      keysToCheck.push({
        key: `account:${bodyEmail}:${req.path}`,
        limit: maxAccountAttempts,
        isAccount: true,
      });
    }

    // 2. MFA verification: Cryptographically verify challenge token before trusting identity
    if (challengeToken) {
      let verifiedUserId: string | undefined;
      try {
        const verified = verifyMfaChallengeToken(challengeToken);
        if (verified.valid && verified.userId) {
          verifiedUserId = verified.userId.toLowerCase();
        }
      } catch {
        // Unverified token
      }

      if (verifiedUserId) {
        // Bind to verified account identity — new challenge issuance cannot bypass account limit
        keysToCheck.push({
          key: `account:${verifiedUserId}:${req.path}`,
          limit: maxAccountAttempts,
          isAccount: true,
        });
      } else {
        // Never trust identity from an unverified token; key strictly by token hash
        const challengeHash = crypto
          .createHash("sha256")
          .update(challengeToken)
          .digest("hex")
          .slice(0, 16);

        keysToCheck.push({
          key: `challenge:${challengeHash}:${req.path}`,
          limit: maxChallengeAttempts,
          isAccount: false,
        });
      }
    }

    // 3. Source IP key
    keysToCheck.push({
      key: `ip:${clientIp}:${req.path}`,
      limit: maxIpAttempts,
      isAccount: false,
    });

    const isSyncStore = typeof (store as any).getSync === "function";

    // Step A: Pre-check if any key has already exhausted quota
    if (isSyncStore) {
      for (const { key, limit } of keysToCheck) {
        const record = (store as any).getSync(key);
        if (record && record.count >= limit) {
          const now = Date.now();
          const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
          if (typeof res.setHeader === "function") {
            res.setHeader("Retry-After", retryAfterSeconds.toString());
          }
          res.status(429).json({
            success: false,
            code: "RATE_LIMIT_EXCEEDED",
            message,
            retryAfterSeconds,
          });
          return;
        }
      }
    } else {
      try {
        for (const { key, limit } of keysToCheck) {
          const record = await store.get(key);
          if (record && record.count >= limit) {
            const now = Date.now();
            const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
            if (typeof res.setHeader === "function") {
              res.setHeader("Retry-After", retryAfterSeconds.toString());
            }
            res.status(429).json({
              success: false,
              code: "RATE_LIMIT_EXCEEDED",
              message,
              retryAfterSeconds,
            });
            return;
          }
        }
      } catch (err: unknown) {
        if (process.env.NODE_ENV === "production") {
          res.status(503).json({
            success: false,
            code: "RATE_LIMITER_UNAVAILABLE",
            message:
              "Distributed rate limiting store failure. Request rejected under fail-closed policy.",
          });
          return;
        }
      }
    }

    // Step B: Atomically increment all keys to prevent concurrent burst bypass
    let burstBlocked = false;
    let burstRetryAfter = 60;

    if (isSyncStore) {
      for (const { key, limit } of keysToCheck) {
        const status = (store as any).incrementSync(key, windowMs);
        if (status.count > limit) {
          burstBlocked = true;
          burstRetryAfter = Math.max(1, Math.ceil((status.resetAt - Date.now()) / 1000));
        }
      }
    } else {
      try {
        for (const { key, limit } of keysToCheck) {
          const status = await store.increment(key, windowMs);
          if (status.count > limit) {
            burstBlocked = true;
            burstRetryAfter = Math.max(1, Math.ceil((status.resetAt - Date.now()) / 1000));
          }
        }
      } catch (err: unknown) {
        if (process.env.NODE_ENV === "production") {
          res.status(503).json({
            success: false,
            code: "RATE_LIMITER_UNAVAILABLE",
            message:
              "Distributed rate limiting store failure. Request rejected under fail-closed policy.",
          });
          return;
        }
      }
    }

    if (burstBlocked) {
      if (typeof res.setHeader === "function") {
        res.setHeader("Retry-After", burstRetryAfter.toString());
      }
      res.status(429).json({
        success: false,
        code: "RATE_LIMIT_EXCEEDED",
        message,
        retryAfterSeconds: burstRetryAfter,
      });
      return;
    }

    // Step C: Hook into response completion
    if (typeof res.on === "function") {
      res.on("finish", async () => {
        try {
          const status = res.statusCode;

          if (status >= 200 && status < 300) {
            // Success: reset account failure quota and decrement IP attempt
            for (const { key, isAccount } of keysToCheck) {
              if (isAccount) {
                await store.reset(key);
              } else {
                await store.decrement(key);
              }
            }
          } else if (status === 400 || status >= 500) {
            // Schema validation failure (400) or internal server error (500):
            // Roll back attempt counters so malformed payloads cannot DoS accounts or IP
            for (const { key } of keysToCheck) {
              await store.decrement(key);
            }
          }
          // On status 401 or 403 (authentication failure): count is retained!
        } catch {
          // Ignore finish cleanup errors
        }
      });
    }

    next();
  };
}

export async function resetAdminRateLimits(): Promise<void> {
  const store = getAdminRateLimitStore();
  await store.reset();
}
