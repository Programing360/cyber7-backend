import rateLimit from "express-rate-limit";

export const LOGIN_RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // max 5 attempts per window per IP
  message: "Too many login attempts. Please try again after 15 minutes.",
} as const;

export const REGISTER_RATE_LIMIT_CONFIG = {
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 3, // max 3 registrations per window per IP
  message:
    "Too many registration attempts from this IP address. Please try again after 5 minutes.",
} as const;

/**
 * Login Rate Limiter
 *
 * Enforces a maximum of 5 login attempts per 15-minute window per IP.
 * Protects against credential stuffing and brute-force password guessing
 * while allowing legitimate users with occasional password typos to retry.
 */
export const loginRateLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT_CONFIG.windowMs,
  limit: LOGIN_RATE_LIMIT_CONFIG.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  statusCode: 429,
  message: {
    success: false,
    message: LOGIN_RATE_LIMIT_CONFIG.message,
    code: "RATE_LIMIT_EXCEEDED",
  },
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Registration Rate Limiter
 *
 * Enforces a maximum of 3 registration attempts per 60-minute window per IP.
 * Prevents automated account creation spam, resource exhaustion, and bot registrations
 * while allowing legitimate users or small teams to register accounts.
 */
export const registerRateLimiter = rateLimit({
  windowMs: REGISTER_RATE_LIMIT_CONFIG.windowMs,
  limit: REGISTER_RATE_LIMIT_CONFIG.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  statusCode: 429,
  message: {
    success: false,
    message: REGISTER_RATE_LIMIT_CONFIG.message,
    code: "RATE_LIMIT_EXCEEDED",
  },
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});
