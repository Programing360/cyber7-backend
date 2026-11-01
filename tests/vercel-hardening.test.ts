import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, mock } from "node:test";
import mongoose from "mongoose";

import { initializeApi } from "../api/index.js";
import connectDatabase from "../src/config/database.js";

const originalMongoUri = process.env.MONGODB_URI;

afterEach(() => {
  mock.restoreAll();
  mongoose.connection.removeAllListeners("disconnected");

  if (originalMongoUri === undefined) {
    delete process.env.MONGODB_URI;
  } else {
    process.env.MONGODB_URI = originalMongoUri;
  }
});

describe("Vercel API initialization", () => {
  it("validates the campaign environment before connecting to MongoDB", async () => {
    const calls: string[] = [];

    await initializeApi(
      () => {
        calls.push("environment");
      },
      async () => {
        calls.push("database");
      },
    );

    assert.deepEqual(calls, ["environment", "database"]);
  });

  it("does not connect to MongoDB when environment validation fails", async () => {
    const calls: string[] = [];

    await assert.rejects(
      initializeApi(
        () => {
          calls.push("environment");
          throw new Error("invalid environment");
        },
        async () => {
          calls.push("database");
        },
      ),
      /invalid environment/,
    );

    assert.deepEqual(calls, ["environment"]);
  });

  it("keeps the Vercel entry independent of Redis, BullMQ and workers", () => {
    const source = readFileSync(
      new URL("../api/index.ts", import.meta.url),
      "utf8",
    );
    const imports = Array.from(
      source.matchAll(/from\s+["']([^"']+)["']/g),
      (match) => match[1],
    );

    assert.deepEqual(
      new Set(imports),
      new Set([
        "../src/app.js",
        "../src/config/database.js",
        "../src/config/env.js",
      ]),
    );
    assert.doesNotMatch(source, /app\.listen\s*\(/);
  });
});

describe("MongoDB connection reuse", () => {
  it("reuses the in-flight and resolved connection for concurrent requests", async () => {
    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/vercel-connection-reuse";

    let resolveConnect: ((value: typeof mongoose) => void) | undefined;
    const connectMock = mock.method(
      mongoose,
      "connect",
      () =>
        new Promise<typeof mongoose>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const first = connectDatabase();
    const second = connectDatabase();

    assert.equal(connectMock.mock.callCount(), 1);
    assert.ok(resolveConnect);

    resolveConnect(mongoose);
    await Promise.all([first, second]);
    await connectDatabase();

    assert.equal(connectMock.mock.callCount(), 1);
  });

  it("clears a rejected connection promise so a later request can retry", async () => {
    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/vercel-connection-retry";

    let attempts = 0;
    const connectMock = mock.method(mongoose, "connect", async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("temporary connection failure");
      }

      return mongoose;
    });

    await assert.rejects(connectDatabase(), /temporary connection failure/);
    await connectDatabase();

    assert.equal(connectMock.mock.callCount(), 2);
  });

  it("does not let an older same-URI failure clear a newer promise", async () => {
    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/vercel-stale-failure";

    const pending: Array<{
      resolve: (value: typeof mongoose) => void;
      reject: (error: Error) => void;
    }> = [];
    const connectMock = mock.method(
      mongoose,
      "connect",
      () =>
        new Promise<typeof mongoose>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );

    const first = connectDatabase();
    const firstRejection = assert.rejects(first, /old connection failure/);

    mongoose.connection.emit("disconnected");

    const second = connectDatabase();
    assert.equal(connectMock.mock.callCount(), 2);

    pending[0].reject(new Error("old connection failure"));
    await firstRejection;

    const third = connectDatabase();
    assert.equal(connectMock.mock.callCount(), 2);

    pending[1].resolve(mongoose);
    await Promise.all([second, third]);
  });

  it("does not let a stale disconnect event clear a newer cache entry", async () => {
    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/vercel-stale-disconnect-a";

    const pending: Array<{
      resolve: (value: typeof mongoose) => void;
    }> = [];
    const connectMock = mock.method(
      mongoose,
      "connect",
      () =>
        new Promise<typeof mongoose>((resolve) => {
          pending.push({ resolve });
        }),
    );

    const first = connectDatabase();
    const staleDisconnected = mongoose.connection
      .listeners("disconnected")
      .at(-1) as (() => void) | undefined;
    assert.ok(staleDisconnected);

    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/vercel-stale-disconnect-b";
    const second = connectDatabase();
    assert.equal(connectMock.mock.callCount(), 2);

    staleDisconnected();
    const third = connectDatabase();
    assert.equal(connectMock.mock.callCount(), 2);

    pending[1].resolve(mongoose);
    await Promise.all([second, third]);

    pending[0].resolve(mongoose);
    await first;
  });

  it("reconnects after the current connection disconnects", async () => {
    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/vercel-connection-reconnect";

    const connectMock = mock.method(mongoose, "connect", async () => mongoose);

    await connectDatabase();
    assert.equal(connectMock.mock.callCount(), 1);

    mongoose.connection.emit("disconnected");
    await connectDatabase();

    assert.equal(connectMock.mock.callCount(), 2);
  });

  it("rejects when MONGODB_URI is missing", async () => {
    delete process.env.MONGODB_URI;

    await assert.rejects(connectDatabase(), /MONGODB_URI is missing/);
  });
});
