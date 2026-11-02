import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response, NextFunction } from "express";

import app from "../src/app.js";
import {
  LOGIN_RATE_LIMIT_CONFIG,
  REGISTER_RATE_LIMIT_CONFIG,
  loginRateLimiter,
  registerRateLimiter,
} from "../src/middlewares/rate-limiter.js";

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      res.headers["content-type"] = "application/json";
      return res;
    },
    send(data: any) {
      res.body = data;
      return res;
    },
    setHeader(name: string, value: any) {
      res.headers[name.toLowerCase()] = String(value);
      return res;
    },
    getHeader(name: string) {
      return res.headers[name.toLowerCase()];
    },
  };
  return res;
}

function createMockRequest(options: {
  ip: string;
  forwardedFor?: string;
}) {
  const req: any = {
    ip: options.ip,
    headers: {},
    socket: {
      remoteAddress: "127.0.0.1",
    },
    app: {
      get: (key: string) => {
        if (key === "trust proxy") return 1;
        return undefined;
      },
    },
  };

  if (options.forwardedFor) {
    req.headers["x-forwarded-for"] = options.forwardedFor;
  }

  return req as Request;
}

async function runMiddleware(
  limiter: typeof loginRateLimiter,
  req: any,
  res: any,
): Promise<{ nextCalled: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    let nextCalled = false;
    const next: NextFunction = (err?: any) => {
      nextCalled = true;
      resolve({ nextCalled: true, error: err });
    };

    try {
      limiter(req, res, next);
      setTimeout(() => {
        if (!nextCalled) {
          resolve({ nextCalled: false });
        }
      }, 10);
    } catch (error) {
      resolve({ nextCalled: false, error });
    }
  });
}

