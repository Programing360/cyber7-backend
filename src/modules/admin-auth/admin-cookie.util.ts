export interface AdminCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict";
  path: "/";
  domain?: undefined;
  expires: Date;
  maxAge: number;
}

export function validateAdminCookieName(
  cookieName: string,
  isProduction: boolean = process.env.NODE_ENV === "production",
): boolean {
  if (typeof cookieName !== "string" || cookieName.trim().length === 0) {
    return false;
  }
  // শুধুমাত্র প্রোডাকশনে সিকিউর প্রিফিক্স বাধ্যতামূলক, লোকালে সাধারণ নাম প্রযোজ্য
  if (isProduction && !cookieName.startsWith("__Host-")) {
    return false;
  }
  return true;
}

export function buildAdminCookieOptions(
  absoluteExpiresAt: Date,
  idleExpiresAt?: Date,
  isProduction: boolean = process.env.NODE_ENV === "production",
  sameSite: "lax" | "strict" = "lax", // লোকাল ও এসএসআর নেভিগেশনের জন্য 'lax' নিরাপদ ও ড্রপ-মুক্ত
): AdminCookieOptions {
  const now = Date.now();

  const targetExpiry = idleExpiresAt
    ? new Date(Math.min(idleExpiresAt.getTime(), absoluteExpiresAt.getTime()))
    : absoluteExpiresAt;

  const maxAgeMs = Math.max(0, targetExpiry.getTime() - now);

  return {
    httpOnly: true,
    secure: isProduction, // লোকালে (development) এটি বাধ্যতামূলক false হবে
    sameSite,
    path: "/",
    domain: undefined,
    expires: targetExpiry,
    maxAge: maxAgeMs,
  };
}

export function parseCookieHeader(
  cookieHeader?: string | null,
): Record<string, string> {
  if (!cookieHeader || typeof cookieHeader !== "string") {
    return {};
  }

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i].trim();
    if (!pair) continue;

    const equalIndex = pair.indexOf("=");
    if (equalIndex > 0) {
      const key = pair.slice(0, equalIndex).trim();
      const rawVal = pair.slice(equalIndex + 1).trim();

      try {
        cookies[key] = decodeURIComponent(rawVal);
      } catch {
        cookies[key] = rawVal;
      }
    }
  }

  return cookies;
}

export function clearAdminCookieOptions(
  isProduction: boolean = process.env.NODE_ENV === "production",
): AdminCookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    domain: undefined,
    expires: new Date(0),
    maxAge: 0,
  };
}
