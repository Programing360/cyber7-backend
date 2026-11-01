import { Redis } from "ioredis";

import { loadRedisUrl } from "./env.js";

let redisConnection: Redis | null = null;

function logRedisError(error: Error): void {
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "unknown";

  console.error(`[Redis] Connection error (${code})`);
}

export function getRedisConnection(): Redis {
  if (redisConnection) {
    return redisConnection;
  }

  const redisUrl = loadRedisUrl();

  console.log("[Redis] Initializing connection");

  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  connection.on("connect", () => {
    console.log("[Redis] Connecting");
  });

  connection.on("ready", () => {
    console.log("[Redis] Connection ready");
  });

  connection.on("close", () => {
    console.log("[Redis] Connection closed");
  });

  connection.on("reconnecting", () => {
    console.log("[Redis] Reconnecting");
  });

  connection.on("end", () => {
    console.log("[Redis] Connection ended");
  });

  connection.on("error", logRedisError);

  redisConnection = connection;

  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  const connection = redisConnection;

  if (!connection) {
    return;
  }

  redisConnection = null;

  try {
    if (connection.status !== "end") {
      await connection.quit();
    }
  } catch (error) {
    logRedisError(error instanceof Error ? error : new Error("Unknown error"));
    connection.disconnect();
  }
}