describe("Authentication Rate Limiting", () => {
  describe("Configuration & Environment", () => {
    it("exposes configured thresholds matching security specifications", () => {
      assert.equal(LOGIN_RATE_LIMIT_CONFIG.limit, 5);
      assert.equal(LOGIN_RATE_LIMIT_CONFIG.windowMs, 15 * 60 * 1000);
      assert.equal(REGISTER_RATE_LIMIT_CONFIG.limit, 3);
      assert.equal(REGISTER_RATE_LIMIT_CONFIG.windowMs, 60 * 60 * 1000);
    });

    it("has trust proxy configured as 1 on Express app", () => {
      assert.equal(app.get("trust proxy"), 1);
    });
  });

  describe("Login Rate Limiter (5 requests / 15 minutes)", () => {
    const testIp = "198.51.100.10";

    it("allows requests up to the 5-attempt limit and calls next() while decrementing remaining count", async () => {
      for (let i = 1; i <= 5; i++) {
        const req = createMockRequest({ ip: testIp });
        const res = createMockResponse();

        const result = await runMiddleware(loginRateLimiter, req, res);

        assert.equal(result.nextCalled, true, `Attempt ${i} should call next()`);
        assert.equal(res.statusCode, 200);

        // Verify draft-7 RateLimit header
        const rateLimitHeader = res.getHeader("ratelimit");
        assert.ok(rateLimitHeader, "RateLimit header should be present");
        assert.match(rateLimitHeader, /limit=5/);
        assert.match(
          rateLimitHeader,
          new RegExp(`remaining=${5 - i}`),
          `Remaining should be ${5 - i} on attempt ${i}`,
        );

        // Verify legacy X-RateLimit headers are disabled
        assert.equal(res.getHeader("x-ratelimit-limit"), undefined);
        assert.equal(res.getHeader("x-ratelimit-remaining"), undefined);
      }
    });

    it("blocks the 6th login request with HTTP 429 and structured error payload", async () => {
      const req = createMockRequest({ ip: testIp });
      const res = createMockResponse();

      const result = await runMiddleware(loginRateLimiter, req, res);

      assert.equal(result.nextCalled, false, "6th attempt must not call next()");
      assert.equal(res.statusCode, 429);

      // Verify Retry-After header
      const retryAfter = res.getHeader("retry-after");
      assert.ok(retryAfter, "Retry-After header must be set");
      assert.ok(Number(retryAfter) > 0, "Retry-After must be positive");

      // Verify response body
      assert.deepEqual(res.body, {
        success: false,
        message: LOGIN_RATE_LIMIT_CONFIG.message,
        code: "RATE_LIMIT_EXCEEDED",
      });

      // Verify no internal error / debug info disclosure
      assert.equal(res.body.debug, undefined);
      assert.equal(res.body.stack, undefined);
    });

    it("allows requests again after key reset", async () => {
      loginRateLimiter.resetKey(testIp);

      const req = createMockRequest({ ip: testIp });
      const res = createMockResponse();
      const result = await runMiddleware(loginRateLimiter, req, res);

      assert.equal(result.nextCalled, true, "Request should be permitted after reset");
      assert.equal(res.statusCode, 200);
    });
  });

  describe("Registration Rate Limiter (3 requests / 60 minutes)", () => {
    const testIp = "198.51.100.20";

    it("allows registration requests up to the 3-attempt limit", async () => {
      for (let i = 1; i <= 3; i++) {
        const req = createMockRequest({ ip: testIp });
        const res = createMockResponse();

        const result = await runMiddleware(registerRateLimiter, req, res);

        assert.equal(result.nextCalled, true, `Attempt ${i} should call next()`);
        assert.equal(res.statusCode, 200);

        const rateLimitHeader = res.getHeader("ratelimit");
        assert.ok(rateLimitHeader);
        assert.match(rateLimitHeader, /limit=3/);
      }
    });

    it("blocks the 4th registration request with HTTP 429 and structured error payload", async () => {
      const req = createMockRequest({ ip: testIp });
      const res = createMockResponse();

      const result = await runMiddleware(registerRateLimiter, req, res);

      assert.equal(result.nextCalled, false, "4th attempt must not call next()");
      assert.equal(res.statusCode, 429);

      const retryAfter = res.getHeader("retry-after");
      assert.ok(retryAfter, "Retry-After header must be set");

      assert.deepEqual(res.body, {
        success: false,
        message: REGISTER_RATE_LIMIT_CONFIG.message,
        code: "RATE_LIMIT_EXCEEDED",
      });
    });

    it("allows registration again after key reset", async () => {
      registerRateLimiter.resetKey(testIp);

      const req = createMockRequest({ ip: testIp });
      const res = createMockResponse();
      const result = await runMiddleware(registerRateLimiter, req, res);

      assert.equal(result.nextCalled, true, "Request should be permitted after reset");
      assert.equal(res.statusCode, 200);
    });
  });

  describe("Limiter Isolation & Independent Counters", () => {
    const dualIp = "198.51.100.30";

    it("exhausting login limit does not affect registration for the same IP", async () => {
      // Exhaust login attempts for dualIp (5 attempts)
      for (let i = 1; i <= 5; i++) {
        const req = createMockRequest({ ip: dualIp });
        const res = createMockResponse();
        await runMiddleware(loginRateLimiter, req, res);
      }

      // 6th login attempt is blocked
      const loginReq = createMockRequest({ ip: dualIp });
      const loginRes = createMockResponse();
      const loginResult = await runMiddleware(loginRateLimiter, loginReq, loginRes);
      assert.equal(loginResult.nextCalled, false);
      assert.equal(loginRes.statusCode, 429);

      // Registration for the same IP should still succeed (calls next)
      const regReq = createMockRequest({ ip: dualIp });
      const regRes = createMockResponse();
      const regResult = await runMiddleware(registerRateLimiter, regReq, regRes);
      assert.equal(regResult.nextCalled, true, "Registration must still be allowed");
      assert.equal(regRes.statusCode, 200);
    });

    it("different IP addresses have isolated counter buckets", async () => {
      const ipA = "198.51.100.40";
      const ipB = "198.51.100.41";

      // Exhaust login attempts for ipA
      for (let i = 1; i <= 5; i++) {
        const req = createMockRequest({ ip: ipA });
        const res = createMockResponse();
        await runMiddleware(loginRateLimiter, req, res);
      }

      // ipA is blocked
      const reqA = createMockRequest({ ip: ipA });
      const resA = createMockResponse();
      const resultA = await runMiddleware(loginRateLimiter, reqA, resA);
      assert.equal(resultA.nextCalled, false);
      assert.equal(resA.statusCode, 429);

      // ipB is allowed
      const reqB = createMockRequest({ ip: ipB });
      const resB = createMockResponse();
      const resultB = await runMiddleware(loginRateLimiter, reqB, resB);
      assert.equal(resultB.nextCalled, true, "Independent IP B should be allowed");
      assert.equal(resB.statusCode, 200);
    });
  });

  describe("Vercel Proxy IP Resolution (trust proxy: 1)", () => {
    it("express computes req.ip from the last X-Forwarded-For hop when trust proxy is 1", () => {
      const req = Object.create(app.request);
      req.app = app;
      req.headers = {
        "x-forwarded-for": "10.0.0.1, 172.16.0.1, 198.51.100.55",
      };
      req.socket = {
        remoteAddress: "127.0.0.1",
      };

      // With trust proxy: 1, Express trusts 1 hop from the right (198.51.100.55)
      // and does not trust client-controlled prefixes (10.0.0.1, 172.16.0.1)
      assert.equal(req.ip, "198.51.100.55");
    });

    it("prevents IP spoofing via chained X-Forwarded-For headers", async () => {
      const realClientIp = "198.51.100.60";

      // An attacker sends various fake IPs in X-Forwarded-For, but Vercel edge appends the real IP
      for (let i = 1; i <= 5; i++) {
        const req = Object.create(app.request);
        req.app = app;
        req.headers = {
          "x-forwarded-for": `10.0.0.${i}, ${realClientIp}`,
        };
        req.socket = { remoteAddress: "127.0.0.1" };

        const res = createMockResponse();
        const result = await runMiddleware(loginRateLimiter, req, res);
        assert.equal(result.nextCalled, true);
      }

      // 6th attempt with yet another spoofed IP still maps to realClientIp and is blocked
      const attackReq = Object.create(app.request);
      attackReq.app = app;
      attackReq.headers = {
        "x-forwarded-for": `192.168.1.99, ${realClientIp}`,
      };
      attackReq.socket = { remoteAddress: "127.0.0.1" };

      const attackRes = createMockResponse();
      const attackResult = await runMiddleware(loginRateLimiter, attackReq, attackRes);

      assert.equal(attackResult.nextCalled, false, "Spoofed attempt must be blocked");
      assert.equal(attackRes.statusCode, 429);
      assert.equal(attackRes.body.code, "RATE_LIMIT_EXCEEDED");
    });
  });
});
