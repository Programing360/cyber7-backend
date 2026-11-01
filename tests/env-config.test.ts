/**
 * Phase 4 Step 1 — Campaign and Redis environment configuration tests.
 *
 * These tests are pure configuration checks and never connect to Redis.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EnvironmentConfigurationError,
  loadCampaignEnv,
  loadRedisUrl,
} from "../src/config/env.js";

const CAMPAIGN_KEYS = [
  "CAMPAIGN_EXECUTION_ENABLED",
  "CAMPAIGN_SCHEDULER_INTERVAL_MS",
  "CAMPAIGN_PAGE_SIZE",
  "CAMPAIGN_SEND_CONCURRENCY",
  "CAMPAIGN_DISPATCH_CONCURRENCY",
  "CAMPAIGN_MAX_ATTEMPTS",
  "CAMPAIGN_RETRY_DELAY_MS",
  "CAMPAIGN_LEASE_DURATION_MS",
  "CAMPAIGN_HEARTBEAT_INTERVAL_MS",
  "CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS",
] as const;

const NUMERIC_KEYS = CAMPAIGN_KEYS.filter(
  (key) => key !== "CAMPAIGN_EXECUTION_ENABLED",
);

const DEFAULT_CAMPAIGN_ENV = {
  CAMPAIGN_EXECUTION_ENABLED: false,
  CAMPAIGN_SCHEDULER_INTERVAL_MS: 15000,
  CAMPAIGN_PAGE_SIZE: 100,
  CAMPAIGN_SEND_CONCURRENCY: 5,
  CAMPAIGN_DISPATCH_CONCURRENCY: 2,
  CAMPAIGN_MAX_ATTEMPTS: 3,
  CAMPAIGN_RETRY_DELAY_MS: 5000,
  CAMPAIGN_LEASE_DURATION_MS: 60000,
  CAMPAIGN_HEARTBEAT_INTERVAL_MS: 15000,
  CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS: 30000,
};

describe("Campaign environment validation", () => {
  it("applies defaults when campaign variables are not configured", () => {
    assert.deepEqual(loadCampaignEnv({}), DEFAULT_CAMPAIGN_ENV);
  });

  it("defaults CAMPAIGN_EXECUTION_ENABLED to false", () => {
    assert.equal(loadCampaignEnv({}).CAMPAIGN_EXECUTION_ENABLED, false);
  });

  it('parses "true" as true', () => {
    assert.equal(
      loadCampaignEnv({ CAMPAIGN_EXECUTION_ENABLED: "true" })
        .CAMPAIGN_EXECUTION_ENABLED,
      true,
    );
  });

  it('parses "false" as false', () => {
    assert.equal(
      loadCampaignEnv({ CAMPAIGN_EXECUTION_ENABLED: "false" })
        .CAMPAIGN_EXECUTION_ENABLED,
      false,
    );
  });

  it("accepts boolean values and trims/cases string values", () => {
    assert.equal(
      loadCampaignEnv({ CAMPAIGN_EXECUTION_ENABLED: true })
        .CAMPAIGN_EXECUTION_ENABLED,
      true,
    );
    assert.equal(
      loadCampaignEnv({ CAMPAIGN_EXECUTION_ENABLED: " TRUE " })
        .CAMPAIGN_EXECUTION_ENABLED,
      true,
    );
    assert.equal(
      loadCampaignEnv({ CAMPAIGN_EXECUTION_ENABLED: "FALSE" })
        .CAMPAIGN_EXECUTION_ENABLED,
      false,
    );
  });

  it("rejects invalid boolean values", () => {
    assert.throws(
      () => loadCampaignEnv({ CAMPAIGN_EXECUTION_ENABLED: "yes" }),
      (error: unknown) =>
        error instanceof EnvironmentConfigurationError &&
        error.message.includes("CAMPAIGN_EXECUTION_ENABLED"),
    );
  });

  it("accepts positive integer values", () => {
    const env = loadCampaignEnv({
      CAMPAIGN_PAGE_SIZE: "250",
      CAMPAIGN_MAX_ATTEMPTS: "7",
      CAMPAIGN_LEASE_DURATION_MS: "90000",
    });

    assert.equal(env.CAMPAIGN_PAGE_SIZE, 250);
    assert.equal(env.CAMPAIGN_MAX_ATTEMPTS, 7);
    assert.equal(env.CAMPAIGN_LEASE_DURATION_MS, 90000);
  });

  it("rejects non-numeric values for every numeric variable", () => {
    for (const key of NUMERIC_KEYS) {
      assert.throws(
        () => loadCampaignEnv({ [key]: "not-a-number" }),
        (error: unknown) =>
          error instanceof EnvironmentConfigurationError &&
          error.message.includes(key),
        `${key} should reject non-numeric input`,
      );
    }
  });

  it("rejects zero for every numeric variable", () => {
    for (const key of NUMERIC_KEYS) {
      assert.throws(
        () => loadCampaignEnv({ [key]: "0" }),
        (error: unknown) =>
          error instanceof EnvironmentConfigurationError &&
          error.message.includes(key),
        `${key} should reject zero`,
      );
    }
  });

  it("rejects negative values for every numeric variable", () => {
    for (const key of NUMERIC_KEYS) {
      assert.throws(
        () => loadCampaignEnv({ [key]: "-1" }),
        (error: unknown) =>
          error instanceof EnvironmentConfigurationError &&
          error.message.includes(key),
        `${key} should reject negative input`,
      );
    }
  });

  it("rejects decimal values for every numeric variable", () => {
    for (const key of NUMERIC_KEYS) {
      assert.throws(
        () => loadCampaignEnv({ [key]: "1.5" }),
        (error: unknown) =>
          error instanceof EnvironmentConfigurationError &&
          error.message.includes(key),
        `${key} should reject decimal input`,
      );
    }
  });

  it("does not require existing API environment variables", () => {
    const env = loadCampaignEnv({
      PORT: "5000",
      NODE_ENV: "development",
      MONGODB_URI: "mongodb://127.0.0.1:27017/cyber7",
      JWT_ACCESS_SECRET: "existing-secret",
      META_APP_ID: "existing-app-id",
    });

    assert.deepEqual(env, DEFAULT_CAMPAIGN_ENV);
  });
});

describe("Redis environment validation", () => {
  it("returns a valid redis:// URL without opening a connection", () => {
    assert.equal(
      loadRedisUrl({ REDIS_URL: "redis://127.0.0.1:6379" }),
      "redis://127.0.0.1:6379",
    );
  });

  it("accepts rediss:// URLs", () => {
    assert.equal(
      loadRedisUrl({ REDIS_URL: "rediss://redis.example.com:6380" }),
      "rediss://redis.example.com:6380",
    );
  });

  it("rejects a missing REDIS_URL with a clear error", () => {
    assert.throws(
      () => loadRedisUrl({}),
      (error: unknown) =>
        error instanceof EnvironmentConfigurationError &&
        error.message.includes("REDIS_URL"),
    );
  });

  it("rejects unsupported Redis protocols without leaking credentials", () => {
    assert.throws(
      () =>
        loadRedisUrl({
          REDIS_URL: "http://redis-user:super-secret-password@localhost:6379",
        }),
      (error: unknown) =>
        error instanceof EnvironmentConfigurationError &&
        error.message.includes("redis://") &&
        !error.message.includes("super-secret-password"),
    );
  });
});
